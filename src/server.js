import { env } from "./config/env.js"; // validates required env vars, fails closed if missing
import { app } from "./app.js";
import { prisma } from "./lib/prisma.js";
import { logger } from "./lib/logger.js";
import { startOtpCleanupJob } from "./lib/otpCleanup.js";

const server = app.listen(env.port, () => {
  logger.info(`ECCD SmartTrack API running on port ${env.port}`);
});

const otpCleanupHandle = startOtpCleanupJob();

// Graceful shutdown: stop accepting new connections, let in-flight requests
// finish, then close the DB connection — so a deploy/restart doesn't drop
// requests mid-flight.
async function shutdown(signal) {
  logger.info(`Received ${signal}, shutting down gracefully...`);
  clearInterval(otpCleanupHandle);

  server.close(async () => {
    await prisma.$disconnect();
    logger.info("Shutdown complete");
    process.exit(0);
  });

  // Force-exit if connections haven't drained after 10s.
  setTimeout(() => {
    logger.error("Forced shutdown after timeout");
    process.exit(1);
  }, 10_000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
