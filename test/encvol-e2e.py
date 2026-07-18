#!/usr/bin/env python3
"""Encrypted volumes (rclone crypt over S3) - full-stack e2e for the manager.

Drives the REAL pipeline, no mocks: a client-side rclone-crypt push, a
wasm_manager launch whose config names the volume, the encrypted-volumes
app's /api proxy (the decryption UI's backend), the manager's /encvol
unlock/sync/lock plane, and plaintext back out through the app's /f route.

Stage 1 uses rclone's local backend via the WASM_ENC_LOCAL_SRC test hook.
Stage 2 repeats the core flow over the REAL S3 protocol (sigv4 credentials)
against `rclone serve s3`, and checks the local: hook is refused without the
env. Standalone (not part of `npm test`):

    python3 test/encvol-e2e.py

Needs: wasmtime (serve-capable), rclone >= 1.57 (stage 2 wants >= 1.65 for
`serve s3`; skipped otherwise), and the encrypted-volumes app component built
in the sibling checkout (cargo component build --release --target
wasm32-wasip2 in enclave-apps/encrypted-volumes). Overrides: RCLONE_BIN,
ENCVOL_APP_WASM."""
import hashlib
import json
import os
import pathlib
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

REPO    = pathlib.Path(__file__).resolve().parent.parent
RCLONE  = os.environ.get("RCLONE_BIN", "rclone")
WASM    = pathlib.Path(os.environ.get("ENCVOL_APP_WASM", str(
    REPO.parent / "enclave-apps/encrypted-volumes/target/wasm32-wasip1/release/encrypted_volumes.wasm")))
PASSWORD, SALT = "hunter2 pass", "sodium chloride"

for tool, hint in ((RCLONE, "https://rclone.org/install/"), ("wasmtime", "wasmtime.dev")):
    if shutil.which(tool) is None:
        print(f"SKIP: {tool} not found ({hint})")
        sys.exit(0)
if not WASM.is_file():
    print(f"SKIP: app component not built ({WASM}); cargo component build it or set ENCVOL_APP_WASM")
    sys.exit(0)

WORK = pathlib.Path(tempfile.mkdtemp(prefix="encvol-e2e-"))
FAILED = False


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def req(url, body=None, method=None, headers=None, ok=(200,)):
    r = urllib.request.Request(url, data=json.dumps(body).encode() if body is not None else None,
                               method=method or ("POST" if body is not None else "GET"),
                               headers={"content-type": "application/json", **(headers or {})})
    try:
        with urllib.request.urlopen(r, timeout=30) as resp:
            code, data = resp.status, resp.read()
    except urllib.error.HTTPError as e:
        code, data = e.code, e.read()
    if code not in ok:
        raise AssertionError(f"{r.get_method()} {url} -> {code}: {data[:400]}")
    try:
        return json.loads(data)
    except Exception:
        return data


def check(name, cond, detail=""):
    global FAILED
    print(f"  {'ok' if cond else 'FAIL'}: {name}" + (f" ({detail})" if detail and not cond else ""))
    if not cond:
        FAILED = True
        raise AssertionError(name)


def obscure(s: str) -> str:
    return subprocess.run([RCLONE, "obscure", "-"], input=s.encode(),
                          capture_output=True, check=True).stdout.decode().strip()


def crypt_env(remote: str, password: str, salt: str = "") -> dict:
    env = dict(os.environ, RCLONE_CONFIG="/dev/null",
               RCLONE_CONFIG_ENCVOL_TYPE="crypt", RCLONE_CONFIG_ENCVOL_REMOTE=remote,
               RCLONE_CONFIG_ENCVOL_FILENAME_ENCRYPTION="standard",
               RCLONE_CONFIG_ENCVOL_DIRECTORY_NAME_ENCRYPTION="true")
    env["RCLONE_CONFIG_ENCVOL_PASSWORD"] = obscure(password)
    if salt:
        env["RCLONE_CONFIG_ENCVOL_PASSWORD2"] = obscure(salt)
    return env


