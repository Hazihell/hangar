#!/bin/bash
# A single launchd job loops: top samples the same 10 s interval used for reporting.
parse_cpu() {
  awk '/CPU usage:/ { for (i=1;i<=NF;i++) if ($i == "idle") { idle=$(i-1); sub(/%/, "", idle); value=100-idle; found=1 } } END { if (found) printf "%.2f\n", value; else exit 1 }'
}
parse_ram() {
  awk '
    NR==1 { for(i=1;i<=NF;i++) if ($i=="of") size=$(i+1) }
    /Anonymous pages:/ { anon=$NF; a=1 }
    /Pages purgeable:/ { purge=$NF; p=1 }
    /Pages wired down:/ { wired=$NF; w=1 }
    /Pages occupied by compressor:/ { compressed=$NF; c=1 }
    END { if (!(size>0 && a && p && w && c)) exit 1; printf "%.0f\n", (anon-purge+wired+compressed)*size }'
}
parse_disk() {
  awk 'NR==2 && $2>0 { printf "%.0f %.0f\n", ($2-$4)*1024, $2*1024; found=1 } END { if (!found) exit 1 }'
}
parse_vpns() {
  awk '
    function json(s, out, i, c) {
      out=""
      for (i=1; i<=length(s); i++) {
        c=substr(s,i,1)
        if (c=="\\") out=out "\\\\"
        else if (c=="\"") out=out "\\\""
        else if (c in controls) out=out controls[c]
        else out=out c
      }
      return out
    }
    BEGIN {
      for (i=1;i<32;i++) controls[sprintf("%c",i)]=sprintf("\\u%04x",i)
      printf "["
    }
    /\(/ && /"/ && /\[[^]]*\][[:space:]]*$/ {
      line=$0
      type=line; sub(/^.*\[/,"",type); sub(/\][[:space:]]*$/,"",type)
      name=line; sub(/^[^"]*"/,"",name); sub(/"[^"]*$/,"",name)
      if (tolower(name) ~ /tailscale/ || tolower(type) ~ /tailscale/) next
      status=line; sub(/^[^(]*\(/,"",status); sub(/\).*$/,"",status)
      status=tolower(status)
      if (status!="connected" && status!="disconnected" && status!="connecting" && status!="disconnecting") status="disconnected"
      kind=(type ~ /^PPP/ ? "ppp" : "other")
      printf "%s{\"name\":\"%s\",\"status\":\"%s\",\"kind\":\"%s\"}", separator,json(name),status,kind
      separator=","
    }
    END { print "]" }'
}
# ps %cpu is expressed per core; normalize it to the whole Machine.
# lstart occupies five fields; everything after it is the executable path.
parse_processes() {
  LC_ALL=C sort -k4,4nr | HANGAR_PROCESS_TREE="$4" LC_ALL=C awk -v uid="$1" -v cores="$2" -v reporter="$3" '
    function json(s, out, i, c) {
      out=""
      for (i=1;i<=length(s);i++) {
        c=substr(s,i,1)
        if (c=="\\") out=out "\\\\"
        else if (c=="\"") out=out "\\\""
        else if (c in controls) out=out controls[c]
        else out=out c
      }
      return out
    }
    BEGIN {
      if (cores !~ /^[0-9]+$/ || cores<1) exit 1
      for (i=1;i<32;i++) controls[sprintf("%c",i)]=sprintf("\\u%04x",i)
      controls[sprintf("%c",127)]="\\u007f"
      # LC_ALL=C sees UTF-8 bytes. Remove only complete C1 sequences;
      # deleting continuation bytes would corrupt names such as café.
      c1=sprintf("%c",194) "[" sprintf("%c",128) "-" sprintf("%c",159) "]"
      # reporter PID is only a hint: verify the command before protecting it.
      n=split(ENVIRON["HANGAR_PROCESS_TREE"], rows, "\n")
      for(i=1;i<=n;i++) { sub(/^[[:space:]]+/, "", rows[i]); split(rows[i], pair, /[[:space:]]+/); parents[pair[1]]=pair[2]; if(rows[i] ~ /\/mac-reporter[.]sh([[:space:]]|$)/) protected[pair[1]]=1 }
      do {
        changed=0
        for(pid in parents) if(!protected[pid] && protected[parents[pid]]) { protected[pid]=1; changed=1 }
      } while(changed)
      printf "["
    }
    NF>=10 && $1 ~ /^[0-9]+$/ && $2 ~ /^[0-9]+$/ && $3 ~ /^[0-9]+([.][0-9]+)?$/ && $4 ~ /^[0-9]+$/ {
      pid=$1; owner=$2; cpu=$3/cores; ram=$4*1024
      if(cpu>100) cpu=100
      started=$5 " " $6 " " $7 " " $8 " " $9
      path=$0
      for(i=1;i<=9;i++) sub(/^[[:space:]]*[^[:space:]]+[[:space:]]*/, "", path)
      gsub(/[[:cntrl:]]/, "", path)
      gsub(c1, "", path)
      name=path; sub(/^.*\//, "", name)
      app=name; sub(/[.][eE][xX][eE]$/, "", app)
      if(match(path, /(^|\/)[^\/]+[.]app(\/|$)/)) {
        app=substr(path,RSTART,RLENGTH); sub(/^\//,"",app); sub(/\/$/,"",app); sub(/[.]app$/,"",app)
      }
      count++; scores[count]=cpu
      records[count]=sprintf("{\"pid\":%.0f,\"name\":\"%s\",\"app\":\"%s\",\"cpu\":%.4f,\"ram\":%.0f,\"started\":\"%s\",\"own\":%s}", pid,json(name),json(app),cpu,ram,json(started),(owner==uid && !protected[pid] ? "true" : "false"))
    }
    END {
      if(cores !~ /^[0-9]+$/ || cores<1) exit 1
      for(i=1;i<=count && i<=300;i++) keep[i]=1
      for(k=1;k<=100 && k<=count;k++) {
        best=0
        for(i=1;i<=count;i++) if(!cpuPicked[i] && (!best || scores[i]>scores[best])) best=i
        cpuPicked[best]=1; keep[best]=1
      }
      for(i=1;i<=count;i++) if(keep[i]) { printf "%s%s", sep,records[i]; sep="," }
      print "]"
    }'
}
report_once() {
  local cpu used total disk disk_used disk_total machine error vpns vpn_field='' process_field='' processes tree cores collector_uid status=0
  cpu=$(top -l 2 -n 0 -s 10 | parse_cpu) || return
  used=$(vm_stat | parse_ram) || return
  total=$(sysctl -n hw.memsize) || return
  disk=$(df -k / | parse_disk) || return
  read -r disk_used disk_total <<< "$disk"
  machine=${HANGAR_MACHINE:-rogers-macbook-air}
  # IDs are configuration, but still escape them before putting them in JSON.
  machine=$(printf '%s' "$machine" | sed 's/\\/\\\\/g; s/"/\\"/g' | tr -d '\000-\037')
  if vpns=$(scutil --nc list 2>/dev/null); then
    vpns=$(printf '%s\n' "$vpns" | parse_vpns)
    vpn_field=",\"vpns\":$vpns"
  fi
  # Fail closed for Quit if ancestry cannot be collected. Keep the prior list
  # when any collection command fails instead of reporting an empty snapshot.
  if processes=$(LC_ALL=C ps -axo pid=,uid=,%cpu=,rss=,lstart=,comm= 2>/dev/null) &&
     tree=$(LC_ALL=C ps -axo pid=,ppid=,command= 2>/dev/null) &&
     cores=$(sysctl -n hw.logicalcpu) && collector_uid=$(id -u) &&
     processes=$(printf '%s\n' "$processes" | parse_processes "$collector_uid" "$cores" "$$" "$tree"); then
    process_field=",\"processes\":$processes,\"reporterPid\":$$"
  fi
  error=$(curl -fsS -o /dev/null -w '%{http_code}' --connect-timeout 3 --max-time 5 -H 'Content-Type: application/json' \
    -d "{\"machine\":\"$machine\",\"cpu\":$cpu,\"ram\":{\"used\":$used,\"total\":$total},\"disks\":[{\"name\":\"Macintosh HD\",\"used\":$disk_used,\"total\":$disk_total}]$vpn_field$process_field}" \
    "${HANGAR_DASHBOARD_URL:-https://stormtrooper-linux.taila332e5.ts.net/api/report}" 2>&1) || status=$?
  [ "$status" = 0 ] && [[ "$error" == 2[0-9][0-9] ]] || { printf 'Reporter: %s\n' "$(printf '%s' "$error" | tr '\r\n' '  ')" >&2; return 1; }
}
if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  while true; do report_once || sleep 10; done
fi
