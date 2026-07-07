/* ============================================================
   Live in-browser enclave verification (@tinfoilsh/verifier).
   Shared core for the Overview attest widget and the Deploy
   page's per-deployment console badge. Runs the full client-side
   check: AMD SEV-SNP report → VCEK → AMD root, Sigstore
   provenance of the release, measurement comparison, certificate
   binding, in THIS browser, cached per enclave+repo for the
   session. The API's verification.selfCheck is the enclave
   running the same steps on itself; this is the version that
   actually carries trust.
   ============================================================ */
export const LV_VERIFIER_URL = "https://esm.sh/@tinfoilsh/verifier@1.1.7?bundle";

// verification pointers: new shape (verification) with fallback to the
// pre-selfCheck field name (verify) so older enclaves still work.
export const vspecOf = (att) => (att && (att.verification || att.verify)) || null;

const _encVerifyCache = new Map();     // "host|repo" -> Promise<{ok, doc, repo, host, error}>
export function verifyEnclaveInBrowser(vspec) {
  let repo = vspec && vspec.repo;
  const ep = vspec && vspec.attestationEndpoint;
  if (!repo || !ep) return Promise.reject(new Error("attestation is missing verification.repo / attestationEndpoint"));
  const host = new URL(ep).host, key = host + "|" + repo;
  if (!_encVerifyCache.has(key)) _encVerifyCache.set(key, (async () => {
    // Sigstore compares the repo string verbatim against the signing cert's
    // GitHubWorkflowRepository claim, so normalize to GitHub's canonical casing.
    try { const gh = await fetch("https://api.github.com/repos/" + repo); if (gh.ok) repo = (await gh.json()).full_name || repo; } catch (e) {}
    const mod = await import(LV_VERIFIER_URL);
    const v = new mod.Verifier({ serverURL: "https://" + host, configRepo: repo });
    let failure = null;
    try { await v.verify(); } catch (e) { failure = e; }
    const doc = v.getVerificationDocument();
    const res = { ok: !!(doc && doc.securityVerified), doc, repo, host,
                  error: failure ? (failure.message || String(failure)) : null };
    if (!res.ok) _encVerifyCache.delete(key);          // don't cache failures: allow retry
    return res;
  })().catch((e) => { _encVerifyCache.delete(key); throw e; }));
  return _encVerifyCache.get(key);
}
