import { env } from "./config/env.js"; // validates required env vars, fails closed if missing
import { app } from "./app.js";
import { prisma } from "./lib/prisma.js";
import { logger } from "./lib/logger.js";
import { startOtpCleanupJob } from "./lib/otpCleanup.js";
import { startSessionCleanupJob } from "./lib/sessionCleanup.js";
import { getStorage } from "./storage/index.js";

const server = app.listen(env.port, () => {
  logger.info(`ECCD SmartTrack API running on port ${env.port}`);
});

const otpCleanupHandle = startOtpCleanupJob();
const sessionCleanupHandle = startSessionCleanupJob();

// Surface a misconfigured bucket (bad credentials, wrong endpoint or bucket
// name) in the startup log instead of at the first user's upload. Logged, not
// fatal: a storage outage shouldn't stop the rest of the API from starting.
// (get, not head: only a GET error names a missing bucket — a HEAD 404 has no
// body, so a wrong bucket would look like a normal "no such file".)
const storage = getStorage();
storage
  .get("startup-check")
  .then((object) => {
    object?.body?.destroy?.();
    logger.info(`File storage ready (${storage.name})`);
  })
  .catch((err) => logger.error({ err }, `File storage (${storage.name}) is not reachable — uploads will fail`));

// Graceful shutdown: stop accepting new connections, let in-flight requests
// finish, then close the DB connection — so a deploy/restart doesn't drop
// requests mid-flight.
async function shutdown(signal) {
  logger.info(`Received ${signal}, shutting down gracefully...`);
  clearInterval(otpCleanupHandle);
  clearInterval(sessionCleanupHandle);

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
