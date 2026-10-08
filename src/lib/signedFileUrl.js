import crypto from "node:crypto";
import path from "node:path";

const DEFAULT_TTL_MS = 60 * 60 * 1000; // 1 hour — long enough for a normal
// viewing session, short enough to meaningfully limit exposure if a URL
// leaks (browser history, logs, referrer headers, screenshots).

// Student documents (birth certificates, IDs, medical papers) are far more
// sensitive than photos, and a link to one is only ever needed for the moment
// someone opens it. The app asks for a fresh link at that moment (see
// GET /students/:id/documents/:documentId/link), so five minutes is plenty
// and shrinks the window in which a leaked link — browser history, a pasted
// URL, a screenshot — is useful from an hour to five minutes.
export const DOCUMENT_URL_TTL_MS = 5 * 60 * 1000;

// Expiry is rounded UP to a 5-minute boundary. With a raw Date.now() + ttl,
// every API response minted a different exp/sig for the same file, so the
// browser saw a new URL each time and its cache (Cache-Control: max-age=300)
// almost never hit. Within a window the URL is now identical. A link lives
// between ttl and ttl + 5 min, never less than the ttl it was asked for.
// Skipped for short custom TTLs, which exist to expire quickly.
const EXPIRY_BUCKET_MS = 5 * 60 * 1000;

function expiryFor(ttlMs) {
  const exp = Date.now() + ttlMs;
  return ttlMs >= EXPIRY_BUCKET_MS ? Math.ceil(exp / EXPIRY_BUCKET_MS) * EXPIRY_BUCKET_MS : exp;
}

// Origin used in file links. PUBLIC_API_URL (e.g. https://api.example.com) wins
// when set: req.protocol/Host depend on the proxy setup, and a wrong
// "trust proxy" hop count yields http:// links that the frontend's CSP
// img-src would block. Falls back to the request when unset or not a valid
// http(s) URL.
function publicBase(req) {
  const configured = process.env.PUBLIC_API_URL;
  if (configured) {
    try {
      const url = new URL(configured);
      if (url.protocol === "https:" || url.protocol === "http:") return url.origin;
    } catch {
      /* invalid value: fall through to the request-derived origin */
    }
  }
  return `${req.protocol}://${req.get("host")}`;
}

// `sensitive` is part of what is signed. A sensitive link therefore can't be
// turned into an ordinary one by deleting `s=1` (the signature stops
// matching), and an ordinary link can't be upgraded either — the file route
// decides how to serve a file (no caching for documents) from a flag the
// client cannot alter.
function sign(filename, exp, sensitive = false) {
  // Namespaced (":file-url") so this reuses JWT_SECRET without letting a
  // signed file URL be replayed as, or forged from, a JWT — same secret,
  // different derivation context.
  return crypto
    .createHmac("sha256", `${process.env.JWT_SECRET}:file-url`)
    .update(sensitive ? `${filename}:${exp}:s` : `${filename}:${exp}`)
    .digest("hex");
}

// Turns a stored value into a fresh, time-limited signed URL. Accepts
// either a bare filename (what new uploads store) or a full URL from
// before this fix (path.basename() extracts the filename identically
// either way) — no data migration needed for existing rows.
//
// Called at *read* time, every time an entity is serialized for a
// response, so a copied/leaked link only works for a limited window
// instead of forever, without changing what's stored in the database.
//
// { sensitive: true } is for documents: exact expiry (no cache window, since
// these responses are never cached) and a flag the file route uses to serve
// them with Cache-Control: no-store.
export function signFileUrl(req, storedValue, ttlMs = DEFAULT_TTL_MS, { sensitive = false } = {}) {
  if (!storedValue) return storedValue;
  const filename = path.basename(storedValue);
  const exp = sensitive ? Date.now() + ttlMs : expiryFor(ttlMs);
  const sig = sign(filename, exp, sensitive);
  return `${publicBase(req)}/api/files/${filename}?exp=${exp}&sig=${sig}${sensitive ? "&s=1" : ""}`;
}

// Verifies the ?exp=&sig= query params attached by signFileUrl above.
// filename must already be the sanitized path.basename() of the request
// param — this function only checks the signature/expiry, not path safety.
export function verifyFileSignature(filename, exp, sig, sensitive = false) {
  if (typeof sig !== "string" || !sig) return false;

  const expNum = Number(exp);
  if (!Number.isFinite(expNum) || expNum < Date.now()) return false;

  const expected = sign(filename, expNum, sensitive);
  const provided = Buffer.from(sig);
  const wanted = Buffer.from(expected);

  // Constant-time comparison — a naive === leaks timing information an
  // attacker could use to guess the signature byte by byte.
  if (provided.length !== wanted.length) return false;
  return crypto.timingSafeEqual(provided, wanted);
}
