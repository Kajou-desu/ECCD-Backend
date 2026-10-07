import { describe, it, expect, vi, beforeEach } from "vitest";
import bcrypt from "bcryptjs";

process.env.JWT_SECRET = "test-secret-at-least-32-characters-long";

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    user: { findUnique: vi.fn(), update: vi.fn() },
    accountActionOtp: { deleteMany: vi.fn() },
    // resetPassword runs its consume + password update inside one
    // transaction; passing `prisma` as `tx` keeps every mock below in play.
    $transaction: vi.fn((callback) => callback(prisma)),
    passwordResetOtp: {
      create: vi.fn(),
      findFirst: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
  },
}));
vi.mock("../src/lib/mailer.js", () => ({
  sendOtpEmail: vi.fn(),
  sendAttendanceEmail: vi.fn(),
}));

const { prisma } = await import("../src/lib/prisma.js");
const { sendOtpEmail, sendAttendanceEmail } = await import("../src/lib/mailer.js");
const { hashOtp } = await import("../src/utils/otp.js");
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
  prisma.passwordResetOtp.findFirst.mockReset();
  sendAttendanceEmail.mockResolvedValue(undefined);
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

  it("returns the *previous* lastLoginAt, then updates it to now", async () => {
    const passwordHash = await bcrypt.hash("correct-horse", 10);
    const previousLogin = new Date("2026-01-01T00:00:00.000Z");
    prisma.user.findUnique.mockResolvedValue({
      id: 1,
      email: "user@example.com",
      name: "User",
      role: "Admin",
      isActive: true,
      passwordHash,
      tokenVersion: 0,
      createdAt: new Date("2025-01-01T00:00:00.000Z"),
      lastLoginAt: previousLogin,
    });

    const req = { body: { email: "user@example.com", password: "correct-horse" } };
    const res = mockRes();
    const next = vi.fn();

    await login(req, res, next);

    // The response shows the login *before* this one, not the one just now
    // — so the user can notice unrecognized access.
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        user: expect.objectContaining({ lastLoginAt: previousLogin }),
      }),
    );

    // The DB is updated to the current login for next time.
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { lastLoginAt: expect.any(Date) },
    });
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

  it("still runs a bcrypt comparison for an unknown email (no timing-based enumeration)", async () => {
    prisma.user.findUnique.mockResolvedValue(null);
    const compareSpy = vi.spyOn(bcrypt, "compare");

    const req = { body: { email: "nobody@example.com", password: "whatever" } };
    await login(req, mockRes(), vi.fn());

    expect(compareSpy).toHaveBeenCalledTimes(1);
    compareSpy.mockRestore();
  });

  it("never issues a token for an unknown email", async () => {
    prisma.user.findUnique.mockResolvedValue(null);

    const res = mockRes();
    await login({ body: { email: "nobody@example.com", password: "whatever" } }, res, vi.fn());

    expect(res.json).not.toHaveBeenCalledWith(expect.objectContaining({ token: expect.anything() }));
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

  it("creates an OTP and emails it when the user exists, storing only its HMAC", async () => {
    prisma.user.findUnique.mockResolvedValue({ id: 1, email: "user@example.com", isActive: true });

    const req = { body: { email: "user@example.com" } };
    const res = mockRes();
    await forgotPassword(req, res, vi.fn());

    expect(prisma.passwordResetOtp.create).toHaveBeenCalledOnce();
    const code = sendOtpEmail.mock.calls[0][1];
    expect(sendOtpEmail).toHaveBeenCalledWith("user@example.com", expect.stringMatching(/^\d{6}$/));
    const stored = prisma.passwordResetOtp.create.mock.calls[0][0].data.otpCode;
    expect(stored).toBe(hashOtp(code));
    expect(stored).not.toBe(code);
  });

  it("sends the response before any DB lookup, so registered and unknown emails answer alike", async () => {
    const order = [];
    prisma.user.findUnique.mockImplementation(async () => {
      order.push("lookup");
      return null;
    });
    const res = mockRes();
    res.json.mockImplementation(() => {
      order.push("respond");
      return res;
    });

    await forgotPassword({ body: { email: "user@example.com" } }, res, vi.fn());

    expect(order).toEqual(["respond", "lookup"]);
  });

  it("issues no OTP for a disabled account but gives the same generic response", async () => {
    prisma.user.findUnique.mockResolvedValue({ id: 1, email: "user@example.com", isActive: false });

    const res = mockRes();
    await forgotPassword({ body: { email: "user@example.com" } }, res, vi.fn());

    expect(res.json).toHaveBeenCalledWith({ message: "If the email exists, an OTP was sent" });
    expect(prisma.passwordResetOtp.create).not.toHaveBeenCalled();
    expect(sendOtpEmail).not.toHaveBeenCalled();
  });

  it("retires earlier unused codes so only the newest one is valid", async () => {
    prisma.user.findUnique.mockResolvedValue({ id: 1, email: "user@example.com", isActive: true });

    await forgotPassword({ body: { email: "user@example.com" } }, mockRes(), vi.fn());

    expect(prisma.passwordResetOtp.updateMany).toHaveBeenCalledWith({
      where: { email: "user@example.com", isUsed: false },
      data: { isUsed: true },
    });
  });

  it("does not issue a new code within the resend cooldown, and answers the same", async () => {
    prisma.user.findUnique.mockResolvedValue({ id: 1, email: "user@example.com", isActive: true });
    prisma.passwordResetOtp.findFirst.mockResolvedValue({ createdAt: new Date(Date.now() - 10_000) });

    const res = mockRes();
    await forgotPassword({ body: { email: "user@example.com" } }, res, vi.fn());

    expect(prisma.passwordResetOtp.create).not.toHaveBeenCalled();
    expect(sendOtpEmail).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith({ message: "If the email exists, an OTP was sent" });
  });

  it("issues a new code once the cooldown has passed", async () => {
    prisma.user.findUnique.mockResolvedValue({ id: 1, email: "user@example.com", isActive: true });
    prisma.passwordResetOtp.findFirst.mockResolvedValue({ createdAt: new Date(Date.now() - 61_000) });

    await forgotPassword({ body: { email: "user@example.com" } }, mockRes(), vi.fn());

    expect(prisma.passwordResetOtp.create).toHaveBeenCalledOnce();
  });

  it("answers 200 (not 500) when the email provider fails, so failures don't reveal which emails exist", async () => {
    prisma.user.findUnique.mockResolvedValue({ id: 1, email: "user@example.com", isActive: true });
    sendOtpEmail.mockRejectedValueOnce(new Error("SMTP down"));

    const res = mockRes();
    const next = vi.fn();
    await forgotPassword({ body: { email: "user@example.com" } }, res, next);
    await new Promise((resolve) => setImmediate(resolve)); // let the swallowed rejection settle

    expect(next).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining("If the email exists") })
    );
  });
});

