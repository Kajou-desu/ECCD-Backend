import { z } from "zod";

// Schemas check presence/type/basic length only — the existing
// requireEmail() (src/utils/validate.js) still owns the actual email
// format check and canonicalization, so behavior doesn't change.
export const loginSchema = z.object({
  email: z.string().min(1, "Email is required"),
  password: z.string().min(1, "Password is required"),
});

export const forgotPasswordSchema = z.object({
  email: z.string().min(1, "Email is required"),
});

export const resetPasswordSchema = z.object({
  email: z.string().min(1, "Email is required"),
  otpCode: z.string().min(1, "OTP code is required"),
  newPassword: z.string().min(10, "Password must be at least 10 characters"),
});
