import crypto from "node:crypto";

// After this many wrong guesses an OTP is dead, even before it expires —
// a 6-digit code must not be guessable by brute force within its lifetime.
export const MAX_OTP_ATTEMPTS = 5;

// Plain !== leaks timing info proportional to how many leading digits
// match. Codes are always fixed-length so a length check first is safe;
// timingSafeEqual then compares the rest in constant time.
export function otpMatches(candidate, expected) {
  const candidateBuf = Buffer.from(String(candidate ?? ""));
  const expectedBuf = Buffer.from(String(expected));
  if (candidateBuf.length !== expectedBuf.length) return false;
  return crypto.timingSafeEqual(candidateBuf, expectedBuf);
}
