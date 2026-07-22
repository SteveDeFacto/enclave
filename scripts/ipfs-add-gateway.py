#!/usr/bin/env python3
# ipfs-add-gateway.py — validating upload gateway in front of the local Kubo node.
#
# Why this exists: the browser's checks (extension, size, wasm preamble) are UX only
# — anyone can bypass them by POSTing straight to Kubo. So we do NOT expose Kubo's
# /api/v0/add to the internet. Caddy forwards ONLY /add-wasm, /add-json and
# /add-image to this gateway (on 127.0.0.1); the gateway validates the bytes, then
# adds+pins to Kubo with hardcoded params and returns {"cid": ...}. Kubo's API
# stays bound to localhost, and its public /ipfs/* path runs NoFetch behind a
# Caddy handle that adds CSP sandbox + nosniff — nothing this gateway didn't
# admit is servable, and what it serves can't script even opened directly.
#
# Routes:
#   POST /add-wasm  - a wasm component (validated), for app publishing.
#   POST /add-json  - a small JSON object, for deployment config (the console
#                     pins a {"volumes":[...], ...} config and uses the CID as
#                     the deployment's configCid). Enclaves re-verify the CID.
#   POST /add-image - an app thumbnail/banner: raster (magic-checked) or SVG
#                     (strictly validated, see svg_error). Answers {"cid", "svg"}.
#
# Validation tiers:
#   Tier 1 (always): size cap + wasm magic (\0asm) + component *layer* field
#                    (0 = core module -> reject; 1 = component -> ok). Version-proof.
#   Tier 2 (if WASM_TOOLS is set to a `wasm-tools` binary): also run
#                    `wasm-tools validate` — authoritative structural validation.
#
# Pure stdlib, no pip deps. Runs on the VM next to Kubo.
#
# Env:
#   PORT            listen port (default 5051, bound to 127.0.0.1 only)
#   KUBO_API        Kubo API base (default http://127.0.0.1:5001)
#   MAX_WASM_BYTES  hard size cap (default 2147483648 = 2 GiB - models ride inside app wasm)
#   ALLOW_ORIGIN    CORS origin(s) for the browser, comma-separated — the
#                   matching request Origin is echoed back (default
#                   "https://enclave.host,https://nan.host": both work during
#                   a domain transition; trim to one when the old dies)
#   WASM_TOOLS      path to a `wasm-tools` binary to enable Tier 2 (default: off)

import json, os, subprocess, tempfile, urllib.request, uuid, hashlib, hmac, time, re
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT       = int(os.environ.get("PORT", "5051"))
KUBO_API   = os.environ.get("KUBO_API", "http://127.0.0.1:5001").rstrip("/")
MAX_BYTES  = int(os.environ.get("MAX_WASM_BYTES", str(2 * 1024 * 1024 * 1024)))
ORIGINS    = [o.strip().rstrip("/") for o in
              os.environ.get("ALLOW_ORIGIN", "https://enclave.host,https://nan.host").split(",")
              if o.strip()]
WASM_TOOLS = os.environ.get("WASM_TOOLS", "")

# --- signed-upload auth (closes the open-pin storage-DoS) -------------------
# Every pin used to be free: anyone could POST 2 GB to /add-wasm and pin it
# forever (no auth, no cleanup). Now the browser/CLI signs the upload with the
# publisher's WALLET; the api-relay (which has viem) verifies the signature and
# mints an HMAC token bound to (wallet, sha256(bytes), expiry). THIS gateway
# only checks the HMAC (stdlib) + rate-limits by wallet — no EC crypto here, no
# fleet secret. UPLOAD_KEY is a dedicated shared secret with the api-relay (NOT
# the fleet SECRET). Empty UPLOAD_KEY = auth disabled (dev / pre-rollout).
UPLOAD_KEY      = os.environ.get("UPLOAD_KEY", "")
# The per-wallet daily cap must exceed the 2 GB single-upload cap (MAX_BYTES) or a
# legitimate max-size app can never be pinned. 4 GB/wallet allows a full 2 GB app
# plus a retry; 16 GB/day is the fleet-wide backstop.
PER_ADDR_DAILY  = int(os.environ.get("UPLOAD_PER_ADDR_DAILY_BYTES", str(4 * 1024 * 1024 * 1024)))   # 4 GB / wallet / day
GLOBAL_DAILY    = int(os.environ.get("UPLOAD_GLOBAL_DAILY_BYTES", str(16 * 1024 * 1024 * 1024)))    # 16 GB / day fleet-wide
JSON_RL_PER_HR  = int(os.environ.get("ADDJSON_PER_IP_HOURLY", "60"))  # /add-json interim per-IP cap (256 KB each)