def start_manager(name: str, extra_env: dict) -> tuple:
    port = free_port()
    env = dict(os.environ,
               WASM_MANAGER_PORT=str(port), WASM_HOST_IP="127.0.0.1",
               WASM_APPS_DIR=str(WORK / name / "apps"), WASM_FS_DIR=str(WORK / name / "fs"),
               WASM_ENC_DIR=str(WORK / name / "enc"), RCLONE_BIN=shutil.which(RCLONE),
               WASM_LOG_DIR=str(WORK / name / "logs"))
    env.pop("WASM_ENC_LOCAL_SRC", None)
    env.update(extra_env)
    (WORK / name / "apps").mkdir(parents=True)
    shutil.copy(WASM, WORK / name / "apps" / "encvols.wasm")
    proc = subprocess.Popen([sys.executable, str(REPO / "wasm/wasm_manager.py")], env=env,
                            stdout=open(WORK / name / "mgr.log", "wb"), stderr=subprocess.STDOUT)
    base = f"http://127.0.0.1:{port}"
    for _ in range(50):
        time.sleep(0.2)
        try:
            req(base + "/health")
            return proc, base
        except Exception:
            pass
    raise AssertionError(f"manager for {name} never came up (see {WORK / name / 'mgr.log'})")


def wait_settled(status_url, headers=None):
    for _ in range(200):
        time.sleep(0.3)
        st = req(status_url, headers=headers)
        if st["volumes"][0]["status"] not in ("syncing", "pushing"):
            return st["volumes"][0]
    raise AssertionError("volume never settled")


