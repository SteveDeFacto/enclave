#!/usr/bin/env bash
# release.sh - build + push every Enclave container for linux/amd64, read each pushed
# digest, and repin it in enclaves/*/tinfoil-config.yml. Pin by DIGEST (what Tinfoil attests),
# not by tag. Run from anywhere inside the repo.
#
#   ./scripts/release.sh                        # all images
#   ./scripts/release.sh enclave-supervisor enclave-wasm-manager   # just these
#   DRY_RUN=1 ./scripts/release.sh        # no docker; repin with a fake digest (test)
#
# Auth: set CR_PAT (classic PAT with write:packages) or be logged in to ghcr.io.
# Note: GHCR package VISIBILITY is per-package and sticky. Images already made
# public stay public on re-push; only a brand-new package name needs the one-time
# web-UI publicize (Settings -> Danger Zone -> Change visibility -> Public).
set -euo pipefail

REGISTRY="ghcr.io"
ORG="stevedefacto"
PLATFORM="linux/amd64"          # Tinfoil enclave is x86
DIGEST_SEP="${DIGEST_SEP:-@}"   # OCI digest pin form: name@sha256:HEX. (':' is invalid and Tinfoil rejects it.)
TAG="${TAG:-$(git rev-parse --short HEAD 2>/dev/null || echo dev)}"

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
CONFIG="$REPO_ROOT/enclaves/gpu/tinfoil-config.yml"
CONFIG_CPU="$REPO_ROOT/enclaves/cpu/tinfoil-config.yml"    # CPU-only flavor; shares the supervisor + wasm-manager images
CONFIG_GPU8="$REPO_ROOT/enclaves/gpu8/tinfoil-config.yml"  # 8xGPU platform-model flavor; shares the supervisor image, adds enclave-vllm
cd "$REPO_ROOT"

# image short-name -> build context (Dockerfile is <context>/Dockerfile unless
# overridden in DOCKERFILE below)
declare -A CONTEXT=(
  [enclave-mps]="mps-daemon"
  [enclave-worker]="worker"
  [enclave-supervisor]="."
  [enclave-wasm-manager]="wasm"
  [enclave-vllm]="vllm"
)
# per-image Dockerfile override (default: <context>/Dockerfile).
declare -A DOCKERFILE=(
  [enclave-wasm-manager]="wasm/Dockerfile.wasm"
)
ORDER=(enclave-mps enclave-worker enclave-supervisor enclave-wasm-manager enclave-vllm)   # deterministic build order

# pick the subset (positional args) or all
TARGETS=("$@"); [ ${#TARGETS[@]} -eq 0 ] && TARGETS=("${ORDER[@]}")

DRY_RUN="${DRY_RUN:-0}"
say(){ printf '\033[1;36m[release]\033[0m %s\n' "$*"; }

# optional login
if [ "$DRY_RUN" != "1" ] && [ -n "${CR_PAT:-}" ]; then
  say "logging in to $REGISTRY as $ORG"
  echo "$CR_PAT" | docker login "$REGISTRY" -u "$ORG" --password-stdin >/dev/null
fi

repin(){ # $1=image name, $2=digest (sha256:...) — pins into EVERY config that ships the image
  local name="$1" digest="$2" cfg
  local pat="(image: \"${REGISTRY//./\\.}/${ORG}/${name})[:@][^\"]*\""
  local rep="\\1${DIGEST_SEP}${digest}\""
  for cfg in "$CONFIG" "$CONFIG_CPU" "$CONFIG_GPU8"; do
    [ -f "$cfg" ] || continue
    grep -qE "image: \"${REGISTRY}/${ORG}/${name}[:@]" "$cfg" || continue  # this flavor doesn't ship it
    sed -i -E "s#${pat}#${rep}#" "$cfg"
    grep -q "${REGISTRY}/${ORG}/${name}${DIGEST_SEP}${digest}" "$cfg" \
      || { echo "ERROR: failed to repin ${name} in $cfg"; exit 1; }
  done
}

for name in "${TARGETS[@]}"; do
  ctx="${CONTEXT[$name]:-}"
  [ -z "$ctx" ] && { echo "unknown image: $name (known: ${!CONTEXT[*]})"; exit 1; }
  dockerfile="${DOCKERFILE[$name]:-$ctx/Dockerfile}"
  ref="${REGISTRY}/${ORG}/${name}:${TAG}"

  if [ "$DRY_RUN" = "1" ]; then
    digest="sha256:$(printf '%s' "$name-$TAG" | sha256sum | cut -c1-64)"
    say "DRY_RUN ${name}  (context: ${ctx}, dockerfile: ${dockerfile})  fake digest ${digest}"
  else
    say "build+push ${name}  (context: ${ctx}, dockerfile: ${dockerfile})  -> ${ref}"
    meta="$(mktemp)"
    docker buildx build --platform "$PLATFORM" --push \
      -f "$dockerfile" -t "$ref" --metadata-file "$meta" "$ctx"
    digest="$(python3 -c "import json;print(json.load(open('$meta'))['containerimage.digest'])")"
    rm -f "$meta"
    say "  pushed digest ${digest}"
  fi

  repin "$name" "$digest"
  say "  repinned ${name} -> ${DIGEST_SEP}${digest}"
done

# validate the configs still parse
for cfg in "$CONFIG" "$CONFIG_CPU" "$CONFIG_GPU8"; do
  [ -f "$cfg" ] || continue
  python3 -c "import yaml; yaml.safe_load(open('$cfg'))" \
    && say "$(basename "$cfg") valid"
done

say "done. pinned images:"
grep -nE "image:" "$CONFIG" "$CONFIG_CPU" "$CONFIG_GPU8" 2>/dev/null | sed 's/^/    /'
[ "$DRY_RUN" = "1" ] && say "DRY_RUN: no images were built or pushed; digests are fake."
say "reminder: confirm each package is PUBLIC so Tinfoil can pull it anonymously."
