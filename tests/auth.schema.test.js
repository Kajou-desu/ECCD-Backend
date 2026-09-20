import { describe, it, expect } from "vitest";
import { resetPasswordSchema, loginSchema } from "../src/schemas/auth.schema.js";
import { emailRateLimitKey } from "../src/middleware/rateLimit.js";

describe("resetPasswordSchema", () => {
  const base = { email: "user@example.com", otpCode: "123456" };

  it("accepts a password with letters and numbers, 10+ chars", () => {
    const result = resetPasswordSchema.safeParse({ ...base, newPassword: "newpassword123" });
    expect(result.success).toBe(true);
  });

  it("rejects a password under 10 characters", () => {
    const result = resetPasswordSchema.safeParse({ ...base, newPassword: "abc12345" });
    expect(result.success).toBe(false);
  });

  it("rejects a letters-only password", () => {
    const result = resetPasswordSchema.safeParse({ ...base, newPassword: "onlylettersnodigits" });
    expect(result.success).toBe(false);
  });

  it("rejects a digits-only password", () => {
    const result = resetPasswordSchema.safeParse({ ...base, newPassword: "1234567890" });
    expect(result.success).toBe(false);
  });
});

describe("length bounds", () => {
  it("rejects a new password over bcrypt's 72-byte limit rather than silently truncating it", () => {
    const result = resetPasswordSchema.safeParse({
      email: "user@example.com",
      otpCode: "123456",
      newPassword: `a1${"x".repeat(71)}`,
    });
    expect(result.success).toBe(false);
  });

  it("rejects an oversized email and an oversized login password", () => {
    expect(loginSchema.safeParse({ email: `${"a".repeat(250)}@x.co`, password: "pw" }).success).toBe(false);
    expect(loginSchema.safeParse({ email: "a@b.co", password: "x".repeat(129) }).success).toBe(false);
  });

  it("still accepts a normal login", () => {
    expect(loginSchema.safeParse({ email: "a@b.co", password: "whatever-existing-password" }).success).toBe(true);
  });
});

describe("emailRateLimitKey", () => {
  it("lowercases and trims the request body's email", () => {
    const req = { body: { email: "  User@Example.com  " } };
    expect(emailRateLimitKey(req)).toBe("user@example.com");
  });

  it("falls back to a constant key when no email is present", () => {
    expect(emailRateLimitKey({ body: {} })).toBe("unknown");
    expect(emailRateLimitKey({ body: undefined })).toBe("unknown");
  });
});
