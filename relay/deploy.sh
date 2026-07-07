#!/usr/bin/env bash
# deploy.sh - push the relay daemons + systemd units to their boxes and
# restart them. Paths are relative to relay/ however this script is invoked.
#
# TWO hosts (ssh aliases; Host blocks in ~/.ssh/config, CI writes equivalents):
#   nan-relay - the TCP (SNI) + UDP relays. relay.js binds the whole 1-19999
#               public port range there, so the API relay CANNOT share this
#               box (its port 8100 sits inside that range).
#   nan       - the API relay (api.enclave.host: the box's Caddy fronts :8100).
#
# Host layout (see README): /opt/nan-relay/ holds the daemons and their
# node_modules; units live in /etc/systemd/system; env files under
# /etc/nan-relay/ are host state and are NOT touched here.
set -euo pipefail
cd "$(dirname "$0")"

echo "== nan-relay: tcp (SNI) + tcp6 (dedicated-IP) + udp + egress relays"
# net-guard.mjs is a symlink to ../net-guard.mjs (the canonical SSRF classifier
# shared with the enclave's egress.js); scp follows it and ships the content.
# fleet.mjs is the shared fleet discovery (REGISTRY_ADDRESS / ENCLAVES) the
# tcp6/udp/egress relays use to follow an arbitrary, changing set of enclaves.
scp relay.js tcp6-relay.js udp-relay.js egress-relay.js fleet.mjs net-guard.mjs package.json nan-relay:/opt/nan-relay/
scp systemd/nan-tcp-relay.service systemd/nan-tcp6-relay.service systemd/nan-udp-relay.service systemd/nan-egress-relay.service nan-relay:/etc/systemd/system/
# The egress relay only runs once /etc/nan-relay/egress-relay.env exists
# (REGISTRY_ADDRESS or ENCLAVES + EGRESS_RELAY_TOKEN + EGRESS_PREFIX=<same
# /64>). Until then its restart is a no-op failure; enable it explicitly when
# the operator adds the env.
ssh nan-relay 'cd /opt/nan-relay && npm install --omit=dev --no-audit --no-fund \
  && systemctl daemon-reload \
  && systemctl restart nan-tcp-relay nan-tcp6-relay nan-udp-relay \
  && systemctl is-active nan-tcp-relay nan-tcp6-relay nan-udp-relay \
  && if [ -f /etc/nan-relay/egress-relay.env ]; then \
       systemctl enable --now nan-egress-relay && systemctl restart nan-egress-relay \
       && systemctl is-active nan-egress-relay; \
     else echo "nan-egress-relay: no /etc/nan-relay/egress-relay.env yet — skipped"; fi'

echo "== api relay (site box)"
scp api-relay.js package.json nan:/opt/nan-relay/
scp systemd/nan-api-relay.service nan:/etc/systemd/system/
ssh nan 'cd /opt/nan-relay && npm install --omit=dev --no-audit --no-fund \
  && systemctl daemon-reload \
  && systemctl restart nan-api-relay \
  && systemctl is-active nan-api-relay'
