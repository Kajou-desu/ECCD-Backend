import { describe, it, expect, vi, beforeEach } from "vitest";

process.env.JWT_SECRET = "test-secret-at-least-32-characters-long";

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    accountActionOtp: { updateMany: vi.fn(), create: vi.fn() },
  },
}));
vi.mock("../src/lib/mailer.js", () => ({ sendOtpEmail: vi.fn() }));

const { prisma } = await import("../src/lib/prisma.js");
const { sendOtpEmail } = await import("../src/lib/mailer.js");
const { hashOtp, otpMatches } = await import("../src/utils/otp.js");
const { requestPasswordChangeOtp } = await import("../src/controllers/users.controller.js");

beforeEach(() => vi.clearAllMocks());

describe("hashOtp / otpMatches", () => {
  it("produces a 64-char hex HMAC that is not the code and is deterministic", () => {
    const hash = hashOtp("123456");
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain("123456");
    expect(hashOtp("123456")).toBe(hash);
    expect(hashOtp("123457")).not.toBe(hash);
  });

  it("matches the right code against the stored hash and rejects the rest", () => {
    const stored = hashOtp("123456");
    expect(otpMatches("123456", stored)).toBe(true);
    expect(otpMatches("654321", stored)).toBe(false);
    expect(otpMatches(undefined, stored)).toBe(false);
    // A plaintext "stored" value (pre-migration row) never matches.
    expect(otpMatches("123456", "123456")).toBe(false);
  });

  it("is keyed by JWT_SECRET", () => {
    const before = hashOtp("123456");
    const original = process.env.JWT_SECRET;
    process.env.JWT_SECRET = "a-different-secret-that-is-32-chars-long";
    try {
      expect(hashOtp("123456")).not.toBe(before);
    } finally {
      process.env.JWT_SECRET = original;
    }
  });
});

describe("account action OTP storage", () => {
  it("stores only the hash and emails the plaintext code", async () => {
    prisma.user.findUnique.mockResolvedValue({ id: 3, email: "a@example.com" });
    const res = { json: vi.fn() };

    await requestPasswordChangeOtp({ user: { id: 3 } }, res, vi.fn());

    const emailed = sendOtpEmail.mock.calls[0][1];
    expect(emailed).toMatch(/^\d{6}$/);
    const stored = prisma.accountActionOtp.create.mock.calls[0][0].data.otpCode;
    expect(stored).toBe(hashOtp(emailed));
    expect(stored).not.toBe(emailed);
  });
});
