import "dotenv/config";

const nodeEnv = process.env.NODE_ENV || "development";
const isProduction = nodeEnv === "production";

const required = ["DATABASE_URL", "DIRECT_URL", "JWT_SECRET"];
const missing = required.filter((key) => !process.env[key]);

if (missing.length > 0) {
  // Fail closed: refuse to start rather than run with undefined secrets
  console.error(`Missing required environment variables: ${missing.join(", ")}`);
  process.exit(1);
}

if (process.env.JWT_SECRET.length < 32) {
  console.error("JWT_SECRET is too short. Use at least 32 random characters.");
  process.exit(1);
}

const smtpVars = ["SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASS"];
const missingSmtp = smtpVars.filter((key) => !process.env[key]);
const smtpConfigured = missingSmtp.length === 0;

if (isProduction && !smtpConfigured) {
  // Fail closed in production: without SMTP, OTP emails silently never
  // arrive and users are locked out of password reset.
  console.error(
    `Missing required environment variables for production: ${missingSmtp.join(", ")}`
  );
  process.exit(1);
}

if (!isProduction && !smtpConfigured) {
  console.warn(
    "SMTP is not configured — password reset OTPs will be logged to the console " +
      "instead of emailed. Set SMTP_HOST/PORT/USER/PASS to test real delivery."
  );
}

export const env = {
  port: Number(process.env.PORT) || 4000,
  clientOrigin: process.env.CLIENT_ORIGIN,
  nodeEnv,
  isProduction,
  redisUrl: process.env.REDIS_URL || null,
  smtp: {
    configured: smtpConfigured,
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT) || 587,
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
    from: process.env.SMTP_FROM || '"ECCD SmartTrack" <noreply@eccd-smarttrack.local>',
  },
};
