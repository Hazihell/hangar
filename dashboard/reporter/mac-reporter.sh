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
report_once() {
  local cpu used total disk disk_used disk_total machine error vpns vpn_field='' status=0
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
  error=$(curl -fsS -o /dev/null -w '%{http_code}' --connect-timeout 3 --max-time 5 -H 'Content-Type: application/json' \
    -d "{\"machine\":\"$machine\",\"cpu\":$cpu,\"ram\":{\"used\":$used,\"total\":$total},\"disks\":[{\"name\":\"Macintosh HD\",\"used\":$disk_used,\"total\":$disk_total}]$vpn_field}" \
    "${HANGAR_DASHBOARD_URL:-https://stormtrooper-linux.taila332e5.ts.net/api/report}" 2>&1) || status=$?
  [ "$status" = 0 ] && [[ "$error" == 2[0-9][0-9] ]] || { printf 'Reporter: %s\n' "$(printf '%s' "$error" | tr '\r\n' '  ')" >&2; return 1; }
}
if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  while true; do report_once || sleep 10; done
fi
