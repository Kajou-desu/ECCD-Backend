import crypto from "node:crypto";

// After this many wrong guesses an OTP is dead, even before it expires —
// a 6-digit code must not be guessable by brute force within its lifetime.
export const MAX_OTP_ATTEMPTS = 5;

// Only this keyed hash is stored in the otpCode column, never the code: a
// database leak must not hand out live reset codes. Namespaced (":otp") so
// reusing JWT_SECRET can't produce values that collide with a JWT or a
// signed file URL — same approach as lib/signedFileUrl.js. Output is 64 hex
// characters.
export function hashOtp(code) {
  return crypto
    .createHmac("sha256", `${process.env.JWT_SECRET}:otp`)
    .update(String(code ?? ""))
    .digest("hex");
}

// Compares the HMAC of the submitted code with the stored hash in constant
// time. Both are fixed-length hex digests, so the length check can't leak
// anything about the code itself.
export function otpMatches(candidate, expectedHash) {
  const candidateBuf = Buffer.from(hashOtp(candidate));
  const expectedBuf = Buffer.from(String(expectedHash));
  if (candidateBuf.length !== expectedBuf.length) return false;
  return crypto.timingSafeEqual(candidateBuf, expectedBuf);
}
