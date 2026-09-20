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

// The school's local timezone. Attendance "today" must be computed in it, not
// in the server's timezone: the server runs in UTC, and a 7:30 AM Manila
// arrival is still "yesterday" in UTC. Fails closed on an invalid zone name.
const schoolTimezone = process.env.SCHOOL_TIMEZONE || "Asia/Manila";
try {
  new Intl.DateTimeFormat("en-CA", { timeZone: schoolTimezone });
} catch {
  console.error(`SCHOOL_TIMEZONE is not a valid IANA timezone: "${schoolTimezone}"`);
  process.exit(1);
}

// Face + BLE verification thresholds — tunable without a code change. They must
// be CALIBRATED on the real hardware and classroom (see docs/SMART_ATTENDANCE.md);
// the defaults are only a starting point. Out-of-range or non-numeric values
// fail closed at startup rather than silently loosening verification.
function numberEnv(name, fallback, min, max) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min || value > max) {
    console.error(`${name} must be a number between ${min} and ${max} (got "${raw}").`);
    process.exit(1);
  }
  return value;
}

const verification = {
  // Face: best-match distance must be at or below this (lower = stricter).
  faceMaxDistance: numberEnv("FACE_MAX_DISTANCE", 0.5, 0.1, 0.9),
  // Face: the runner-up (a different student) must be at least this much
  // farther than the best match, so look-alikes and siblings come back unknown.
  faceMinMargin: numberEnv("FACE_MIN_MARGIN", 0.05, 0, 0.5),
  // BLE: smoothed RSSI (dBm) must be at or above this (higher = must be nearer).
  bleMinRssi: numberEnv("BLE_MIN_RSSI", -70, -100, -20),
  // Both signals must have been seen within this many seconds of each other/now.
  windowMs: numberEnv("VERIFY_WINDOW_SEC", 30, 5, 300) * 1000,
  // Each signal needs this many sightings in a row (guards against one stray reading).
  minHits: numberEnv("VERIFY_MIN_HITS", 2, 1, 10),
};

const clientOrigins = (process.env.CLIENT_ORIGIN || "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

export const env = {
  port: Number(process.env.PORT) || 4000,
  clientOrigins,
  nodeEnv,
  isProduction,
  redisUrl: process.env.REDIS_URL || null,
  schoolTimezone,
  verification,
  smtp: {
    configured: smtpConfigured,
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT) || 587,
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
    from: process.env.SMTP_FROM || '"ECCD SmartTrack" <noreply@eccd-smarttrack.local>',
  },
};
