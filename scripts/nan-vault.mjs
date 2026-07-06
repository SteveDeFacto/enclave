// nan-vault - the cryptographic protocol for wallet-gated encrypted volumes.
//
// Shared foundation for: the client (browser wallet UI + this CLI), the enclave
// (unseal + serve), and the NanVolumeAccess contract (stores pubkeys + sealed
// VEKs). Every party implements THIS scheme, so it is the single source of
// truth for the wire formats. Pure @noble (audited, browser + node identical).
//
// Trust model (see nan-encrypted-volumes memory): a volume is encrypted once
// with a symmetric VEK. Access is governed by an on-chain ACL of wallets; each
// authorized wallet holds the VEK SEALED to its X25519 key. Keys are DERIVED
// from a deterministic wallet signature (no deprecated eth_decrypt; works with
// any wallet). The enclave has its own attested X25519 identity; a member seals
// the VEK to the enclave so it can decrypt in-RAM and serve. Neither the
// operator nor Tinfoil ever holds the VEK.
//
// CLI:
//   nan-vault key <sigHex>                       -> X25519 pubkey derived from a wallet signature
//   nan-vault pack <dir> <out> [--vek <hex>]     -> encrypt a volume (prints VEK + plaintext sha256)
//   nan-vault unpack <in> <dir> --vek <hex>      -> decrypt a volume
//   nan-vault seal <vekHex> <recipientPubHex>    -> seal the VEK to a member/enclave pubkey
//   nan-vault unseal <sealedHex> --sig <sigHex>  -> unseal the VEK with your wallet-derived key
//   nan-vault unseal <sealedHex> --secret <hex>  -> unseal with a raw X25519 secret (enclave)
//   nan-vault enclave-id                          -> generate a fresh enclave X25519 identity (sk, pk)
//
// The derivation message the wallet signs (personal_sign) is DERIVE_MESSAGE.

import { x25519 } from "@noble/curves/ed25519";
import { xchacha20poly1305 } from "@noble/ciphers/chacha";
import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha2";
import { randomBytes } from "@noble/hashes/utils";

const VOL_MAGIC = new TextEncoder().encode("NANVOL1");   // volume ciphertext header
const enc = new TextEncoder();
const hex = (u8) => Buffer.from(u8).toString("hex");
const unhex = (s) => new Uint8Array(Buffer.from(String(s).replace(/^0x/, ""), "hex"));

// The exact message a wallet signs (personal_sign) to derive its vault key.
// One key per wallet, reused across volumes. Domain-separated + explicit that it
// authorizes NO transaction, so a signing prompt is unambiguous.
export const DERIVE_MESSAGE =
  "NaN Vault key derivation v1\n\nSign to derive your encrypted-volume access key. " +
  "This authorizes NO transaction and moves no funds.";

// --- key derivation --------------------------------------------------------- //
// deterministic ECDSA (RFC-6979) means the same wallet+message => the same
// signature => the same key. Pass the raw 65-byte signature bytes.
export function deriveKeypair(signatureBytes) {
  const seed = hkdf(sha256, signatureBytes, enc.encode("nan-vault/x25519/v1"), new Uint8Array(0), 32);
  const publicKey = x25519.getPublicKey(seed);
  return { secretKey: seed, publicKey };
}

// --- volume encryption (symmetric, VEK) ------------------------------------- //
export function newVEK() { return randomBytes(32); }

export function encryptVolume(plaintext, vek) {
  const nonce = randomBytes(24);
  const ct = xchacha20poly1305(vek, nonce).encrypt(plaintext);
  const out = new Uint8Array(VOL_MAGIC.length + 24 + ct.length);
  out.set(VOL_MAGIC, 0); out.set(nonce, VOL_MAGIC.length); out.set(ct, VOL_MAGIC.length + 24);
  return out;
}

export function decryptVolume(blob, vek) {
  if (blob.length < VOL_MAGIC.length + 24 + 16 ||
      !VOL_MAGIC.every((b, i) => blob[i] === b))
    throw new Error("not a nan-vault volume (bad header)");
  const nonce = blob.subarray(VOL_MAGIC.length, VOL_MAGIC.length + 24);
  const ct = blob.subarray(VOL_MAGIC.length + 24);
  return xchacha20poly1305(vek, nonce).decrypt(ct);   // throws on wrong key / tamper (AEAD tag)
}