def preamble_error(b: bytes):
    """Tier 1: return an error string if the bytes aren't a wasm component, else None."""
    if len(b) < 8:
        return "too small to be a WebAssembly module"
    if b[0:4] != b"\x00asm":
        return "not a WebAssembly file (missing the \\0asm magic bytes)"
    layer = b[6] | (b[7] << 8)   # preamble after magic is version:u16 + layer:u16
    if layer == 0:
        return "this is a core wasm module, but Enclave runs wasi:http components"
    if layer != 1:
        return "unrecognized wasm layer %d — expected a component" % layer
    return None


def wasm_tools_error(data: bytes):
    """Tier 2: authoritative validation via `wasm-tools validate` (if configured)."""
    if not WASM_TOOLS:
        return None
    with tempfile.NamedTemporaryFile(suffix=".wasm") as tf:
        tf.write(data); tf.flush()
        r = subprocess.run([WASM_TOOLS, "validate", "--features", "all", tf.name],
                           capture_output=True, text=True)
        if r.returncode != 0:
            return "wasm validation failed: " + (r.stderr or "").strip()[:200]
    return None


# Cap for /add-json config pins: a deployment config is small (volume names,
# a system prompt, an API key). Keep it well under the wasm cap so this path
# can't be abused to pin large blobs.
MAX_JSON_BYTES = int(os.environ.get("MAX_CONFIG_BYTES", str(256 * 1024)))

# Cap for /add-image pins (app thumbnail + detail banner). Small, wallet-signed
# like /add-wasm; raster, or SVG that passes the strict validator below.
MAX_IMAGE_BYTES = int(os.environ.get("MAX_IMAGE_BYTES", str(4 * 1024 * 1024)))


def raster_kind(b: bytes):
    """The raster format the magic bytes name, or None. Magic-byte sniffing
    (not the filename/content-type) is authoritative."""
    if len(b) < 12:
        return None
    if b[0:8] == b"\x89PNG\r\n\x1a\n":              return "png"
    if b[0:3] == b"\xff\xd8\xff":                   return "jpeg"
    if b[0:6] in (b"GIF87a", b"GIF89a"):            return "gif"
    if b[0:4] == b"RIFF" and b[8:12] == b"WEBP":    return "webp"
    return None


# --- SVG validation (strict, fail-closed) -----------------------------------
# An SVG can carry <script>, event handlers and external references; served
# from this origin and opened directly it would be stored XSS. Policy:
# VALIDATE AND REJECT, never sanitize-and-rewrite (rewriters get beaten by
# parser differentials; a refusal can't). Layers behind this validator:
#   - the site renders media only as CSS background-image / <img>, contexts
#     where browsers never execute SVG scripts or load its external resources;
#   - Caddy serves /ipfs/* with `Content-Security-Policy: sandbox` +
#     X-Content-Type-Options, so a direct navigation can't run script either;
#   - Kubo runs NoFetch, so only bytes THIS validator admitted are servable.
_SVG_NS = "http://www.w3.org/2000/svg"
# script-capable or embedding elements an app image never needs
_SVG_BAD_ELEMENTS = {"script", "foreignobject", "iframe", "embed", "object",
                     "audio", "video", "handler", "listener", "annotation-xml"}
