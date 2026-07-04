#!/usr/bin/env bash
# deploy.sh - push the relay daemons + systemd units to their boxes and
# restart them. Paths are relative to relay/ however this script is invoked.
#
# TWO hosts (ssh aliases; Host blocks in ~/.ssh/config, CI writes equivalents):
#   nan-relay - the TCP (SNI) + UDP relays. relay.js binds the whole 1-19999
#               public port range there, so the API relay CANNOT share this
#               box (its port 8100 sits inside that range).
#   nan       - the API relay (api.nan.host: the box's Caddy fronts :8100).
#
# Host layout (see README): /opt/nan-relay/ holds the daemons and their
# node_modules; units live in /etc/systemd/system; env files under
# /etc/nan-relay/ are host state and are NOT touched here.
set -euo pipefail
cd "$(dirname "$0")"

echo "== nan-relay: tcp + udp relays"
scp relay.js udp-relay.js package.json nan-relay:/opt/nan-relay/
scp systemd/nan-tcp-relay.service systemd/nan-udp-relay.service nan-relay:/etc/systemd/system/
ssh nan-relay 'cd /opt/nan-relay && npm install --omit=dev --no-audit --no-fund \
  && systemctl daemon-reload \
  && systemctl restart nan-tcp-relay nan-udp-relay \
  && systemctl is-active nan-tcp-relay nan-udp-relay'

echo "== nan: api relay"
scp api-relay.js package.json nan:/opt/nan-relay/
scp systemd/nan-api-relay.service nan:/etc/systemd/system/
ssh nan 'cd /opt/nan-relay && npm install --omit=dev --no-audit --no-fund \
  && systemctl daemon-reload \
  && systemctl restart nan-api-relay \
  && systemctl is-active nan-api-relay'