// --- sealing the VEK to an X25519 public key (anonymous sender) -------------- //
// sealed = ephPub(32) || nonce(24) || AEAD(VEK). The AEAD key binds both
// pubkeys, so a sealed blob is only openable by the intended recipient.
export function seal(vek, recipientPub) {
  const ephSk = x25519.utils.randomSecretKey ? x25519.utils.randomSecretKey() : x25519.utils.randomPrivateKey();
  const ephPub = x25519.getPublicKey(ephSk);
  const shared = x25519.getSharedSecret(ephSk, recipientPub);
  const key = hkdf(sha256, shared, concat(ephPub, recipientPub), enc.encode("nan-vault/seal/v1"), 32);
  const nonce = randomBytes(24);
  const ct = xchacha20poly1305(key, nonce).encrypt(vek);
  return concat(ephPub, nonce, ct);
}

export function unseal(sealed, recipientSecret) {
  const ephPub = sealed.subarray(0, 32);
  const nonce = sealed.subarray(32, 56);
  const ct = sealed.subarray(56);
  const recipientPub = x25519.getPublicKey(recipientSecret);
  const shared = x25519.getSharedSecret(recipientSecret, ephPub);
  const key = hkdf(sha256, shared, concat(ephPub, recipientPub), enc.encode("nan-vault/seal/v1"), 32);
  return xchacha20poly1305(key, nonce).decrypt(ct);
}

function concat(...arrs) {
  const n = arrs.reduce((s, a) => s + a.length, 0);
  const out = new Uint8Array(n); let o = 0;
  for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
}

// --------------------------------------------------------------------------- //
// CLI (node). The library above is what the browser + enclave import.
// --------------------------------------------------------------------------- //
async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const flag = (name) => { const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] : null; };
  const { execFileSync } = await import("node:child_process");
  const fs = await import("node:fs");

  if (cmd === "key") {
    if (!rest[0]) throw new Error("usage: key <sigHex>");
    console.log("0x" + hex(deriveKeypair(unhex(rest[0])).publicKey));
  } else if (cmd === "enclave-id") {
    const sk = x25519.utils.randomSecretKey ? x25519.utils.randomSecretKey() : x25519.utils.randomPrivateKey();
    console.log("secret 0x" + hex(sk));
    console.log("public 0x" + hex(x25519.getPublicKey(sk)));
  } else if (cmd === "pack") {
    const [dir, out] = rest;
    if (!dir || !out) throw new Error("usage: pack <dir> <out> [--vek <hex>]");
    const vek = flag("--vek") ? unhex(flag("--vek")) : newVEK();
    const tar = execFileSync("tar", ["--sort=name", "--mtime=@0", "--owner=0", "--group=0",
      "--numeric-owner", "-cf", "-", "-C", dir, "."], { maxBuffer: 1 << 30 });
    const plainSha = hex(sha256(tar));
    fs.writeFileSync(out, Buffer.from(encryptVolume(new Uint8Array(tar), vek)));
    console.error(`packed ${dir} -> ${out}`);
    console.log("VEK 0x" + hex(vek));
    console.log("plaintext_sha256 " + plainSha);
  } else if (cmd === "unpack") {
    const [inp, dir] = rest;
    const vek = flag("--vek");
    if (!inp || !dir || !vek) throw new Error("usage: unpack <in> <dir> --vek <hex>");
    const tar = Buffer.from(decryptVolume(new Uint8Array(fs.readFileSync(inp)), unhex(vek)));
    fs.mkdirSync(dir, { recursive: true });
    execFileSync("tar", ["-xf", "-", "-C", dir], { input: tar });
    console.log("plaintext_sha256 " + hex(sha256(new Uint8Array(tar))));
  } else if (cmd === "seal") {
    const [vek, pub] = rest;
    if (!vek || !pub) throw new Error("usage: seal <vekHex> <recipientPubHex>");
    console.log("0x" + hex(seal(unhex(vek), unhex(pub))));
  } else if (cmd === "unseal") {
    const sealed = rest[0];
    const secret = flag("--secret") ? unhex(flag("--secret"))
                 : flag("--sig") ? deriveKeypair(unhex(flag("--sig"))).secretKey : null;
    if (!sealed || !secret) throw new Error("usage: unseal <sealedHex> (--sig <sigHex> | --secret <hex>)");
    console.log("VEK 0x" + hex(unseal(unhex(sealed), secret)));
  } else {
    console.error("commands: key | enclave-id | pack | unpack | seal | unseal");
    process.exit(2);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error("nan-vault:", e.message); process.exit(1); });
}
