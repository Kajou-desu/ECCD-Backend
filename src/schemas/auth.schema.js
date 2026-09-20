import { z } from "zod";

// Schemas check presence/type/basic length only — the existing
// requireEmail() (src/utils/validate.js) still owns the actual email
// format check and canonicalization, so behavior doesn't change.
//
// Upper bounds are here so oversized values are rejected at the boundary
// (RFC 5321 caps an address at 254 characters). New passwords are capped at
// 72 because bcrypt silently ignores everything after 72 bytes — better to
// tell the user than to let them think a longer passphrase is all in use.
// Login's cap is looser (128) so it never locks out an existing account.
const email = z.string().min(1, "Email is required").max(254, "Email is too long");

export const loginSchema = z.object({
  email,
  password: z.string().min(1, "Password is required").max(128, "Password is too long"),
});

export const forgotPasswordSchema = z.object({
  email,
});

export const resetPasswordSchema = z.object({
  email,
  otpCode: z.string().min(1, "OTP code is required").max(12, "OTP code is too long"),
  newPassword: z
    .string()
    .min(10, "Password must be at least 10 characters")
    .max(72, "Password must be at most 72 characters")
    .regex(/[A-Za-z]/, "Password must contain at least one letter")
    .regex(/[0-9]/, "Password must contain at least one number"),
});
