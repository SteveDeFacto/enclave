# enclave CLI installer (Windows) — PowerShell counterpart of install.sh.
# Two ways in, same artifact out:
#
#   irm https://get.enclave.host/install.ps1 | iex      # hosted one-liner (also: enclave.host/install.ps1)
#   .\cli\install.ps1                                   # from a checkout
#     (or: powershell -ExecutionPolicy Bypass -File cli\install.ps1)
#
# Either way it bundles cli/enclave.mjs (deps inlined, ~1 MB, exact versions
# from the checked-in package-lock.json) into %LOCALAPPDATA%\enclave\bin and
# creates an `enclave` command shim. This is a KEY-HOLDING signing binary, so the
# hosted mode does NOT build the moving branch tip: it downloads a PINNED release
# zipball plus its SHA256SUMS and REFUSES to build unless the checksum matches.
# Pin an exact tag with $env:ENCLAVE_CLI_VERSION="cli-vX.Y.Z"; unset resolves the
# latest cli-* release. $env:ENCLAVE_CLI_CHANNEL="edge" is an explicit, UNVERIFIED
# escape hatch that builds the current main tip (dev only).
#
# Needs node >= 20 on PATH.
# No-script alternative that works on every OS: npm install -g .\cli
# (npm generates the .cmd shim itself; the CLI is plain node either way).
$ErrorActionPreference = "Stop"

# throw, not exit: under `irm | iex` an exit would close the user's terminal
function Fail($msg) { Write-Host "error: $msg" -ForegroundColor Red; throw $msg }

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Fail "node is required (https://nodejs.org, v20 or newer)"
}
$major = [int](node -p "parseInt(process.versions.node)")
if ($major -lt 20) { Fail "node >= 20 required (found $(node -v))" }

# checkout mode: this script sits in cli\ next to enclave.mjs. Piped through
# `irm | iex` there is no script path, so fetch the repo and build from that.
$cliDir = $PSScriptRoot
$tmp = $null
if (-not $cliDir -or -not (Test-Path (Join-Path $cliDir "enclave.mjs"))) {
  $gh  = "https://github.com/EnclaveHost/enclave"
  $api = "https://api.github.com/repos/EnclaveHost/enclave"
  $tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("enclave-install-" + [System.IO.Path]::GetRandomFileName())
  New-Item -ItemType Directory -Force -Path $tmp | Out-Null
  $zip = Join-Path $tmp "enclave.zip"

  if ($env:ENCLAVE_CLI_CHANNEL -eq "edge") {
    # explicit, UNVERIFIED dev path: build the current main tip, no checksum.
    Write-Host "WARNING: ENCLAVE_CLI_CHANNEL=edge builds the UNVERIFIED main tip (no checksum). Dev use only." -ForegroundColor Yellow
    Invoke-WebRequest -Uri "$gh/archive/refs/heads/main.zip" -OutFile $zip -UseBasicParsing
    Expand-Archive -Path $zip -DestinationPath $tmp
  } else {
    # pinned + checksum-verified release. ENCLAVE_CLI_VERSION pins an exact tag;
    # unset resolves the latest cli-* release.
    $ver = $env:ENCLAVE_CLI_VERSION
    if (-not $ver) {
      $rels = Invoke-RestMethod -Uri "$api/releases" -UseBasicParsing
      $ver = ($rels | Where-Object { $_.tag_name -like "cli-*" } | Select-Object -First 1).tag_name
      if (-not $ver) { Fail "no cli-* release found (and ENCLAVE_CLI_VERSION unset). Set `$env:ENCLAVE_CLI_VERSION='cli-vX.Y.Z', or `$env:ENCLAVE_CLI_CHANNEL='edge' for an unverified dev build." }
    }
    $base = "$gh/releases/download/$ver"
    $zipname = "enclave-cli-$ver.zip"
    Write-Host "fetching $ver (checksum-verified)..."
    Invoke-WebRequest -Uri "$base/$zipname"   -OutFile $zip -UseBasicParsing
    $sums = Join-Path $tmp "SHA256SUMS"
    Invoke-WebRequest -Uri "$base/SHA256SUMS" -OutFile $sums -UseBasicParsing
    $want = ((Get-Content $sums | Where-Object { $_ -match [regex]::Escape($zipname) }) -split '\s+' | Where-Object { $_ } | Select-Object -First 1)
    $got  = (Get-FileHash $zip -Algorithm SHA256).Hash.ToLower()
    if (-not $want -or $want.ToLower() -ne $got) { Fail "checksum mismatch for $ver (want=$want got=$got) - refusing to build" }
    Expand-Archive -Path $zip -DestinationPath $tmp
  }

  $repo = Get-ChildItem -Directory -Path $tmp -Filter "enclave-*" | Select-Object -First 1
  if (-not $repo) { Fail "download did not contain the repo" }
  $cliDir = Join-Path $repo.FullName "cli"
  if (-not (Test-Path (Join-Path $cliDir "enclave.mjs"))) { Fail "download did not contain cli/enclave.mjs" }
}

# bundle deps: the repo root has them; a bare checkout of cli/ installs its own
$haveRoot = Test-Path (Join-Path $cliDir "..\node_modules\viem")
$haveCli  = Test-Path (Join-Path $cliDir "node_modules\viem")
if (-not $haveRoot -and -not $haveCli) {
  Write-Host "installing bundle dependencies (viem, @tinfoilsh/verifier, esbuild)..."
  # Prefer `npm ci` — exact versions from the checked-in package-lock.json (this
  # is a key-holding signing binary; no floating caret ranges). Fall back to
  # `npm install` only if the lockfile is missing (e.g. an old checkout).
  if (Test-Path (Join-Path $cliDir "package-lock.json")) {
    npm --prefix $cliDir ci --no-fund --no-audit
  } else {
    Write-Host "note: no package-lock.json found - falling back to 'npm install' (unpinned)"
    npm --prefix $cliDir install --no-fund --no-audit
  }
  if ($LASTEXITCODE -ne 0) { Fail "npm install failed" }
}

$binDir = Join-Path $env:LOCALAPPDATA "enclave\bin"
New-Item -ItemType Directory -Force -Path $binDir | Out-Null
$bundle = Join-Path $binDir "enclave.mjs"

node (Join-Path $cliDir "build.mjs") $bundle
if ($LASTEXITCODE -ne 0) { Fail "bundle failed" }

# the `enclave` command: a .cmd shim (shebangs do nothing on Windows)
$shim = Join-Path $binDir "enclave.cmd"
Set-Content -Path $shim -Value "@echo off`r`nnode `"%~dp0enclave.mjs`" %*" -Encoding ascii

# put the bin dir on the user PATH (announced, not silent; new terminals see it)
$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
if (($userPath -split ";") -notcontains $binDir) {
  if ([string]::IsNullOrEmpty($userPath)) { $newPath = $binDir } else { $newPath = "$userPath;$binDir" }
  [Environment]::SetEnvironmentVariable("Path", $newPath, "User")
  Write-Host "added $binDir to your user PATH (open a new terminal to pick it up)"
}

node $bundle version | Out-Null
if ($LASTEXITCODE -ne 0) { Fail "installed bundle failed its smoke test" }

# hosted mode leaves nothing behind but the install itself
if ($tmp) { Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue }

Write-Host "installed $shim"
Write-Host "try: enclave help"
