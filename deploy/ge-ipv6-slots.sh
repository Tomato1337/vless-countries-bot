#!/bin/sh
# Puts every GE IPv6 slot address on the uplink. preferred_lft 0 marks them deprecated, so the kernel never picks
# them as a default source; Xray still binds them explicitly through sendThrough.
set -eu
: "${SLOTS_FILE:?set SLOTS_FILE to the bot's data/ge-ipv6-slots.json}"
: "${DEV:?set DEV to the uplink interface}"
ACTION=${1:-add}

jq -r '.slots[].address' "$SLOTS_FILE" | while read -r address; do
  if [ "$ACTION" = del ]; then
    ip -6 addr del "$address/128" dev "$DEV" 2>/dev/null || true
  else
    ip -6 addr replace "$address/128" dev "$DEV" nodad preferred_lft 0
  fi
done
