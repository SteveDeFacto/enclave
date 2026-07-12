#!/usr/bin/env bash
# Ship the daily IPFS pin-cleanup job to the nan box and enable its timer.
#
# The cleanup script lives in /opt/enclave-gateway (alongside the add-gateway —
# both are nan storage hygiene; this dir survives site AND relay redeploys). It
# borrows viem from /opt/nan-relay/node_modules at runtime (RELAY_DIR), so no
# extra install. Env (BASE_RPC, ADDRESS_BOOK_ADDRESS) is reused from the relay's
# /etc/nan-relay/api-relay.env via the unit's EnvironmentFile.
#
# Pass --run to trigger one cleanup pass immediately after install (a DRY-RUN
# first is still recommended: `ssh nan PIN_CLEANUP_DRY_RUN=1 node /opt/enclave-gateway/nan-pin-cleanup.mjs`).
set -euo pipefail
cd "$(dirname "$0")"

ssh nan 'mkdir -p /opt/enclave-gateway'
scp nan-pin-cleanup.mjs     nan:/opt/enclave-gateway/nan-pin-cleanup.mjs
scp nan-pin-cleanup.service nan:/etc/systemd/system/nan-pin-cleanup.service
scp nan-pin-cleanup.timer   nan:/etc/systemd/system/nan-pin-cleanup.timer

ssh nan 'systemctl daemon-reload \
  && systemctl enable --now nan-pin-cleanup.timer \
  && systemctl list-timers nan-pin-cleanup.timer --no-pager'

if [ "${1:-}" = "--run" ]; then
  echo "--- triggering one cleanup pass ---"
  ssh nan 'systemctl start nan-pin-cleanup.service; journalctl -u nan-pin-cleanup.service -n 60 --no-pager'
fi
