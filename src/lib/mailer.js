import nodemailer from "nodemailer";
import { env } from "../config/env.js";
import { logger } from "./logger.js";

// Lazily built so a missing SMTP config doesn't crash the whole process at
// import time — env.js already fails closed for the truly required vars;
// SMTP is only fatal in production (enforced below), not in dev.
let transporter = null;

function getTransporter() {
  if (transporter) return transporter;

  transporter = nodemailer.createTransport({
    host: env.smtp.host,
    port: env.smtp.port,
    secure: env.smtp.port === 465,
    auth: { user: env.smtp.user, pass: env.smtp.pass },
  });

  return transporter;
}

// Sends the password-reset OTP by email. In development, if SMTP isn't
// configured, falls back to logging so local setup doesn't require a mail
// provider. In production, env.js already refuses to start without SMTP
// configured, so this path always sends for real there.
export async function sendOtpEmail(email, otpCode) {
  if (!env.smtp.configured) {
    logger.info(`[DEV] OTP for ${email}: ${otpCode}`);
    return;
  }

  await getTransporter().sendMail({
    from: env.smtp.from,
    to: email,
    subject: "ECCD SmartTrack — Password Reset Code",
    text: `Your password reset code is: ${otpCode}\n\nThis code expires in 10 minutes. If you didn't request this, you can ignore this email.`,
  });
}
