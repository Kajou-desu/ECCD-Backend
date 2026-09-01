import bcrypt from "bcryptjs";
import crypto from "node:crypto";
import { prisma } from "../lib/prisma.js";
import { signToken } from "../utils/jwt.js";
import { requireEmail } from "../utils/validate.js";

export async function login(req, res, next) {
  try {
    const { password } = req.body;
    if (!req.body.email || !password) {
      return res.status(400).json({ message: "Email and password required" });
    }
    const email = requireEmail(req.body.email);

    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) return res.status(401).json({ message: "Invalid credentials" });
    if (!user.isActive) return res.status(401).json({ message: "Invalid credentials" });

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) return res.status(401).json({ message: "Invalid credentials" });

    const token = signToken(user);
    res.json({
      token,
      user: { id: user.id, name: user.name, email: user.email, role: user.role },
    });
  } catch (err) {
    next(err);
  }
}

export async function forgotPassword(req, res, next) {
  try {
    if (!req.body.email) return res.status(400).json({ message: "Email required" });
    const email = requireEmail(req.body.email);

    const user = await prisma.user.findUnique({ where: { email } });
    // Always respond 200 to avoid leaking which emails exist
    if (!user) return res.json({ message: "If the email exists, an OTP was sent" });

    // crypto.randomInt is a CSPRNG — Math.random() is NOT safe for security tokens.
    const otpCode = String(crypto.randomInt(100000, 1000000));
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 min

    await prisma.passwordResetOtp.create({ data: { email, otpCode, expiresAt } });

    // TODO: integrate real email/SMS provider
    console.log(`[DEV] OTP for ${email}: ${otpCode}`);

    res.json({ message: "If the email exists, an OTP was sent" });
  } catch (err) {
    next(err);
  }
}

export async function resetPassword(req, res, next) {
  try {
    const { otpCode, newPassword } = req.body;
    if (!req.body.email || !otpCode || !newPassword) {
      return res.status(400).json({ message: "Missing fields" });
    }
    if (typeof newPassword !== "string" || newPassword.length < 10) {
      return res.status(400).json({ message: "Password must be at least 10 characters" });
    }
    const email = requireEmail(req.body.email);

    const record = await prisma.passwordResetOtp.findFirst({
      where: { email, otpCode },
      orderBy: { createdAt: "desc" },
    });

    if (!record || record.expiresAt < new Date()) {
      return res.status(400).json({ message: "Invalid or expired OTP" });
    }

    const passwordHash = await bcrypt.hash(newPassword, 10);
    await prisma.user.update({
      where: { email },
      data: { passwordHash, tokenVersion: { increment: 1 } },
    });
    await prisma.passwordResetOtp.deleteMany({ where: { email } });

    res.json({ message: "Password reset successful" });
  } catch (err) {
    next(err);
  }
}
