import { PrismaClient } from "@prisma/client";
import { env } from "../config/env.js";

// Connection pool size is controlled via `?connection_limit=N` on
// DATABASE_URL (Prisma's documented mechanism) rather than here, so it can
// be tuned per-environment without a code change.
export const prisma = new PrismaClient({
  log: env.isProduction ? ["error", "warn"] : ["error", "warn", "query"],
});
