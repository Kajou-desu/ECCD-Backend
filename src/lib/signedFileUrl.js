import crypto from "node:crypto";
import path from "node:path";

const DEFAULT_TTL_MS = 60 * 60 * 1000; // 1 hour — long enough for a normal
// viewing session, short enough to meaningfully limit exposure if a URL
// leaks (browser history, logs, referrer headers, screenshots).

function sign(filename, exp) {
  // Namespaced (":file-url") so this reuses JWT_SECRET without letting a
  // signed file URL be replayed as, or forged from, a JWT — same secret,
  // different derivation context.
  return crypto
    .createHmac("sha256", `${process.env.JWT_SECRET}:file-url`)
    .update(`${filename}:${exp}`)
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
export function signFileUrl(req, storedValue, ttlMs = DEFAULT_TTL_MS) {
  if (!storedValue) return storedValue;
  const filename = path.basename(storedValue);
  const exp = Date.now() + ttlMs;
  const sig = sign(filename, exp);
  return `${req.protocol}://${req.get("host")}/api/files/${filename}?exp=${exp}&sig=${sig}`;
}

// Verifies the ?exp=&sig= query params attached by signFileUrl above.
// filename must already be the sanitized path.basename() of the request
// param — this function only checks the signature/expiry, not path safety.
export function verifyFileSignature(filename, exp, sig) {
  if (typeof sig !== "string" || !sig) return false;

  const expNum = Number(exp);
  if (!Number.isFinite(expNum) || expNum < Date.now()) return false;

  const expected = sign(filename, expNum);
  const provided = Buffer.from(sig);
  const wanted = Buffer.from(expected);

  // Constant-time comparison — a naive === leaks timing information an
  // attacker could use to guess the signature byte by byte.
  if (provided.length !== wanted.length) return false;
  return crypto.timingSafeEqual(provided, wanted);
}
