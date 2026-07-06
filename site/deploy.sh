#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"    # paths below are relative to site/, however this script is invoked
scp index.html openapi.json buy.html nan:/opt/nan-site/
scp -r privy nan:/opt/nan-site/    # self-hosted @privy-io/react-auth bundle for buy.html
ssh nan 'chown -R ipfs:ipfs /opt/nan-site && \
  sudo -u ipfs IPFS_PATH=/var/lib/ipfs /usr/local/bin/nan-deploy.sh /opt/nan-site'
