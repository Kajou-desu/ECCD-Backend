import nodemailer from "nodemailer";
import { env } from "../config/env.js";
import { logger } from "./logger.js";

// Lazily built so a missing SMTP config doesn't crash the whole process at
// import time — env.js already fails closed for the truly required vars;
// email config is only fatal in production (enforced there), not in dev.
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

const RESEND_URL = "https://api.resend.com/emails";

// One send path for every email. Resend's HTTPS API is used when RESEND_API_KEY
// is set — hosts like Railway block outbound SMTP on lower plans, and HTTPS
// isn't blocked. Otherwise falls back to SMTP. Throws on delivery failure; the
// error carries the provider's status/message but never the API key.
async function deliver({ to, subject, text }) {
  if (env.resend.apiKey) {
    const res = await fetch(RESEND_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.resend.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ from: env.smtp.from, to: [to], subject, text }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`Resend API responded ${res.status}: ${detail.slice(0, 300)}`);
    }
    return;
  }

  await getTransporter().sendMail({ from: env.smtp.from, to, subject, text });
}

// In development, if no mail transport is configured, falls back to logging so
// local setup doesn't require a mail provider. In production, env.js already
// refuses to start without one, so this path always sends for real there.
export async function sendOtpEmail(email, otpCode, purpose = "Password Reset") {
  if (!env.emailConfigured) {
    logger.info(`[DEV] OTP for ${email}: ${otpCode}`);
    return;
  }

  await deliver({
    to: email,
    subject: `ECCD SmartTrack — ${purpose} Code`,
    // Named after what the code is actually for — this mailer also sends the
    // password-change and account-deletion codes, which must not be described
    // as a "password reset" code.
    text: `Your ${purpose.toLowerCase()} code is: ${otpCode}\n\nThis code expires in 10 minutes. If you didn't request this, you can ignore this email.`,
  });
}

// Generic sender used for arrival/departure notifications (see
// attendanceNotification.service.js). Same dev fallback as sendOtpEmail: with
// no mail transport configured, log instead of sending so local dev doesn't need a
// mail provider. Throws on delivery failure — the caller (notifyParents)
// catches it so one parent's bounced email never blocks the others.
export async function sendAttendanceEmail(email, subject, text) {
  if (!env.emailConfigured) {
    logger.info(`[DEV] Email to ${email}: ${subject}`);
    return;
  }

  await deliver({ to: email, subject, text });
}
