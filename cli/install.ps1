# enclave CLI installer (Windows) — PowerShell counterpart of install.sh, the
# future target of `irm https://get.enclave.host/install.ps1 | iex`. Until that
# host serves a prebuilt bundle, it installs from a checkout: bundles
# cli/enclave.mjs (deps inlined, ~1 MB) into %LOCALAPPDATA%\enclave\bin and
# creates an `enclave` command shim. Needs node >= 20 on PATH.
#
#   .\cli\install.ps1        (from PowerShell; or: powershell -ExecutionPolicy Bypass -File cli\install.ps1)
#
# No-script alternative that works on every OS: npm install -g .\cli
# (npm generates the .cmd shim itself; the CLI is plain node either way).
$ErrorActionPreference = "Stop"

function Fail($msg) { Write-Host "error: $msg" -ForegroundColor Red; exit 1 }

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Fail "node is required (https://nodejs.org, v20 or newer)"
}
$major = [int](node -p "parseInt(process.versions.node)")
if ($major -lt 20) { Fail "node >= 20 required (found $(node -v))" }

$cliDir = $PSScriptRoot
if (-not $cliDir -or -not (Test-Path (Join-Path $cliDir "enclave.mjs"))) {
  Fail "run this from a checkout: git clone https://github.com/EnclaveHost/enclave; .\enclave\cli\install.ps1"
}

# bundle deps: the repo root has them; a bare checkout of cli/ installs its own
$haveRoot = Test-Path (Join-Path $cliDir "..\node_modules\viem")
$haveCli  = Test-Path (Join-Path $cliDir "node_modules\viem")
if (-not $haveRoot -and -not $haveCli) {
  Write-Host "installing bundle dependencies (viem, @tinfoilsh/verifier, esbuild)..."
  npm --prefix $cliDir install --no-fund --no-audit
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
Write-Host "installed $shim"
Write-Host "try: enclave help"
