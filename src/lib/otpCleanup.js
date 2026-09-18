import { prisma } from "./prisma.js";
import { logger } from "./logger.js";

const CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // hourly

async function cleanupExpiredOtps() {
  try {
    const where = {
      OR: [{ isUsed: true }, { expiresAt: { lt: new Date() } }],
    };
    const [passwordReset, accountAction] = await Promise.all([
      prisma.passwordResetOtp.deleteMany({ where }),
      prisma.accountActionOtp.deleteMany({ where }),
    ]);
    const count = passwordReset.count + accountAction.count;
    if (count > 0) {
      logger.info({ count }, "Cleaned up expired/used OTPs");
    }
  } catch (err) {
    logger.error({ err }, "OTP cleanup failed");
  }
}

// Returns the interval handle so callers can clearInterval() on shutdown.
export function startOtpCleanupJob() {
  cleanupExpiredOtps(); // run once at startup, then on the interval
  return setInterval(cleanupExpiredOtps, CLEANUP_INTERVAL_MS);
}
