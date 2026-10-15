#!/bin/sh
input=$(cat)

# Single jq pass — fields joined by unit separator (a non-whitespace IFS char, so
# empty fields are preserved rather than collapsed the way tabs would be)
IFS=$(printf '\037') read -r cwd model effort ctx_input ctx_cw ctx_cr ctx_size used_pct session_pct session_resets weekly_pct weekly_resets <<EOF
$(printf '%s' "$input" | jq -r '[
  (.workspace.current_dir // .cwd // ""),
  (.model.display_name // ""),
  (.effort.level // ""),
  (.context_window.current_usage.input_tokens // ""),
  (.context_window.current_usage.cache_creation_input_tokens // 0),
  (.context_window.current_usage.cache_read_input_tokens // 0),
  (.context_window.context_window_size // ""),
  (.context_window.used_percentage // ""),
  (.rate_limits.five_hour.used_percentage // ""),
  (.rate_limits.five_hour.resets_at // ""),
  (.rate_limits.seven_day.used_percentage // ""),
  (.rate_limits.seven_day.resets_at // "")
] | map(tostring) | join("")')
EOF

short_cwd="${cwd/#$HOME/~}"

branch=""
if git -C "$cwd" rev-parse --git-dir >/dev/null 2>&1; then
  branch=$(git -C "$cwd" -c core.hooksPath=/dev/null symbolic-ref --short HEAD 2>/dev/null)
fi

# Color escape based on pct — used for the rate-limit gauges
bar_color() {
  if [ "$1" -ge 80 ]; then printf '\033[31m'
  elif [ "$1" -ge 50 ]; then printf '\033[33m'
  else printf '\033[32m'
  fi
}

# Context has its own budget, in absolute tokens: comfortable under 110k,
# tolerable to 180k, too much beyond that — regardless of window size.
ctx_color() {
  if [ "$1" -ge 180000 ]; then printf '\033[31m'
  elif [ "$1" -ge 110000 ]; then printf '\033[33m'
  else printf '\033[32m'
  fi
}

# Compact reset time: 45m / 3h20m / 5d2h
format_reset() {
  [ -z "$1" ] && return
  _diff=$(( $1 - $(date +%s) ))
  if [ "$_diff" -le 0 ]; then printf 'resetting'
  elif [ "$_diff" -lt 3600 ]; then printf '%dm' $(( _diff / 60 ))
  elif [ "$_diff" -lt 86400 ]; then printf '%dh%dm' $(( _diff / 3600 )) $(( (_diff % 3600) / 60 ))
  else
    _d=$(( _diff / 86400 )); _h=$(( (_diff % 86400) / 3600 ))
    if [ "$_h" -eq 0 ]; then printf '%dd' "$_d"; else printf '%dd%dh' "$_d" "$_h"; fi
  fi
}

sep="$(printf '\033[90m·\033[0m')"

# ── Line 1: directory + git branch ───────────────────────────────────────────
line1="$(printf '\033[34m%s\033[0m' "$short_cwd")"
[ -n "$branch" ] && line1="${line1} $(printf '\033[35m(%s)\033[0m' "$branch")"

# ── Line 2: model · ctx · 5h · 7d ────────────────────────────────────────────
line2=""
add() { [ -n "$line2" ] && line2="${line2} ${sep} $1" || line2="$1"; }

if [ -n "$model" ]; then
  if [ -n "$effort" ]; then
    add "$(printf '\033[36m%s\033[0m \033[90m[%s]\033[0m' "$model" "$effort")"
  else
    add "$(printf '\033[36m%s\033[0m' "$model")"
  fi
fi

if [ -n "$ctx_input" ] && [ -n "$ctx_size" ] && [ "$ctx_size" -gt 0 ] 2>/dev/null; then
  ctx_total=$(( ctx_input + ctx_cw + ctx_cr ))
  pct=$(( ctx_total * 100 / ctx_size ))
  [ "$pct" -gt 100 ] && pct=100
  add "$(printf '\033[90mctx\033[0m '"$(ctx_color "$ctx_total")"'%dk\033[0m\033[90m/%dk\033[0m' \
    $(( ctx_total / 1000 )) $(( ctx_size / 1000 )))"
elif [ -n "$used_pct" ]; then
  pct=$(printf '%.0f' "$used_pct")
  # No token counts available — approximate against a 200k window
  add "$(printf '\033[90mctx\033[0m '"$(ctx_color "$(( pct * 2000 ))")"'%s%%\033[0m' "$pct")"
fi

if [ -n "$session_pct" ]; then
  pct=$(printf '%.0f' "$session_pct")
  r=$(format_reset "$session_resets")
  add "$(printf '\033[90m5h\033[0m '"$(bar_color "$pct")"'%s%%\033[0m%s' \
    "$pct" "$([ -n "$r" ] && printf ' \033[90m(%s)\033[0m' "$r")")"
fi

if [ -n "$weekly_pct" ]; then
  pct=$(printf '%.0f' "$weekly_pct")
  r=$(format_reset "$weekly_resets")
  add "$(printf '\033[90m7d\033[0m '"$(bar_color "$pct")"'%s%%\033[0m%s' \
    "$pct" "$([ -n "$r" ] && printf ' \033[90m(%s)\033[0m' "$r")")"
fi

printf '%b\n' "$line1"
[ -n "$line2" ] && printf '%b\n' "$line2"
