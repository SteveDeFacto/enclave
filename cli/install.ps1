# enclave CLI installer (Windows) — PowerShell counterpart of install.sh.
# Two ways in, same artifact out:
#
#   irm https://enclave.host/install.ps1 | iex          # hosted one-liner (also: get.enclave.host/install.ps1)
#   .\cli\install.ps1                                   # from a checkout
#     (or: powershell -ExecutionPolicy Bypass -File cli\install.ps1)
#
# Either way it bundles cli/enclave.mjs (deps inlined, ~1 MB, exact versions
# from the checked-in package-lock.json) into %LOCALAPPDATA%\enclave\bin and
# creates an `enclave` command shim. The hosted mode downloads the source
# zipball of EnclaveHost/enclave@main from GitHub over TLS and builds it
# locally - no prebuilt binary is ever downloaded, so what you run is what's
# in the repo. (If a prebuilt-bundle path is ever added, pin its sha256/
# signature here BEFORE shipping it: this is a key-holding signing binary.)
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
  $zipUrl = "https://github.com/EnclaveHost/enclave/archive/refs/heads/main.zip"
  $tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("enclave-install-" + [System.IO.Path]::GetRandomFileName())
  New-Item -ItemType Directory -Force -Path $tmp | Out-Null
  Write-Host "fetching $zipUrl"
  $zip = Join-Path $tmp "enclave.zip"
  Invoke-WebRequest -Uri $zipUrl -OutFile $zip -UseBasicParsing
  Expand-Archive -Path $zip -DestinationPath $tmp
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
