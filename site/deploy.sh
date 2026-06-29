#!/usr/bin/env bash
set -euo pipefail
scp index.html openapi.json nan:/opt/nan-site/
ssh nan 'chown -R ipfs:ipfs /opt/nan-site && \
  sudo -u ipfs IPFS_PATH=/var/lib/ipfs /usr/local/bin/nan-deploy.sh /opt/nan-site'
