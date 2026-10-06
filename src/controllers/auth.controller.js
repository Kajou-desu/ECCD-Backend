import bcrypt from "bcryptjs";
import crypto from "node:crypto";
import { prisma } from "../lib/prisma.js";
import { signToken } from "../utils/jwt.js";
import { requireEmail } from "../utils/validate.js";
import { sendOtpEmail } from "../lib/mailer.js";
import { signFileUrl } from "../lib/signedFileUrl.js";
import { logger } from "../lib/logger.js";
import { otpMatches, MAX_OTP_ATTEMPTS } from "../utils/otp.js";

// Compared against when the email isn't registered (or the account is
// disabled), so those requests spend the same bcrypt time as a real
// wrong-password attempt. Without it, "no such user" answers in a couple of
// milliseconds and "wrong password" takes ~100ms — a timing difference that
// lets anyone enumerate which emails have accounts.
// A new reset code is not issued within this window of the previous one. The
// response is identical either way (so it reveals nothing about the account);
// it stops one address being flooded with mail and keeps a double-click or a
// "resend" tap from invalidating the code the user is about to type.
const OTP_RESEND_COOLDOWN_MS = 60 * 1000;

class InvalidOtpError extends Error {}

const DUMMY_PASSWORD_HASH = bcrypt.hashSync(crypto.randomBytes(16).toString("hex"), 10);

export async function login(req, res, next) {
  try {
    const { password } = req.body;
    const email = requireEmail(req.body.email);

    const user = await prisma.user.findUnique({ where: { email } });

    // Always run exactly one bcrypt comparison, then reject on any failure
    // with the same generic response.
    const valid = await bcrypt.compare(password, user?.passwordHash ?? DUMMY_PASSWORD_HASH);
    if (!user || !user.isActive || !valid) {
      return res.status(401).json({ message: "Invalid credentials" });
    }

    // Capture the *previous* login before overwriting it — this is what's
    // shown to the user as "Last Login" (lets them notice unrecognized
    // access), not the login that's happening right now.
    const previousLoginAt = user.lastLoginAt;
    await prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });

    const token = signToken(user);
    res.json({
      token,
      user: {
        id: user.id,
        name: user.name,
        firstName: user.firstName,
        middleName: user.middleName,
        lastName: user.lastName,
        email: user.email,
        phone: user.phone,
        role: user.role,
        createdAt: user.createdAt,
        lastLoginAt: previousLoginAt,
        profilePicture: user.profilePicture ? signFileUrl(req, user.profilePicture) : null,
      },
    });
  } catch (err) {
    next(err);
  }
}

export async function forgotPassword(req, res, next) {
  try {
    const email = requireEmail(req.body.email);

    const user = await prisma.user.findUnique({ where: { email } });
    // Always respond 200 to avoid leaking which emails exist
    if (!user) return res.json({ message: "If the email exists, an OTP was sent" });

    const latest = await prisma.passwordResetOtp.findFirst({
      where: { email },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    });
    if (latest && Date.now() - latest.createdAt.getTime() < OTP_RESEND_COOLDOWN_MS) {
      return res.json({ message: "If the email exists, an OTP was sent" });
    }

    // crypto.randomInt is a CSPRNG — Math.random() is NOT safe for security tokens.
    const otpCode = String(crypto.randomInt(100000, 1000000));
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 min

    // Only the newest code is ever valid — issuing a new one retires any
    // still-unused earlier ones (same rule the account-action OTPs follow).
    await prisma.passwordResetOtp.updateMany({
      where: { email, isUsed: false },
      data: { isUsed: true },
    });
    await prisma.passwordResetOtp.create({ data: { email, otpCode, expiresAt } });

    // Not awaited, and failures are only logged: awaiting the SMTP round trip
    // made "registered email" visibly slower than "unknown email", and a
    // delivery error surfaced as a 500 only for registered emails — both let
    // an outsider tell which emails have accounts. The response is now the
    // same, and as fast, either way.
    sendOtpEmail(email, otpCode).catch((err) => {
      logger.error({ err }, "Failed to send password reset OTP email");
    });

    res.json({ message: "If the email exists, an OTP was sent" });
  } catch (err) {
    next(err);
  }
}

export async function resetPassword(req, res, next) {
  try {
    const { otpCode, newPassword } = req.body;
    const email = requireEmail(req.body.email);

    // Look up the newest unused code for the email and compare in code (rather
    // than matching the code inside the query) so wrong guesses can be counted
    // against it and the comparison is constant-time.
    const record = await prisma.passwordResetOtp.findFirst({
      where: { email, isUsed: false },
      orderBy: { createdAt: "desc" },
    });

    if (!record || record.expiresAt < new Date() || record.attempts >= MAX_OTP_ATTEMPTS) {
      return res.status(400).json({ message: "Invalid or expired OTP" });
    }

    // Claim one guess BEFORE comparing, as a single conditional UPDATE. The
    // old read-compare-then-increment let N parallel requests all read
    // attempts=0 and each try a different code, exceeding the 5-guess cap;
    // here the database admits at most MAX_OTP_ATTEMPTS claims in total, however
    // many requests race. A correct guess also uses up one attempt, which is
    // harmless because the code is single-use anyway.
    const claimed = await prisma.passwordResetOtp.updateMany({
      where: { id: record.id, isUsed: false, attempts: { lt: MAX_OTP_ATTEMPTS } },
      data: { attempts: { increment: 1 } },
    });
    if (claimed.count === 0 || !otpMatches(otpCode, record.otpCode)) {
      return res.status(400).json({ message: "Invalid or expired OTP" });
    }

    const passwordHash = await bcrypt.hash(newPassword, 10);

    // Consume the codes and change the password in ONE transaction. Before,
    // the codes were burned first, so a failure while updating the user (DB
    // error, account deleted or email changed since the code was issued)
    // left the person with an error and a dead code. The consume step is
    // still the gate: of two simultaneous requests carrying the same valid
    // code, exactly one sees count > 0. It consumes every outstanding code
    // for the email so one issued earlier can't be replayed.
    try {
      await prisma.$transaction(async (tx) => {
        const consumed = await tx.passwordResetOtp.updateMany({
          where: { email, isUsed: false },
          data: { isUsed: true },
        });
        if (consumed.count === 0) throw new InvalidOtpError();
        await tx.user.update({
          where: { email },
          data: { passwordHash, tokenVersion: { increment: 1 } },
        });
      });
    } catch (err) {
      // P2025: no user with this email any more. The transaction rolled back,
      // so nothing was consumed.
      if (err instanceof InvalidOtpError || err.code === "P2025") {
        return res.status(400).json({ message: "Invalid or expired OTP" });
      }
      throw err;
    }

    res.json({ message: "Password reset successful" });
  } catch (err) {
    next(err);
  }
}
