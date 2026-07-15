#!/usr/bin/env bash
# release-cli.sh — cut a PINNED, CHECKSUMMED CLI release.
#
# The `curl … | sh` / `irm … | iex` installers (cli/install.sh, cli/install.ps1)
# no longer build the moving main tip: they download a release tarball/zipball
# plus its SHA256SUMS and refuse to build unless the checksum matches. This
# script produces exactly those assets and publishes the GitHub release.
#
#   ./scripts/release-cli.sh cli-v0.5.0            # tag (created from HEAD if absent) + release
#   TAG_FROM=<ref> ./scripts/release-cli.sh cli-v0.5.0
#   DRY_RUN=1 ./scripts/release-cli.sh cli-v0.5.0  # build assets locally, no tag/push/release
#
# Deterministic: assets come from `git archive` of the TAG (not GitHub's
# auto-archives, which aren't byte-stable), prefixed enclave-<tag>/ so the
# installers' `*/cli` glob resolves. Auth: `gh` logged in with repo write.
#
# After releasing, bump the installers' default if you pin an exact version
# (they otherwise resolve the latest cli-* release automatically), and redeploy
# the hosted install.sh/install.ps1 to get.enclave.host.
set -euo pipefail

TAG="${1:-}"
[ -n "$TAG" ] || { echo "usage: $0 <tag>  (e.g. cli-v0.5.0)" >&2; exit 1; }
case "$TAG" in cli-*) ;; *) echo "error: tag must start with 'cli-' (installers resolve latest cli-* release)" >&2; exit 1;; esac

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"
DRY_RUN="${DRY_RUN:-0}"
TAG_FROM="${TAG_FROM:-HEAD}"
OUT="$(mktemp -d)"
trap 'rm -rf "$OUT"' EXIT
say(){ printf '\033[1;36m[release-cli]\033[0m %s\n' "$*"; }

# Create the tag if it doesn't exist yet (annotated, from TAG_FROM).
if ! git rev-parse -q --verify "refs/tags/$TAG" >/dev/null; then
  if [ "$DRY_RUN" = "1" ]; then
    say "DRY_RUN: would create tag $TAG from $TAG_FROM"; REF="$TAG_FROM"
  else
    say "creating tag $TAG from $TAG_FROM"
    git tag -a "$TAG" "$TAG_FROM" -m "enclave CLI $TAG"
    REF="$TAG"
  fi
else
  REF="$TAG"
fi

TARBALL="enclave-cli-$TAG.tar.gz"
ZIPBALL="enclave-cli-$TAG.zip"
say "git archive -> $TARBALL + $ZIPBALL (prefix enclave-$TAG/)"
git archive --format=tar.gz --prefix="enclave-$TAG/" "$REF" -o "$OUT/$TARBALL"
git archive --format=zip    --prefix="enclave-$TAG/" "$REF" -o "$OUT/$ZIPBALL"

say "SHA256SUMS"
( cd "$OUT" && sha256sum "$TARBALL" "$ZIPBALL" > SHA256SUMS && cat SHA256SUMS )

if [ "$DRY_RUN" = "1" ]; then
  say "DRY_RUN: built assets (not published), left for inspection:"
  DEST="${TMPDIR:-/tmp}/enclave-cli-$TAG"
  mkdir -p "$DEST"; cp "$OUT/$TARBALL" "$OUT/$ZIPBALL" "$OUT/SHA256SUMS" "$DEST/"
  ls -l "$DEST"
  exit 0
fi

command -v gh >/dev/null || { echo "error: gh CLI required to publish the release" >&2; exit 1; }
git push origin "$TAG"
say "gh release create $TAG"
gh release create "$TAG" "$OUT/$TARBALL" "$OUT/$ZIPBALL" "$OUT/SHA256SUMS" \
  --title "enclave CLI $TAG" \
  --notes "Pinned, checksum-verified CLI release. Install: \`curl -fsSL https://get.enclave.host | sh\` (resolves the latest cli-* release and verifies SHA256SUMS before building)."
say "done: $TAG published with $TARBALL, $ZIPBALL, SHA256SUMS"
