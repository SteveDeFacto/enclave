// enclave-vault - the cryptographic protocol for wallet-gated encrypted volumes.
//
// Shared foundation for: the client (browser wallet UI + this CLI), the enclave
// (unseal + serve), and the EnclaveVolumeAccess contract (stores pubkeys + sealed
// VEKs). Every party implements THIS scheme, so it is the single source of
// truth for the wire formats. Pure @noble (audited, browser + node identical).
//
// Trust model: a volume is encrypted once
// with a symmetric VEK. Access is governed by an on-chain ACL of wallets; each
// authorized wallet holds the VEK SEALED to its X25519 key. Keys are DERIVED
// from a deterministic wallet signature (no deprecated eth_decrypt; works with
// any wallet). The enclave has its own attested X25519 identity; a member seals
// the VEK to the enclave so it can decrypt in-RAM and serve. Neither the
// operator nor Tinfoil ever holds the VEK.
//
// CLI:
//   enclave-vault key <sigHex>                       -> X25519 pubkey derived from a wallet signature
//   enclave-vault pack <dir> <out> [--vek <hex>]     -> encrypt a volume (prints VEK + plaintext sha256)
//   enclave-vault unpack <in> <dir> --vek <hex>      -> decrypt a volume
//   enclave-vault pack-blocks <dir> <outdir> [--vek <hex>] [--block <bytes>]
//                                                 -> LARGE tier: block-encrypted cipherdir (NANVOL2);
//                                                    prints VEK + manifest sha256 (pin THAT in the config)
//   enclave-vault unpack-blocks <cipherdir> <outdir> --vek <hex>
//   enclave-vault seal <vekHex> <recipientPubHex>    -> seal the VEK to a member/enclave pubkey
//   enclave-vault unseal <sealedHex> --sig <sigHex>  -> unseal the VEK with your wallet-derived key
//   enclave-vault unseal <sealedHex> --secret <hex>  -> unseal with a raw X25519 secret (enclave)
//   enclave-vault enclave-id                          -> generate a fresh enclave X25519 identity (sk, pk)
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

// A fresh X25519 identity (the enclave's per-boot vault identity: generated
// inside the CVM, held only in RAM, gone on restart - which is exactly the
// failover story: nothing sealed to a dead enclave is ever usable again).
export function newIdentity() {
  const secretKey = x25519.utils.randomSecretKey ? x25519.utils.randomSecretKey() : x25519.utils.randomPrivateKey();
  return { secretKey, publicKey: x25519.getPublicKey(secretKey) };
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
    throw new Error("not a enclave-vault volume (bad header)");
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

// --- NANVOL2: block-encrypted cipherdir (the LARGE tier) --------------------- //
// The whole-blob NANVOL1 format must be decrypted in one piece into RAM, which
// caps it at a few GB. NANVOL2 is the same trust model with RANDOM ACCESS and
// NO privileged anything: a directory of per-file blobs, each file split into
// fixed-size blocks, each block AEAD-sealed independently. The enclave decrypts
// only the blocks a reader touches (a bounded LRU of plaintext blocks in CVM
// RAM) - gocryptfs semantics, implemented in userspace above the filesystem, so
// it needs no FUSE, no device-mapper, no mounts, no capabilities at all.
//
// Layout of a cipherdir:
//   nanvault.json   public envelope {format:"nanvol2", blockSize, files, manifest}
//   manifest.nvm    NANVOL1 blob (encryptVolume of the manifest JSON with the VEK)
//   b/000001.nvb…   per-file blobs: block i = XChaCha20-Poly1305(fileKey, nonce(i),
//                   chunk) stored as ct||tag at offset i*(blockSize+16)
//
// manifest JSON: {version:1, blockSize, packId, files:[{p: path, s: size, b: blob}]}
//
// Splice-resistance: fileKey = HKDF(VEK, salt=packId, info="nan-vault/file/v1:"+blob)
// - unique per (pack, blob) - and the nonce is the block index, so blocks cannot
// be swapped across files, reordered within a file, or transplanted from another
// pack of the same volume (fresh random packId every pack). Truncation/extension
// is caught by the manifest's per-file size, and the manifest itself is sealed
// under the VEK and pinned by the deployment config's sha256 (of its PLAINTEXT).
// Delivered over Modelwrap, dm-verity additionally pins every ciphertext byte.
// What leaks: file COUNT and SIZES (not names/contents) - pad upstream if that matters.
export const BLOCK_SIZE_DEFAULT = 4 * 1024 * 1024;   // 4 MiB: ~ms to decrypt, 16B tag overhead
const BLOCK_TAG = 16;

export function blockFileKey(vek, packId, blobName) {
  return hkdf(sha256, vek, packId, enc.encode("nan-vault/file/v1:" + blobName), 32);
}
export function blockNonce(i) {
  const n = new Uint8Array(24);
  new DataView(n.buffer).setBigUint64(0, BigInt(i), true);   // LE64(index) || 16 zero bytes
  return n;
}
export const sealBlock = (fileKey, i, chunk) => xchacha20poly1305(fileKey, blockNonce(i)).encrypt(chunk);
export const openBlock = (fileKey, i, block) => xchacha20poly1305(fileKey, blockNonce(i)).decrypt(block);

// Encrypt a directory tree into a NANVOL2 cipherdir. Node-only (fs); the
// browser/enclave use the block helpers above. Returns the manifest plaintext
// (pin its sha256 in the deployment config) - the VEK seals everything else.
export async function packBlocks(srcDir, outDir, vek, blockSize = BLOCK_SIZE_DEFAULT) {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : 1)
    .flatMap((e) => {
      const p = path.join(d, e.name);
      if (e.isDirectory()) return walk(p);
      if (e.isFile() && !e.isSymbolicLink()) return [p];
      console.error(`pack-blocks: skipping non-regular file ${p}`);
      return [];
    });
  const packId = randomBytes(16);
  fs.mkdirSync(path.join(outDir, "b"), { recursive: true });
  const files = [];
  for (const abs of walk(srcDir)) {
    const rel = path.relative(srcDir, abs).split(path.sep).join("/");
    const blob = `b/${String(files.length + 1).padStart(6, "0")}.nvb`;
    const key = blockFileKey(vek, packId, blob);
    const size = fs.statSync(abs).size;
    const inFd = fs.openSync(abs, "r"), outFd = fs.openSync(path.join(outDir, blob), "w");
    const buf = Buffer.alloc(blockSize);
    for (let i = 0, off = 0; off < size; i++, off += blockSize) {   // 0-byte file = 0 blocks
      const n = fs.readSync(inFd, buf, 0, Math.min(blockSize, size - off), off);
      fs.writeSync(outFd, sealBlock(key, i, new Uint8Array(buf.buffer, 0, n)));
    }
    fs.closeSync(inFd); fs.closeSync(outFd);
    files.push({ p: rel, s: size, b: blob });
  }
  const manifest = JSON.stringify({ version: 1, blockSize, packId: hex(packId), files });
  fs.writeFileSync(path.join(outDir, "manifest.nvm"), Buffer.from(encryptVolume(enc.encode(manifest), vek)));
  fs.writeFileSync(path.join(outDir, "nanvault.json"), JSON.stringify(
    { format: "nanvol2", blockSize, files: files.length, manifest: "manifest.nvm" }, null, 2) + "\n");
  return manifest;
}

