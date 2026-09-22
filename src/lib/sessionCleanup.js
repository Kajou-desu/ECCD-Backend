import { prisma } from "./prisma.js";
import { logger } from "./logger.js";

const CLEANUP_INTERVAL_MS = 15 * 60 * 1000; // every 15 min
// A school day never legitimately needs a session open this long; anything
// older was left running (teacher forgot to press Stop, closed the tab, ...).
export const STALE_AFTER_MS = 12 * 60 * 60 * 1000;

export async function closeStaleSessions(now = new Date()) {
  try {
    const { count } = await prisma.attendanceSession.updateMany({
      where: { status: "active", startedAt: { lt: new Date(now.getTime() - STALE_AFTER_MS) } },
      data: { status: "closed", endedAt: now },
    });
    if (count > 0) {
      logger.info({ count }, "Closed stale attendance sessions");
    }
    return count;
  } catch (err) {
    logger.error({ err }, "Stale attendance session cleanup failed");
    return 0;
  }
}

// Returns the interval handle so callers can clearInterval() on shutdown.
export function startSessionCleanupJob() {
  closeStaleSessions(); // once at startup (covers a restart after a long outage), then on the interval
  return setInterval(closeStaleSessions, CLEANUP_INTERVAL_MS);
}
