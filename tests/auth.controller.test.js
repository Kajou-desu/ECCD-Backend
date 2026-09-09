import { describe, it, expect, vi, beforeEach } from "vitest";
import bcrypt from "bcryptjs";

process.env.JWT_SECRET = "test-secret-at-least-32-characters-long";

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    user: { findUnique: vi.fn(), update: vi.fn() },
    passwordResetOtp: { create: vi.fn(), findFirst: vi.fn(), updateMany: vi.fn() },
  },
}));
vi.mock("../src/lib/mailer.js", () => ({
  sendOtpEmail: vi.fn(),
}));

const { prisma } = await import("../src/lib/prisma.js");
const { sendOtpEmail } = await import("../src/lib/mailer.js");
const { login, forgotPassword, resetPassword } = await import(
  "../src/controllers/auth.controller.js"
);

function mockRes() {
  const res = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("login", () => {
  it("returns a token for valid credentials", async () => {
    const passwordHash = await bcrypt.hash("correct-horse", 10);
    prisma.user.findUnique.mockResolvedValue({
      id: 1,
      email: "user@example.com",
      name: "User",
      role: "Admin",
      isActive: true,
      passwordHash,
      tokenVersion: 0,
    });

    const req = { body: { email: "User@Example.com", password: "correct-horse" } };
    const res = mockRes();
    const next = vi.fn();

    await login(req, res, next);

    // Looked up by the canonicalized (lowercased) email, not the raw input.
    expect(prisma.user.findUnique).toHaveBeenCalledWith({
      where: { email: "user@example.com" },
    });
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ token: expect.any(String) })
    );
    expect(next).not.toHaveBeenCalled();
  });

  it("returns generic 401 for a wrong password (no user-enumeration hint)", async () => {
    const passwordHash = await bcrypt.hash("correct-horse", 10);
    prisma.user.findUnique.mockResolvedValue({
      id: 1,
      email: "user@example.com",
      isActive: true,
      passwordHash,
      tokenVersion: 0,
    });

    const req = { body: { email: "user@example.com", password: "wrong" } };
    const res = mockRes();
    await login(req, res, vi.fn());

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ message: "Invalid credentials" });
  });

  it("returns the same generic 401 for a non-existent user", async () => {
    prisma.user.findUnique.mockResolvedValue(null);

    const req = { body: { email: "nobody@example.com", password: "whatever" } };
    const res = mockRes();
    await login(req, res, vi.fn());

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ message: "Invalid credentials" });
  });

  it("rejects a deactivated account even with the correct password", async () => {
    const passwordHash = await bcrypt.hash("correct-horse", 10);
    prisma.user.findUnique.mockResolvedValue({
      id: 1,
      email: "user@example.com",
      isActive: false,
      passwordHash,
      tokenVersion: 0,
    });

    const req = { body: { email: "user@example.com", password: "correct-horse" } };
    const res = mockRes();
    await login(req, res, vi.fn());

    expect(res.status).toHaveBeenCalledWith(401);
  });
});

describe("forgotPassword", () => {
  it("responds 200 without sending an OTP when the email doesn't exist (no enumeration)", async () => {
    prisma.user.findUnique.mockResolvedValue(null);

    const req = { body: { email: "nobody@example.com" } };
    const res = mockRes();
    await forgotPassword(req, res, vi.fn());

    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining("If the email exists") })
    );
    expect(sendOtpEmail).not.toHaveBeenCalled();
  });

  it("creates an OTP and emails it when the user exists", async () => {
    prisma.user.findUnique.mockResolvedValue({ id: 1, email: "user@example.com" });

    const req = { body: { email: "user@example.com" } };
    const res = mockRes();
    await forgotPassword(req, res, vi.fn());

    expect(prisma.passwordResetOtp.create).toHaveBeenCalledOnce();
    expect(sendOtpEmail).toHaveBeenCalledWith("user@example.com", expect.stringMatching(/^\d{6}$/));
  });
});

describe("resetPassword", () => {
  it("rejects an invalid or already-used OTP", async () => {
    prisma.passwordResetOtp.findFirst.mockResolvedValue(null);

    const req = {
      body: { email: "user@example.com", otpCode: "000000", newPassword: "newpassword123" },
    };
    const res = mockRes();
    await resetPassword(req, res, vi.fn());

    expect(res.status).toHaveBeenCalledWith(400);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it("rejects an expired OTP", async () => {
    prisma.passwordResetOtp.findFirst.mockResolvedValue({
      expiresAt: new Date(Date.now() - 1000),
    });

    const req = {
      body: { email: "user@example.com", otpCode: "123456", newPassword: "newpassword123" },
    };
    const res = mockRes();
    await resetPassword(req, res, vi.fn());

    expect(res.status).toHaveBeenCalledWith(400);
  });

  it("updates the password and consumes all outstanding OTPs on success", async () => {
    prisma.passwordResetOtp.findFirst.mockResolvedValue({
      expiresAt: new Date(Date.now() + 10 * 60 * 1000),
    });

    const req = {
      body: { email: "user@example.com", otpCode: "123456", newPassword: "newpassword123" },
    };
    const res = mockRes();
    await resetPassword(req, res, vi.fn());

    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { email: "user@example.com" },
      data: expect.objectContaining({ tokenVersion: { increment: 1 } }),
    });
    expect(prisma.passwordResetOtp.updateMany).toHaveBeenCalledWith({
      where: { email: "user@example.com", isUsed: false },
      data: { isUsed: true },
    });
    expect(res.json).toHaveBeenCalledWith({ message: "Password reset successful" });
  });
});
