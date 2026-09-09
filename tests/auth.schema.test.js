import { describe, it, expect } from "vitest";
import { resetPasswordSchema } from "../src/schemas/auth.schema.js";
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