// Decrypt a NANVOL2 cipherdir back into a directory tree (verification tool).
export async function unpackBlocks(cipherDir, outDir, vek) {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const manifest = JSON.parse(new TextDecoder().decode(
    decryptVolume(new Uint8Array(fs.readFileSync(path.join(cipherDir, "manifest.nvm"))), vek)));
  for (const f of manifest.files) {
    const key = blockFileKey(vek, unhex(manifest.packId), f.b);
    const dst = path.join(outDir, f.p);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    const inBuf = fs.readFileSync(path.join(cipherDir, f.b));
    const out = fs.openSync(dst, "w");
    const per = manifest.blockSize + BLOCK_TAG;
    for (let i = 0; i * per < inBuf.length; i++)
      fs.writeSync(out, openBlock(key, i, new Uint8Array(inBuf.subarray(i * per, Math.min((i + 1) * per, inBuf.length)))));
    fs.closeSync(out);
    if (fs.statSync(dst).size !== f.s) throw new Error(`${f.p}: size mismatch after decrypt`);
  }
  return manifest.files.length;
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
    const id = newIdentity();
    console.log("secret 0x" + hex(id.secretKey));
    console.log("public 0x" + hex(id.publicKey));
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
  } else if (cmd === "pack-blocks") {
    const [dir, out] = rest;
    if (!dir || !out) throw new Error("usage: pack-blocks <dir> <outdir> [--vek <hex>] [--block <bytes>]");
    const vek = flag("--vek") ? unhex(flag("--vek")) : newVEK();
    const blockSize = flag("--block") ? parseInt(flag("--block"), 10) : BLOCK_SIZE_DEFAULT;
    const manifest = await packBlocks(dir, out, vek, blockSize);
    console.error(`packed ${dir} -> ${out} (${JSON.parse(manifest).files.length} files, ${blockSize}B blocks)`);
    console.log("VEK 0x" + hex(vek));
    console.log("manifest_sha256 " + hex(sha256(enc.encode(manifest))));
  } else if (cmd === "unpack-blocks") {
    const [inp, dir] = rest;
    const vek = flag("--vek");
    if (!inp || !dir || !vek) throw new Error("usage: unpack-blocks <cipherdir> <outdir> --vek <hex>");
    console.log(`decrypted ${await unpackBlocks(inp, dir, unhex(vek))} files -> ${dir}`);
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
  main().catch((e) => { console.error("enclave-vault:", e.message); process.exit(1); });
}
