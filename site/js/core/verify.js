/* ============================================================
   Live in-browser enclave verification (@tinfoilsh/verifier).
   Shared core for the Overview attest widget and the Deploy
   page's per-deployment console badge. Runs the full client-side
   check: hardware report → vendor cert chain → silicon root of
   trust, Sigstore provenance of the release, measurement
   comparison, certificate binding, in THIS browser, cached per
   enclave+repo for the session. (The verifier follows whatever
   report the enclave presents; today's fleet presents AMD
   SEV-SNP + NVIDIA CC, and Intel TDX quotes verify the same
   way should a host land on Intel silicon.) The API's
   verification.selfCheck is the enclave running the same steps
   on itself; this is the version that actually carries trust.
   ============================================================ */
// Same-origin, version-pinned bundle of @tinfoilsh/verifier (built by
// scripts/build-vendor.mjs -> site/vendor/verifier.js, served from our own IPFS
// pin behind Caddy TLS). This is deliberately NOT an esm.sh import: the whole
// product is "✓ verify it yourself in your browser", so the verifier code MUST
// come from the same origin as the page — a third-party CDN with no integrity
// pin could return code that reports verified:true for anything.
export const LV_VERIFIER_URL = "/vendor/verifier.js";

// verification pointers: new shape (verification) with fallback to the
// pre-selfCheck field name (verify) so older enclaves still work.
export const vspecOf = (att) => (att && (att.verification || att.verify)) || null;

// Flavor-aware verification. The stock Verifier compares against the repo's
// single "latest" GitHub release (our GPU flavor carries that tag); a CPU or
// gpu8 enclave measures differently and would always fail compareMeasurements.
// Fast-path latest, then - only on a mismatch - probe the SAME version's
// sibling-flavor tags (vX.Y.Z-cpu / -gpu8) and verify against whichever signed
// release the enclave's own measurement matches. Security is unchanged: every
// candidate's provenance is still Sigstore-verified inside verifyBundle. The
// github-proxy whitelists only /releases/latest, the tinfoil.hash download and
// /attestations, so we probe known tags rather than enumerate. This MIRRORS
// verifyMatchingRelease in supervisor.js (the enclave's own self-check).
const GITHUB_PROXY = "https://github-proxy.tinfoil.sh";
async function verifyMatchingRelease(mod, host, repo) {
  const base = await mod.assembleAttestationBundle(host, repo);
  const attempt = async (digest, sigstoreBundle) => {
    const v = new mod.Verifier({ configRepo: repo });
    try { await v.verifyBundle({ ...base, digest, sigstoreBundle }); } catch (e) { /* recorded on the doc */ }
    return v.getVerificationDocument();
  };
  const latest = await attempt(base.digest, base.sigstoreBundle);
  if (latest && latest.securityVerified) return latest;
  let latestTag;
  try { latestTag = (await (await fetch(`${GITHUB_PROXY}/repos/${repo}/releases/latest`)).json()).tag_name; } catch (e) {}
  for (const suffix of (latestTag ? ["-cpu", "-gpu8"] : [])) {
    const tag = latestTag + suffix;
    let digest, sigstoreBundle;
    try {
      const hr = await fetch(`${GITHUB_PROXY}/${repo}/releases/download/${tag}/tinfoil.hash`);
      if (!hr.ok) continue;
      digest = (await hr.text()).trim();
      const at = await (await fetch(`${GITHUB_PROXY}/repos/${repo}/attestations/sha256:${digest}`)).json();
      sigstoreBundle = at && at.attestations && at.attestations[0] && at.attestations[0].bundle;
    } catch (e) { continue; }
    if (!digest || !sigstoreBundle) continue;
    const doc = await attempt(digest, sigstoreBundle);
    if (doc && doc.securityVerified) return doc;
  }
  return latest;
}

// The ONLY repo a green "verified" result may attest to. The attestation JSON
// is server-supplied, so its verification.repo is UNTRUSTED input: we verify
// against this build-time constant, never against whatever the endpoint claims.
// (Sigstore provenance is anchored here too - see verifyMatchingRelease.)
const EXPECTED_REPO = "EnclaveHost/enclave";

const _encVerifyCache = new Map();     // "host|repo" -> Promise<{ok, doc, repo, host, error}>
export function verifyEnclaveInBrowser(vspec) {
  const claimed = vspec && vspec.repo;
  const ep = vspec && vspec.attestationEndpoint;
  if (!claimed || !ep) return Promise.reject(new Error("attestation is missing verification.repo / attestationEndpoint"));
  const host = new URL(ep).host;
  // Verify against our own constant, not the enclave's claimed repo.
  let repo = EXPECTED_REPO;
  const key = host + "|" + repo;
  // If the enclave attests to some OTHER repo, refuse a green result outright -
  // whatever its self-attestation says, that isn't the code we ship.
  if (String(claimed).toLowerCase() !== EXPECTED_REPO.toLowerCase())
    return Promise.resolve({ ok: false, doc: null, repo: EXPECTED_REPO, host,
      error: "enclave attests to an unexpected repo (" + claimed + "); expected " + EXPECTED_REPO });
  if (!_encVerifyCache.has(key)) _encVerifyCache.set(key, (async () => {
    // Sigstore compares the repo string verbatim against the signing cert's
    // GitHubWorkflowRepository claim, so normalize EXPECTED_REPO to GitHub's
    // canonical casing (anchored to our constant, not the server's value).
    try { const gh = await fetch("https://api.github.com/repos/" + repo); if (gh.ok) repo = (await gh.json()).full_name || repo; } catch (e) {}
    const mod = await import(LV_VERIFIER_URL);
    let doc = null, failure = null;
    try { doc = await verifyMatchingRelease(mod, host, repo); } catch (e) { failure = e; }
    const err = (doc && doc.securityVerified) ? null
              : (doc && doc.steps && doc.steps.compareMeasurements && doc.steps.compareMeasurements.error)
              || (failure && (failure.message || String(failure))) || "verification failed";
    const res = { ok: !!(doc && doc.securityVerified), doc, repo, host, error: err };
    if (!res.ok) _encVerifyCache.delete(key);          // don't cache failures: allow retry
    return res;
  })().catch((e) => { _encVerifyCache.delete(key); throw e; }));
  return _encVerifyCache.get(key);
}
