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

// Optional face-recognition microservice (face-recognition-service/). When
// unset, the frame endpoint answers 503 and the rest of the app is unaffected.
// When set it must be complete and safe: a real http(s) URL, plain http only for
// loopback in production (frames contain children's faces), and a strong key.
function recognitionConfig() {
  const rawUrl = process.env.RECOGNITION_SERVICE_URL;
  const key = process.env.RECOGNITION_SERVICE_KEY;
  if (!rawUrl && !key) return null;

  let url;
  try {
    url = new URL(rawUrl || "");
  } catch {
    console.error("RECOGNITION_SERVICE_URL must be a valid URL.");
    process.exit(1);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    console.error("RECOGNITION_SERVICE_URL must be http(s).");
    process.exit(1);
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (isProduction && url.protocol !== "https:" && !loopback) {
    console.error("In production RECOGNITION_SERVICE_URL must use https unless it is localhost.");
    process.exit(1);
  }
  if (!key || key.length < 32) {
    console.error("RECOGNITION_SERVICE_KEY is required (32+ random characters) when RECOGNITION_SERVICE_URL is set.");
    process.exit(1);
  }
  return { baseUrl: url.origin, key };
}

const recognition = recognitionConfig();

// --- File storage -----------------------------------------------------------
// "local" keeps files in ./uploads (development, or a single server without a
// bucket). "s3" uses any S3-compatible bucket — Neon Object Storage or AWS S3;
// see .env.example for the two configurations. Credentials are NOT read here:
// the AWS SDK picks up AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY (or an IAM
// role) from the environment itself, so they never pass through app code.
const storageDriver = (process.env.STORAGE_DRIVER || "local").toLowerCase();

if (!["local", "s3"].includes(storageDriver)) {
  console.error(`STORAGE_DRIVER must be "local" or "s3" (got "${storageDriver}").`);
  process.exit(1);
}

const s3Endpoint = process.env.AWS_ENDPOINT_URL_S3 || undefined;

if (storageDriver === "s3") {
  const missingS3 = ["S3_BUCKET", "AWS_REGION"].filter((key) => !process.env[key]);
  if (missingS3.length > 0) {
    // Fail closed: refuse to start rather than accept uploads we can't store.
    console.error(`STORAGE_DRIVER=s3 requires: ${missingS3.join(", ")}`);
    process.exit(1);
  }

  if (s3Endpoint) {
    let parsed;
    try {
      parsed = new URL(s3Endpoint);
    } catch {
      console.error("AWS_ENDPOINT_URL_S3 is not a valid URL.");
      process.exit(1);
    }
    // Files (children's records) must never travel to the bucket in cleartext.
    if (isProduction && parsed.protocol !== "https:") {
      console.error("AWS_ENDPOINT_URL_S3 must use https:// in production.");
      process.exit(1);
    }
  }
}

if (isProduction && storageDriver === "local") {
  // Not fatal — a single-instance deployment is legitimate — but on any
  // load-balanced or ephemeral-disk host, local files are lost or invisible
  // to other instances.
  console.warn(
    "STORAGE_DRIVER=local in production: uploads live on this server's disk only. " +
      "Set STORAGE_DRIVER=s3 to use a bucket."
  );
}

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
  recognition,
  storage: {
    driver: storageDriver,
    s3: {
      bucket: process.env.S3_BUCKET,
      region: process.env.AWS_REGION,
      endpoint: s3Endpoint,
      // undefined = let the driver decide (custom endpoint => path-style).
      forcePathStyle:
        process.env.S3_FORCE_PATH_STYLE === undefined
          ? undefined
          : process.env.S3_FORCE_PATH_STYLE === "true",
    },
  },
  smtp: {
    configured: smtpConfigured,
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT) || 587,
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
    from: process.env.SMTP_FROM || '"ECCD SmartTrack" <noreply@eccd-smarttrack.local>',
  },
};
