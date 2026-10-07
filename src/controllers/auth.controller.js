import bcrypt from "bcryptjs";
import crypto from "node:crypto";
import { prisma } from "../lib/prisma.js";
import { signToken } from "../utils/jwt.js";
import { requireEmail } from "../utils/validate.js";
import { sendOtpEmail, sendAttendanceEmail } from "../lib/mailer.js";
import { signFileUrl } from "../lib/signedFileUrl.js";
import { logger } from "../lib/logger.js";
import { otpMatches, hashOtp, MAX_OTP_ATTEMPTS } from "../utils/otp.js";

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

const FORGOT_PASSWORD_RESPONSE = { message: "If the email exists, an OTP was sent" };

// Everything that differs between "registered" and "unknown" email happens
// here, AFTER the response has gone out, so response time is the same for
// both. Failures are only logged — the client never learns about them.
async function issuePasswordResetOtp(email) {
  const user = await prisma.user.findUnique({ where: { email } });
  // Disabled accounts get no codes (same generic response as unknown emails).
  if (!user || !user.isActive) return;

  const latest = await prisma.passwordResetOtp.findFirst({
    where: { email },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true },
  });
  if (latest && Date.now() - latest.createdAt.getTime() < OTP_RESEND_COOLDOWN_MS) return;

  // crypto.randomInt is a CSPRNG — Math.random() is NOT safe for security tokens.
  const otpCode = String(crypto.randomInt(100000, 1000000));
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 min

  // Only the newest code is ever valid — issuing a new one retires any
  // still-unused earlier ones (same rule the account-action OTPs follow).
  // Only the HMAC of the code is stored; the plaintext goes to the mailbox.
  await prisma.passwordResetOtp.updateMany({
    where: { email, isUsed: false },
    data: { isUsed: true },
  });
  await prisma.passwordResetOtp.create({ data: { email, otpCode: hashOtp(otpCode), expiresAt } });

  await sendOtpEmail(email, otpCode);
}

export async function forgotPassword(req, res, next) {
  let email;
  try {
    email = requireEmail(req.body.email);
  } catch (err) {
    return next(err);
  }

  // Respond first, then do the lookup/DB writes/SMTP: otherwise registered
  // emails (lookup + two writes) answer measurably slower than unknown ones,
  // and a DB or SMTP failure would surface only for registered emails.
  res.json(FORGOT_PASSWORD_RESPONSE);

  try {
    await issuePasswordResetOtp(email);
  } catch (err) {
    logger.error({ err }, "Failed to issue password reset OTP");
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

    // Consume the OTPs and change the password atomically: if the account is
    // gone (user.update throws P2025) the whole thing rolls back instead of
    // leaving the code burned with nothing changed.
    //
    // Consumes every outstanding OTP for this email, not just the one used,
    // so a code issued earlier in the same window can't be replayed. The
    // update only matches rows still unused, so of two simultaneous requests
    // carrying the same valid code, exactly one sees count > 0.
    let changed = false;
    try {
      changed = await prisma.$transaction(async (tx) => {
        const consumed = await tx.passwordResetOtp.updateMany({
          where: { email, isUsed: false },
          data: { isUsed: true },
        });
        if (consumed.count === 0) return false;

        const user = await tx.user.update({
          where: { email },
          data: { passwordHash, tokenVersion: { increment: 1 } },
          select: { id: true },
        });
        // Pending password-change / account-deletion codes were issued under
        // the old credentials; they must not survive a reset.
        await tx.accountActionOtp.deleteMany({ where: { userId: user.id } });
        return true;
      });
    } catch (err) {
      if (err.code !== "P2025") throw err;
    }
    if (!changed) return res.status(400).json({ message: "Invalid or expired OTP" });

    // Fire-and-forget heads-up so an unexpected reset gets noticed.
    sendAttendanceEmail(
      email,
      "ECCD SmartTrack — Your password was changed",
      "Your ECCD SmartTrack password was just changed using a password reset code.\n\nIf this was you, no action is needed. If it wasn't, contact your center administrator immediately.",
    ).catch((err) => {
      logger.error({ err }, "Failed to send password-changed notification email");
    });

    res.json({ message: "Password reset successful" });
  } catch (err) {
    next(err);
  }
}