# strip the chars browsers ignore inside URLs before scheme checks
_squeeze = lambda v: re.sub(r"[\x00-\x20]", "", v or "").lower()
_DATA_RASTER = re.compile(r"^data:image/(png|jpe?g|gif|webp);base64,")


def _svg_css_error(css):
    """CSS can't execute script, but url() pulls external resources on direct
    navigation - allow only internal url(#...) targets, no @import."""
    low = _squeeze(css)
    if "@import" in low:
        return "SVG styles must not use @import"
    for m in re.finditer(r"url\(", low):
        rest = low[m.end():].lstrip("'\"")
        if not rest.startswith("#"):
            return "SVG styles may only reference internal url(#...) targets"
    return None


def svg_error(b: bytes):
    """Return an error string unless the bytes are a safe standalone SVG."""
    try:
        text = b.decode("utf-8")
    except UnicodeDecodeError:
        return "SVG must be UTF-8"
    if text[:1] == "\ufeff":
        text = text[1:]
    low = text.lower()
    # DTD machinery enables entity expansion tricks; no image needs it
    if "<!doctype" in low or "<!entity" in low:
        return "SVG must not contain DOCTYPE or entity declarations"
    # processing instructions: only the leading <?xml declaration is allowed
    # (<?xml-stylesheet?> attaches external CSS on direct navigation)
    for m in re.finditer(r"<\?", text):
        if m.start() == 0 and re.match(r"<\?xml[\s?]", text):
            continue
        return "SVG must not contain processing instructions"
    import xml.etree.ElementTree as ET
    try:
        root = ET.fromstring(text)
    except Exception as e:  # noqa: BLE001
        return "SVG is not well-formed XML: %s" % str(e)[:120]
    if root.tag != "{%s}svg" % _SVG_NS:
        return "the root element must be <svg> in the SVG namespace"
    for el in root.iter():
        if not isinstance(el.tag, str):
            return "SVG contains a node the validator cannot inspect"
        if not el.tag.startswith("{%s}" % _SVG_NS):
            return "SVG must not embed non-SVG-namespace elements"
        local = el.tag.rsplit("}", 1)[1].lower()
        if local in _SVG_BAD_ELEMENTS:
            return "SVG must not contain <%s> elements" % local
        for name, val in el.attrib.items():
            lname = name.rsplit("}", 1)[-1].lower()
            if lname.startswith("on"):
                return "SVG must not carry event-handler attributes (%s)" % lname[:32]
            sval = _squeeze(val)
            # scheme check on EVERY value: catches animated/indirect targets too
            # (ElementTree hands us entity-DECODED values, so &#106;avascript
            # tricks are already unfolded here)
            if "javascript:" in sval or "vbscript:" in sval:
                return "SVG must not reference script URLs"
            if lname == "href":
                if not (sval.startswith("#") or _DATA_RASTER.match(sval)):
                    return "SVG references must be internal (#id) or embedded raster data: URIs"
            if lname == "attributename" and sval in ("href", "xlink:href"):
                return "SVG must not animate href attributes"
            if lname == "style":
                err = _svg_css_error(val)
                if err:
                    return err
        if local == "style":
            err = _svg_css_error("".join(el.itertext()))
            if err:
                return err
    return None


def image_error(b: bytes):
    """(kind, error): kind "png"/"jpeg"/"gif"/"webp"/"svg" when accepted."""
    kind = raster_kind(b)
    if kind:
        return kind, None
    head = b[:512].lstrip(b"\xef\xbb\xbf \t\r\n").lower()
    if head.startswith(b"<?xml") or head.startswith(b"<svg") or b"<svg" in head:
        err = svg_error(b)
        return ("svg", None) if err is None else (None, err)
    return None, "unsupported image type - use PNG, JPEG, WebP, GIF, or SVG"


