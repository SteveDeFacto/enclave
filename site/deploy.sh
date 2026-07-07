#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"    # paths below are relative to site/, however this script is invoked

# compile css/src/*.css -> css/site.css (Tailwind v4). The compiled bundle is
# also committed, so a box without the toolchain still deploys the last build.
if command -v npx >/dev/null 2>&1 && [ -d ../node_modules/@tailwindcss ]; then
  (cd .. && npm run -s build:site)
fi

scp index.html deploy.html apps.html develop.html buy.html openapi.json nan:/opt/nan-site/
ssh nan 'mkdir -p /opt/nan-site/css /opt/nan-site/js'
scp css/site.css nan:/opt/nan-site/css/
scp -r js/lib js/core js/pages nan:/opt/nan-site/js/
scp -r components nan:/opt/nan-site/    # LWC-style bundles; the .html templates are fetched at runtime
scp -r privy nan:/opt/nan-site/    # self-hosted @privy-io/react-auth bundle for buy.html
ssh nan 'chown -R ipfs:ipfs /opt/nan-site && \
  sudo -u ipfs IPFS_PATH=/var/lib/ipfs /usr/local/bin/nan-deploy.sh /opt/nan-site'
