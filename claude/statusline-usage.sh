#!/bin/bash
# Claude Code status line. It prints the model and the plan limits, and it saves
# rate_limits to a cache file for the Herdr "usage" panel (~/.config/herdr-app/mods/usage).
# Each account (CLAUDE_CONFIG_DIR, see ~/.local/bin/agent-account) has its own file:
# claude.json for the default login, claude-<first 8 hex of the folder's SHA-256>.json otherwise.
input=$(cat)

cache_dir="$HOME/.cache/agent-usage"
cache_file="$cache_dir/claude.json"
[ -n "${CLAUDE_CONFIG_DIR:-}" ] && cache_file="$cache_dir/claude-$(printf '%s' "$CLAUDE_CONFIG_DIR" | shasum -a 256 | cut -c1-8).json"
limits=$(printf '%s' "$input" | jq -c '.rate_limits // empty' 2>/dev/null)
# Every open session runs this, and an idle one still holds the limits from its last API
# response. So a session writes only when its own limits change, which happens only after a
# new response. Otherwise an idle session would put old values (say, "limit reached" from
# before a reset) back over newer ones each time its status line redraws.
session=$(printf '%s' "$input" | jq -r '.session_id // empty' 2>/dev/null)
if [ -n "$limits" ]; then
  mkdir -p "$cache_dir/sessions"
  mark="$cache_dir/sessions/${session:-unknown}"
  sum=$(printf '%s' "$limits" | shasum | cut -c1-40)
  # A session in use (its transcript written in the last 2 minutes) also writes: its values are current.
  transcript=$(printf '%s' "$input" | jq -r '.transcript_path // empty' 2>/dev/null)
  active=$( [ -n "$transcript" ] && [ -n "$(find "$transcript" -mmin -2 2>/dev/null)" ] && echo 1 )
  if [ -z "$session" ] || [ -n "$active" ] || [ "$(cat "$mark" 2>/dev/null)" != "$sum" ]; then
    printf '%s' "$sum" > "$mark"
    tmp=$(mktemp "$cache_dir/claude.XXXXXX")
    printf '{"captured_at":%s,"rate_limits":%s}\n' "$(date +%s)" "$limits" > "$tmp" && mv "$tmp" "$cache_file"
  fi
  find "$cache_dir/sessions" -type f -mtime +3 -delete 2>/dev/null
fi

printf '%s' "$input" | jq -r '
  [ .model.display_name,
    (.rate_limits.five_hour.used_percentage // empty | "5h \(round)%"),
    (.rate_limits.seven_day.used_percentage // empty | "week \(round)%")
  ] | join(" · ")'