def kubo_add(data: bytes, filename="app.wasm"):
    """Add+pin to the local Kubo node with fixed params; return the CID."""
    boundary = "----enclavewasm" + uuid.uuid4().hex
    pre = ("--%s\r\nContent-Disposition: form-data; name=\"file\"; filename=\"%s\"\r\n"
           "Content-Type: application/octet-stream\r\n\r\n" % (boundary, filename)).encode()
    post = ("\r\n--%s--\r\n" % boundary).encode()
    req = urllib.request.Request(
        KUBO_API + "/api/v0/add?cid-version=1&pin=true",
        data=pre + data + post, method="POST",
        headers={"Content-Type": "multipart/form-data; boundary=" + boundary})
    with urllib.request.urlopen(req, timeout=180) as r:
        text = r.read().decode()
    last = json.loads(text.strip().splitlines()[-1])
    return last.get("Hash") or last.get("Cid") or last.get("cid")


# In-memory daily byte counters (reset at UTC midnight). A process restart
# resets them, which only an operator can trigger — not an attacker — so this is
# an adequate abuse bound without a datastore.
_usage = {"day": None, "global": 0, "addr": {}}


def _reserve_bytes(address, nbytes):
    """Reserve nbytes against the per-wallet + global daily caps. (ok, reason)."""
    day = time.strftime("%Y-%m-%d", time.gmtime())
    if _usage["day"] != day:
        _usage.update(day=day, **{"global": 0}); _usage["addr"] = {}
    if _usage["global"] + nbytes > GLOBAL_DAILY:
        return False, "fleet daily upload limit reached; retry tomorrow"
    used = _usage["addr"].get(address, 0)
    if used + nbytes > PER_ADDR_DAILY:
        return False, "this wallet's daily upload limit reached; retry tomorrow"
    _usage["global"] += nbytes
    _usage["addr"][address] = used + nbytes
    return True, None


def upload_auth_error(headers, data):
    """/add-wasm gate: verify the wallet-signed HMAC token the api-relay minted,
    bound to sha256(data). Returns (code, msg) on failure, or None when OK (or
    when UPLOAD_KEY is unset = auth disabled). Reserves the bytes on success."""
    if not UPLOAD_KEY:
        return None
    address = (headers.get("X-Upload-Address") or "").strip().lower()
    expiry  = (headers.get("X-Upload-Expiry") or "").strip()
    token   = (headers.get("X-Upload-Token") or "").strip().lower()
    if not (address and expiry and token):
        return (401, "signed upload required: connect your wallet and retry (the console/CLI signs the upload)")
    if not re.match(r"^0x[0-9a-f]{40}$", address):
        return (401, "bad upload address")
    try:
        exp = int(expiry)
    except ValueError:
        return (401, "bad upload expiry")
    now = int(time.time())
    if exp < now:
        return (401, "upload authorization expired; retry")
    if exp > now + 900:
        return (401, "upload authorization expiry too far in the future")
    h = hashlib.sha256(data).hexdigest()
    expected = hmac.new(UPLOAD_KEY.encode(), ("%s:%s:%d" % (address, h, exp)).encode(),
                        hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected, token):
        return (403, "upload authorization does not cover these bytes")
    ok, why = _reserve_bytes(address, len(data))
    if not ok:
        return (429, why)
    return None


_json_rl = {}   # ip -> (tokens, last_ts): interim per-IP bucket for the (small) /add-json path


def json_pin_rate_ok(ip):
    now = time.time()
    cap = float(JSON_RL_PER_HR); refill = JSON_RL_PER_HR / 3600.0
    tok, last = _json_rl.get(ip, (cap, now))
    tok = min(cap, tok + (now - last) * refill)
    if tok < 1:
        _json_rl[ip] = (tok, now); return False
    _json_rl[ip] = (tok - 1, now); return True