describe("resetPassword", () => {
  const futureExpiry = () => new Date(Date.now() + 10 * 60 * 1000);
  const goodRecord = (overrides = {}) => ({
    id: 7,
    otpCode: hashOtp("123456"),
    attempts: 0,
    expiresAt: futureExpiry(),
    ...overrides,
  });

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
    prisma.passwordResetOtp.findFirst.mockResolvedValue(
      goodRecord({ expiresAt: new Date(Date.now() - 1000) })
    );

    const req = {
      body: { email: "user@example.com", otpCode: "123456", newPassword: "newpassword123" },
    };
    const res = mockRes();
    await resetPassword(req, res, vi.fn());

    expect(res.status).toHaveBeenCalledWith(400);
  });

  it("claims an attempt before comparing, and a wrong code does not reset the password", async () => {
    prisma.passwordResetOtp.findFirst.mockResolvedValue(goodRecord());
    prisma.passwordResetOtp.updateMany.mockResolvedValue({ count: 1 });

    const req = {
      body: { email: "user@example.com", otpCode: "000000", newPassword: "newpassword123" },
    };
    const res = mockRes();
    await resetPassword(req, res, vi.fn());

    expect(res.status).toHaveBeenCalledWith(400);
    expect(prisma.passwordResetOtp.updateMany).toHaveBeenCalledWith({
      where: { id: 7, isUsed: false, attempts: { lt: 5 } },
      data: { attempts: { increment: 1 } },
    });
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it("locks an OTP after too many wrong guesses — even the correct code is refused", async () => {
    prisma.passwordResetOtp.findFirst.mockResolvedValue(goodRecord({ attempts: 5 }));

    const req = {
      body: { email: "user@example.com", otpCode: "123456", newPassword: "newpassword123" },
    };
    const res = mockRes();
    await resetPassword(req, res, vi.fn());

    expect(res.status).toHaveBeenCalledWith(400);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it("refuses a guess when parallel requests already used up the attempts (claim matches no row)", async () => {
    // Every request read attempts=0, but the conditional UPDATE only admits 5.
    prisma.passwordResetOtp.findFirst.mockResolvedValue(goodRecord());
    prisma.passwordResetOtp.updateMany.mockResolvedValue({ count: 0 });

    const res = mockRes();
    await resetPassword(
      { body: { email: "user@example.com", otpCode: "123456", newPassword: "newpassword123" } },
      res,
      vi.fn(),
    );

    expect(res.status).toHaveBeenCalledWith(400);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it("refuses a code that was already consumed by a concurrent request", async () => {
    prisma.passwordResetOtp.findFirst.mockResolvedValue(goodRecord());
    // 1st updateMany = claim the attempt, 2nd = consume (already used elsewhere)
    prisma.passwordResetOtp.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });

    const res = mockRes();
    await resetPassword(
      { body: { email: "user@example.com", otpCode: "123456", newPassword: "newpassword123" } },
      res,
      vi.fn(),
    );

    expect(res.status).toHaveBeenCalledWith(400);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it("updates the password and consumes all outstanding OTPs on success", async () => {
    prisma.passwordResetOtp.findFirst.mockResolvedValue(goodRecord());
    prisma.passwordResetOtp.updateMany.mockResolvedValue({ count: 1 });
    prisma.user.update.mockResolvedValue({ id: 1 });

    const res = mockRes();
    await resetPassword(
      { body: { email: "user@example.com", otpCode: "123456", newPassword: "newpassword123" } },
      res,
      vi.fn(),
    );

    expect(prisma.$transaction).toHaveBeenCalledOnce();
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { email: "user@example.com" },
      data: expect.objectContaining({ tokenVersion: { increment: 1 } }),
      select: { id: true },
    });
    // Pending password-change / account-deletion codes die with the reset.
    expect(prisma.accountActionOtp.deleteMany).toHaveBeenCalledWith({ where: { userId: 1 } });
    // Heads-up email goes out, fire-and-forget.
    expect(sendAttendanceEmail).toHaveBeenCalledWith(
      "user@example.com",
      expect.stringContaining("password was changed"),
      expect.any(String),
    );
    expect(prisma.passwordResetOtp.updateMany).toHaveBeenCalledWith({
      where: { email: "user@example.com", isUsed: false },
      data: { isUsed: true },
    });
    expect(prisma.$transaction).toHaveBeenCalledOnce();
    expect(res.json).toHaveBeenCalledWith({ message: "Password reset successful" });
  });

  it("answers 400 (not 500) and rolls back when the account no longer exists", async () => {
    prisma.passwordResetOtp.findFirst.mockResolvedValue(goodRecord());
    prisma.passwordResetOtp.updateMany.mockResolvedValue({ count: 1 });
    prisma.user.update.mockRejectedValue(Object.assign(new Error("gone"), { code: "P2025" }));

    const res = mockRes();
    const next = vi.fn();
    await resetPassword(
      { body: { email: "user@example.com", otpCode: "123456", newPassword: "newpassword123" } },
      res,
      next,
    );

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ message: "Invalid or expired OTP" });
    expect(sendAttendanceEmail).not.toHaveBeenCalled();
  });

  it("passes unexpected database errors to the error handler, not to the client", async () => {
    prisma.passwordResetOtp.findFirst.mockResolvedValue(goodRecord());
    prisma.passwordResetOtp.updateMany.mockResolvedValue({ count: 1 });
    prisma.user.update.mockRejectedValue(new Error("connection lost"));

    const next = vi.fn();
    await resetPassword(
      { body: { email: "user@example.com", otpCode: "123456", newPassword: "newpassword123" } },
      mockRes(),
      next,
    );

    expect(next).toHaveBeenCalledOnce();
  });

  it("still succeeds when the password-changed email fails to send", async () => {
    prisma.passwordResetOtp.findFirst.mockResolvedValue(goodRecord());
    prisma.passwordResetOtp.updateMany.mockResolvedValue({ count: 1 });
    prisma.user.update.mockResolvedValue({ id: 1 });
    sendAttendanceEmail.mockRejectedValue(new Error("SMTP down"));

    const res = mockRes();
    const next = vi.fn();
    await resetPassword(
      { body: { email: "user@example.com", otpCode: "123456", newPassword: "newpassword123" } },
      res,
      next,
    );
    await new Promise((resolve) => setImmediate(resolve));

    expect(next).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith({ message: "Password reset successful" });
  });
});
