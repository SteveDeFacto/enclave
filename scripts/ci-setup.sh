#!/usr/bin/env bash
# ci-setup.sh - one-time provisioning for .github/workflows/deploy.yml.
# Idempotent: re-run any time; it only (re)writes what it manages.
#
# Needs: gh (authed as a repo admin), ssh access to the site + relay boxes via
# the `nan` / `nan-relay` aliases in ~/.ssh/config.
#
# What it sets up:
#   - a dedicated CI deploy keypair (~/.ssh/nan-ci-deploy), installed on both boxes
#   - repo secret  DEPLOY_SSH_KEY        (the private key CI ssh-es with)
#   - repo vars    SITE_SSH_HOST, RELAY_SSH_HOST, DEPLOY_KNOWN_HOSTS, CONTRACTS_NETWORK
#   - environment  contract-deploy      (required-reviewer gate for contract deploys)
#
# What it can NOT do for you (prints reminders):
#   - DEPLOYER_PRIVATE_KEY: your funded Base EOA, set it yourself on the environment
#   - ghcr Actions access for the sidecar packages (web UI only), or a CR_PAT secret
set -euo pipefail
say() { printf '\033[1;36m[ci-setup]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[ci-setup] WARNING:\033[0m %s\n' "$*" >&2; }

REPO_SLUG="${REPO_SLUG:-SteveDeFacto/enclave}"
SITE_HOST="${SITE_HOST:-62.238.4.214}"
RELAY_HOST="${RELAY_HOST:-46.62.128.36}"
KEYFILE="${KEYFILE:-$HOME/.ssh/nan-ci-deploy}"

# 1) CI deploy keypair
if [ ! -f "$KEYFILE" ]; then
  ssh-keygen -t ed25519 -N "" -C "nan-ci-deploy" -f "$KEYFILE"
  say "generated $KEYFILE"
else
  say "reusing existing $KEYFILE"
fi
PUB="$(cat "$KEYFILE.pub")"

# 2) install the public key on both boxes (via your existing ssh aliases)
for h in nan nan-relay; do
  if ssh -o BatchMode=yes -o ConnectTimeout=10 "$h" \
      "mkdir -p ~/.ssh && chmod 700 ~/.ssh && touch ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys \
       && grep -qF '$PUB' ~/.ssh/authorized_keys || echo '$PUB' >> ~/.ssh/authorized_keys"; then
    say "CI key installed on $h"
  else
    warn "could not reach $h — install the key manually: cat $KEYFILE.pub | ssh $h 'cat >> ~/.ssh/authorized_keys'"
  fi
done

# 3) repo secret + vars
gh secret set DEPLOY_SSH_KEY -R "$REPO_SLUG" < "$KEYFILE"
say "set secret DEPLOY_SSH_KEY"
gh variable set SITE_SSH_HOST -R "$REPO_SLUG" -b "$SITE_HOST"
gh variable set RELAY_SSH_HOST -R "$REPO_SLUG" -b "$RELAY_HOST"
gh variable set CONTRACTS_NETWORK -R "$REPO_SLUG" -b "${CONTRACTS_NETWORK:-base}"
KNOWN="$(ssh-keyscan -t ed25519 "$SITE_HOST" "$RELAY_HOST" 2>/dev/null)"
[ -n "$KNOWN" ] || { warn "ssh-keyscan returned nothing; DEPLOY_KNOWN_HOSTS not set"; exit 1; }
gh variable set DEPLOY_KNOWN_HOSTS -R "$REPO_SLUG" -b "$KNOWN"
say "set vars SITE_SSH_HOST=$SITE_HOST RELAY_SSH_HOST=$RELAY_HOST CONTRACTS_NETWORK=${CONTRACTS_NETWORK:-base} DEPLOY_KNOWN_HOSTS"

# 4) contract-deploy environment, gated on the repo owner's review
UID_JSON="$(gh api "users/${REPO_SLUG%%/*}" --jq .id)"
gh api -X PUT "repos/$REPO_SLUG/environments/contract-deploy" \
  --input - >/dev/null <<EOF
{"reviewers":[{"type":"User","id":$UID_JSON}]}
EOF
say "environment contract-deploy created (required reviewer: ${REPO_SLUG%%/*})"

say "still manual:"
say "  1. gh secret set DEPLOYER_PRIVATE_KEY -R $REPO_SLUG --env contract-deploy   # funded Base EOA for contract deploys"
say "  2. ghcr package settings for enclave-worker / enclave-mps / enclave-wasm-manager: grant this repo"
say "     'Actions access: write' (or set a classic PAT: gh secret set CR_PAT -R $REPO_SLUG)"
