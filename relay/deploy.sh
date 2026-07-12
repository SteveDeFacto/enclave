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
scp relay.js tcp6-relay.js udp-relay.js egress-relay.js dns-relay.js fleet.mjs net-guard.mjs package.json nan-relay:/opt/nan-relay/
scp systemd/enclave-tcp-relay.service systemd/enclave-tcp6-relay.service systemd/enclave-udp-relay.service systemd/enclave-egress-relay.service systemd/enclave-dns.service nan-relay:/etc/systemd/system/
# The egress relay only runs once /etc/nan-relay/egress-relay.env exists
# (REGISTRY_ADDRESS or ENCLAVES + EGRESS_RELAY_TOKEN + EGRESS_PREFIX=<same
# /64>). Until then its restart is a no-op failure; enable it explicitly when
# the operator adds the env.
# One-time migration from the pre-rename nan-* unit names: the old unit must
# be gone before the enclave-* one starts, or the two race for the same ports.
ssh nan-relay 'for u in nan-tcp-relay nan-tcp6-relay nan-udp-relay nan-egress-relay; do \
    if [ -f /etc/systemd/system/$u.service ]; then \
      systemctl disable --now $u || true; rm /etc/systemd/system/$u.service; fi; done \
  && cd /opt/nan-relay && npm install --omit=dev --no-audit --no-fund \
  && systemctl daemon-reload \
  && systemctl enable enclave-tcp-relay enclave-tcp6-relay enclave-udp-relay \
  && systemctl restart enclave-tcp-relay enclave-tcp6-relay enclave-udp-relay \
  && systemctl is-active enclave-tcp-relay enclave-tcp6-relay enclave-udp-relay \
  && if [ -f /etc/nan-relay/egress-relay.env ]; then \
       systemctl enable --now enclave-egress-relay && systemctl restart enclave-egress-relay \
       && systemctl is-active enclave-egress-relay; \
     else echo "enclave-egress-relay: no /etc/nan-relay/egress-relay.env yet — skipped"; fi \
  && if [ -f /etc/nan-relay/dns.env ]; then \
       systemctl enable --now enclave-dns && systemctl restart enclave-dns \
       && systemctl is-active enclave-dns; \
     else echo "enclave-dns: no /etc/nan-relay/dns.env yet — skipped (authoritative DNS for app./ip. zones)"; fi'

echo "== api relay (site box)"
# api-relay.js imports ./fleet.mjs (shared discovery: registry read + TRUSTED_OPERATORS
# filter + on-chain runner routing) — it MUST ship alongside or the service crash-loops
# with ERR_MODULE_NOT_FOUND. fleet.mjs is self-contained (no local-file deps).
scp api-relay.js fleet.mjs package.json nan:/opt/nan-relay/
scp systemd/enclave-api-relay.service nan:/etc/systemd/system/
ssh nan 'if [ -f /etc/systemd/system/nan-api-relay.service ]; then \
    systemctl disable --now nan-api-relay || true; rm /etc/systemd/system/nan-api-relay.service; fi \
  && cd /opt/nan-relay && npm install --omit=dev --no-audit --no-fund \
  && systemctl daemon-reload \
  && systemctl enable enclave-api-relay \
  && systemctl restart enclave-api-relay \
  && systemctl is-active enclave-api-relay'
