import crypto from "node:crypto";

// Gateway keys look like "<id>.<64 hex chars>". The id lets the server load the
// one candidate row directly; the secret half is 256 random bits, so a plain
// SHA-256 of it is the right storage form (a slow password hash is for
// low-entropy human passwords, not for this). Only the hash is stored.

const KEY_RE = /^(\d{1,9})\.([0-9a-f]{64})$/;

export function generateSecret() {
  return crypto.randomBytes(32).toString("hex");
}

export function hashSecret(secret) {
  return crypto.createHash("sha256").update(secret).digest("hex");
}

export function formatDeviceKey(id, secret) {
  return `${id}.${secret}`;
}

// Returns { id, secret } or null. Strict on purpose: anything that isn't
// exactly this shape is rejected before touching the database.
export function parseDeviceKey(raw) {
  if (typeof raw !== "string") return null;
  const match = KEY_RE.exec(raw);
  if (!match) return null;
  const id = Number(match[1]);
  return id > 0 ? { id, secret: match[2] } : null;
}

// Constant-time comparison of hash(secret) against the stored hash.
export function secretMatches(secret, storedHash) {
  const a = Buffer.from(hashSecret(secret), "hex");
  const b = Buffer.from(typeof storedHash === "string" ? storedHash : "", "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