procs = []
try:
    # ---- stage 1: local-backend hook - the full surface ---------------------- #
    print("stage 1: local backend (WASM_ENC_LOCAL_SRC hook)")
    plain = WORK / "plain"; (plain / "sub").mkdir(parents=True)
    (plain / "hello.txt").write_text("top secret payload\n")
    (plain / "sub" / "deep.txt").write_text("nested secret\n")
    (plain / "logo.bin").write_bytes(os.urandom(70_000))
    remote = WORK / "remote"; remote.mkdir()
    env = crypt_env(f"encsrc:{remote}/bucket/vol", PASSWORD, SALT)
    env["RCLONE_CONFIG_ENCSRC_TYPE"] = "local"
    subprocess.run([RCLONE, "sync", str(plain), "encvol:"], env=env, check=True, capture_output=True)
    ciphertext = [p for p in (remote / "bucket" / "vol").rglob("*") if p.is_file()]
    check("client push produced ciphertext", len(ciphertext) == 3)
    check("ciphertext is not plaintext", all(b"top secret" not in p.read_bytes() for p in ciphertext))

    mgr, base = start_manager("s1", {"WASM_ENC_LOCAL_SRC": "1", "SECRET": "ctrl-e2e"})
    procs.append(mgr)
    CTRL = {"X-Vmmgr-Token": "ctrl-e2e"}
    config = {"encVolumes": [{"name": "docs", "endpoint": f"local:{remote}", "bucket": "bucket",
                              "path": "vol", "maxMb": 64}]}
    app_wasm = str(WORK / "s1/apps/encvols.wasm")
    req(base + "/vms", body={"image": app_wasm}, ok=(401,))              # control gate holds
    vm = req(base + "/vms", body={"image": app_wasm, "cpuShare": 0.05,
                                  "config": json.dumps(config)}, headers=CTRL, ok=(201,))
    vid = vm["id"]
    check("launch running (spawned BEFORE unlock)", vm["status"] == "running", str(vm.get("error")))
    check("record lists the volume locked", vm["encVolumes"][0]["status"] == "locked")
    check("no token leak in the public record", "token" not in json.dumps(vm).lower())
    app = f"http://127.0.0.1:{vm['hostPort']}"

    ui = req(app + "/")
    check("UI serves", b"rclone-crypt" in ui)
    st = req(app + "/api/status")
    check("app /api/status proxies (locked)", st["volumes"][0]["status"] == "locked")
    req(base + f"/encvol/{vid}", ok=(401,))                              # tenant plane wants ITS token
    req(base + f"/encvol/{vid}/unlock", body={"name": "docs", "password": "x"}, ok=(401,))

    req(app + "/api/unlock", body={"name": "docs", "password": "WRONG", "salt": SALT}, ok=(202,))
    v = wait_settled(app + "/api/status")
    check("wrong password refused", v["status"] == "locked" and "decrypt" in (v["error"] or ""), json.dumps(v))
    req(app + "/f/docs/hello.txt", ok=(404,))

    req(app + "/api/unlock", body={"name": "docs", "password": PASSWORD, "salt": SALT}, ok=(202,))
    v = wait_settled(app + "/api/status")
    check("unlock succeeded", v["status"] == "unlocked", json.dumps(v))
    check("plaintext readable through the app", req(app + "/f/docs/hello.txt") == b"top secret payload\n")
    check("nested file readable", req(app + "/f/docs/sub/deep.txt") == b"nested secret\n")
    check("/ls sees 3 files", len(req(app + "/ls")["volumes"]["docs"]["files"]) == 3)
    vm2 = req(base + f"/vms/{vid}", headers=CTRL)
    check("public record shows unlocked + bytes",
          vm2["encVolumes"][0]["status"] == "unlocked" and vm2["encVolumes"][0]["bytes"] > 70_000)

    # push-back: a file written into the live preopen roundtrips to the remote.
    # (test hook: the per-deployment token is fished off the tenant's argv)
    (WORK / "s1/enc" / vid / "docs" / "written-in-enclave.txt").write_text("app-written data\n")
    tok = None
    for p in pathlib.Path("/proc").glob("[0-9]*/cmdline"):
        try:
            argv = p.read_bytes().split(b"\0")
        except OSError:
            continue
        if any(a.startswith(b"ENCLAVE_ENC_TOKEN=") for a in argv) and any(b"encvols.wasm" in a for a in argv):
            tok = [a for a in argv if a.startswith(b"ENCLAVE_ENC_TOKEN=")][0].split(b"=", 1)[1].decode()
    check("token found on tenant argv (test hook)", bool(tok))
    BEAR = {"Authorization": f"Bearer {tok}"}
    req(base + f"/encvol/{vid}/sync", body={"name": "docs"}, headers=BEAR, ok=(202,))
    v = wait_settled(base + f"/encvol/{vid}", headers=BEAR)
    check("push completed", v["status"] == "unlocked" and not v["error"], json.dumps(v))
    pulled = WORK / "verify-pull"
    subprocess.run([RCLONE, "sync", "encvol:", str(pulled)], env=env, check=True, capture_output=True)
    check("pushed file decrypts client-side", (pulled / "written-in-enclave.txt").read_text() == "app-written data\n")

    r = req(app + "/api/lock", body={"name": "docs"})
    check("lock wipes", r["status"] == "locked" and not any((WORK / "s1/enc" / vid / "docs").iterdir()))
    req(app + "/f/docs/hello.txt", ok=(404,))
    req(base + f"/vms/{vid}", method="DELETE", headers=CTRL)
    check("teardown removed the enc dir", not (WORK / "s1/enc" / vid).exists())

    for bad, why in [({"encVolumes": [{"name": "UPPER", "endpoint": "https://x", "bucket": "b"}]}, "bad name"),
                     ({"encVolumes": [{"name": "a", "endpoint": "ftp://x", "bucket": "b"}]}, "bad endpoint"),
                     ({"encVolumes": [{"name": "a", "endpoint": "https://10.0.0.1", "bucket": "b"}]}, "SSRF private endpoint"),
                     ({"encVolumes": [{"name": "a", "endpoint": "https://x", "bucket": "b", "maxMb": 999999}]}, "maxMb over ceiling")]:
        vm = req(base + "/vms", body={"image": app_wasm, "cpuShare": 0.05,
                                      "config": json.dumps(bad)}, headers=CTRL, ok=(500,))
        check(f"refused: {why}", vm["status"] == "failed" and "encVolumes" in vm["error"])

    # ---- stage 2: the real S3 protocol (sigv4) over `rclone serve s3` -------- #
    helps = subprocess.run([RCLONE, "serve", "s3", "--help"], capture_output=True)
    if helps.returncode != 0:
        print("stage 2: SKIP (this rclone has no `serve s3`)")
    else:
        print("stage 2: real S3 protocol (rclone serve s3, sigv4 credentials)")
        key, sec = "e2etestaccesskey1234", "e2etestsecretkey5678"
        s3root = WORK / "s3root"; (s3root / "bkt").mkdir(parents=True)
        s3port = free_port()
        s3 = subprocess.Popen([shutil.which(RCLONE), "serve", "s3", str(s3root),
                               "--auth-key", f"{key},{sec}", "--addr", f"127.0.0.1:{s3port}"],
                              env=dict(os.environ, RCLONE_CONFIG="/dev/null"),
                              stdout=open(WORK / "s3.log", "wb"), stderr=subprocess.STDOUT)
        procs.append(s3)
        time.sleep(1.5)
        endpoint = f"http://127.0.0.1:{s3port}"
        env2 = crypt_env("encsrc:bkt/vol", PASSWORD)
        env2.update({"RCLONE_CONFIG_ENCSRC_TYPE": "s3", "RCLONE_CONFIG_ENCSRC_PROVIDER": "Other",
                     "RCLONE_CONFIG_ENCSRC_ENDPOINT": endpoint,
                     "RCLONE_CONFIG_ENCSRC_ACCESS_KEY_ID": key,
                     "RCLONE_CONFIG_ENCSRC_SECRET_ACCESS_KEY": sec})
        subprocess.run([RCLONE, "sync", str(plain), "encvol:"], env=env2, check=True, capture_output=True)
        print("  ok: client pushed over the s3 protocol")

        mgr2, base2 = start_manager("s2", {"SECRET": "ctrl-e2e",
                                           "WASM_ENC_ALLOW_PRIVATE_ENDPOINT": "1"})
        procs.append(mgr2)
        app_wasm2 = str(WORK / "s2/apps/encvols.wasm")
        cfg = {"encVolumes": [{"name": "cloud", "endpoint": endpoint, "bucket": "bkt",
                               "path": "vol", "maxMb": 64}]}
        vm = req(base2 + "/vms", body={"image": app_wasm2, "cpuShare": 0.05,
                                       "config": json.dumps(cfg)}, headers=CTRL, ok=(201,))
        check("launched against a real S3 endpoint", vm["status"] == "running", str(vm.get("error")))
        bad = {"encVolumes": [{"name": "x", "endpoint": "local:/etc", "bucket": "b"}]}
        vm2 = req(base2 + "/vms", body={"image": app_wasm2, "cpuShare": 0.05,
                                        "config": json.dumps(bad)}, headers=CTRL, ok=(500,))
        check("local: endpoint refused in prod posture", "test hook" in vm2["error"])
        app2 = f"http://127.0.0.1:{vm['hostPort']}"
        req(app2 + "/api/unlock", body={"name": "cloud", "password": PASSWORD}, ok=(202,))
        v = wait_settled(app2 + "/api/status")
        check("anonymous unlock fails against a private bucket", v["status"] == "locked" and v["error"])
        req(app2 + "/api/unlock", body={"name": "cloud", "password": PASSWORD,
                                        "accessKeyId": key, "secretAccessKey": sec}, ok=(202,))
        v = wait_settled(app2 + "/api/status")
        check("unlock over real S3 + sigv4", v["status"] == "unlocked", json.dumps(v))
        check("plaintext through the app", req(app2 + "/f/cloud/hello.txt") == b"top secret payload\n")

        # ---- stage 3: wallet-derived keys ------------------------------------ #
        # The backend never sees a wallet - it takes an opaque password. What
        # must hold is the DERIVATION CONTRACT shared by the app's JS and
        # scripts/enclave-encvol.sh: password/salt = sha256(lowercase 0x-sig
        # + "\n" + domain label), over the pinned canonical message. A fixed
        # signature vector stands in for the wallet.
        print("stage 3: wallet-derived keys (signature vector, script <-> reference <-> unlock)")
        script = str(REPO / "scripts/enclave-encvol.sh")
        sig = "0x" + "ab" * 65
        expect_pw = hashlib.sha256((sig + "\nenclave-encvol-v1:password").encode()).hexdigest()
        expect_salt = hashlib.sha256((sig + "\nenclave-encvol-v1:salt").encode()).hexdigest()
        out = subprocess.run([script, "derive", "--sig", sig],
                             capture_output=True, text=True, check=True).stdout
        check("script derive matches the reference derivation", expect_pw in out and expect_salt in out)
        msg = subprocess.run([script, "message", "wvol"], capture_output=True, text=True, check=True).stdout
        check("canonical sign-message is pinned", msg ==
              "Enclave encrypted volume key v1\nvolume: wvol\n\n"
              "Signing derives this volume's encryption key. "
              "Only sign in apps you trust with its contents.\n")

        wplain = WORK / "wplain"; wplain.mkdir()
        (wplain / "wallet.txt").write_text("wallet-gated data\n")
        script_env = dict(os.environ, ENCVOL_WALLET_SIG=sig,
                          AWS_ACCESS_KEY_ID=key, AWS_SECRET_ACCESS_KEY=sec,
                          PATH=str(pathlib.Path(shutil.which(RCLONE)).parent) + os.pathsep + os.environ["PATH"])
        r = subprocess.run([script, "push", str(wplain), "--endpoint", endpoint,
                            "--bucket", "bkt", "--path", "wvol", "--name", "wvol"],
                           env=script_env, capture_output=True, text=True)
        check("script push in wallet mode", r.returncode == 0, r.stderr[-300:])
        check("push snippet advertises wallet unlock", '"unlock": "wallet"' in r.stderr)

        wcfg = {"encVolumes": [{"name": "wvol", "endpoint": endpoint, "bucket": "bkt",
                                "path": "wvol", "unlock": "wallet", "maxMb": 64}]}
        vm = req(base2 + "/vms", body={"image": app_wasm2, "cpuShare": 0.05,
                                       "config": json.dumps(wcfg)}, headers=CTRL, ok=(201,))
        check("wallet volume launches", vm["status"] == "running", str(vm.get("error")))
        check("record carries the UI hints", vm["encVolumes"][0]["unlock"] == "wallet"
              and vm["encVolumes"][0]["keyId"] == "wvol")
        bad = {"encVolumes": [{"name": "x", "endpoint": endpoint, "bucket": "b", "unlock": "retina-scan"}]}
        vm2 = req(base2 + "/vms", body={"image": app_wasm2, "cpuShare": 0.05,
                                        "config": json.dumps(bad)}, headers=CTRL, ok=(500,))
        check("refused: bad unlock mode", "unlock" in vm2["error"])
        app3 = f"http://127.0.0.1:{vm['hostPort']}"
        req(app3 + "/api/unlock", body={"name": "wvol", "password": expect_pw, "salt": expect_salt,
                                        "accessKeyId": key, "secretAccessKey": sec}, ok=(202,))
        v = wait_settled(app3 + "/api/status")
        check("wallet-derived unlock succeeds", v["status"] == "unlocked", json.dumps(v))
        check("wallet-gated plaintext through the app", req(app3 + "/f/wvol/wallet.txt") == b"wallet-gated data\n")

    print("\nALL ENCVOL E2E CHECKS PASSED")
except AssertionError as e:
    print(f"\nFAILED: {e}\n(workdir kept: {WORK})")
    FAILED = True
finally:
    for p in procs:
        p.terminate()
    for p in procs:
        try:
            p.wait(timeout=5)
        except subprocess.TimeoutExpired:
            p.kill()
    if not FAILED:
        shutil.rmtree(WORK, ignore_errors=True)
sys.exit(1 if FAILED else 0)