class Handler(BaseHTTPRequestHandler):
    def _client_ip(self):
        xff = (self.headers.get("X-Forwarded-For") or "").split(",")[0].strip()
        return xff or self.client_address[0]

    def _cors(self):
        # echo the request Origin when it's on the allowlist (a response can
        # carry only ONE allow-origin value); Vary so caches keep them apart
        origin = (self.headers.get("Origin") or "").rstrip("/")
        self.send_header("Access-Control-Allow-Origin",
                         origin if origin in ORIGINS else ORIGINS[0])
        self.send_header("Vary", "Origin")
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers",
                         "content-type, x-upload-address, x-upload-expiry, x-upload-token")

    def _json(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self._cors()
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204); self._cors(); self.end_headers()

    def do_GET(self):
        return self._json(200 if self.path == "/healthz" else 404,
                          {"ok": True} if self.path == "/healthz" else {"error": "not found"})

    def do_POST(self):
        route = self.path.split("?")[0]
        if route not in ("/add-wasm", "/add-json", "/add-image"):
            return self._json(404, {"error": "not found"})
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            return self._json(411, {"error": "Content-Length required"})
        cap = MAX_JSON_BYTES if route == "/add-json" else MAX_IMAGE_BYTES if route == "/add-image" else MAX_BYTES
        if length > cap:
            return self._json(413, {"error": "too large (max %d bytes)" % cap})
        data = self.rfile.read(length)
        if len(data) != length:
            return self._json(400, {"error": "short read"})

        # /add-json: pin a deployment config (must be a JSON OBJECT). The
        # enclave re-fetches + hash-verifies it, so this is UX/availability,
        # not trust - but validate the shape so a bad pin fails here.
        if route == "/add-json":
            if not json_pin_rate_ok(self._client_ip()):
                return self._json(429, {"error": "too many config pins from your network; retry shortly"})
            try:
                obj = json.loads(data.decode("utf-8"))
            except Exception as e:
                return self._json(415, {"error": "not valid UTF-8 JSON: %s" % e})
            if not isinstance(obj, dict):
                return self._json(415, {"error": "config must be a JSON object"})
            try:
                cid = kubo_add(data, filename="config.json")
            except Exception as e:  # noqa: BLE001
                return self._json(502, {"error": "ipfs add failed: %s" % e})
            return self._json(200, {"cid": cid}) if cid else self._json(502, {"error": "ipfs returned no CID"})

        # /add-image: app thumbnail/banner. Wallet-signed like /add-wasm (same
        # token, same per-wallet daily byte cap); raster by magic bytes, or SVG
        # through the strict validator. "svg": true tells the uploader to store
        # the _media flag its renderers need (SVG only displays with an exact
        # image/svg+xml content-type, which the ?filename=i.svg param buys).
        if route == "/add-image":
            auth = upload_auth_error(self.headers, data)
            if auth:
                return self._json(auth[0], {"error": auth[1]})
            kind, err = image_error(data)
            if err:
                return self._json(415, {"error": err})
            try:
                cid = kubo_add(data, filename="image.svg" if kind == "svg" else "image")
            except Exception as e:  # noqa: BLE001
                return self._json(502, {"error": "ipfs add failed: %s" % e})
            return self._json(200, {"cid": cid, "svg": kind == "svg"}) if cid else self._json(502, {"error": "ipfs returned no CID"})

        # signed-upload gate (see upload_auth_error): wallet-authorized + rate-limited
        auth = upload_auth_error(self.headers, data)
        if auth:
            return self._json(auth[0], {"error": auth[1]})
        err = preamble_error(data) or wasm_tools_error(data)
        if err:
            return self._json(415, {"error": err})
        try:
            cid = kubo_add(data)
        except Exception as e:  # noqa: BLE001 — surface any upstream failure to the client
            return self._json(502, {"error": "ipfs add failed: %s" % e})
        if not cid:
            return self._json(502, {"error": "ipfs returned no CID"})
        return self._json(200, {"cid": cid})

    def log_message(self, *a):  # quiet; systemd/journal captures stdout if needed
        pass


if __name__ == "__main__":
    print("wasm add-gateway on 127.0.0.1:%d -> %s%s" %
          (PORT, KUBO_API, " (wasm-tools on)" if WASM_TOOLS else " (header-only)"), flush=True)
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
