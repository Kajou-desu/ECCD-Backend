import express from "express";
import cors from "cors";
import helmet from "helmet";
import pinoHttp from "pino-http";
import { env } from "./config/env.js";
import { prisma } from "./lib/prisma.js";
import { logger } from "./lib/logger.js";
import apiRoutes from "./routes/index.js";
import { notFoundHandler, errorHandler } from "./middleware/errorHandler.js";
import { apiLimiter, authLimiter } from "./middleware/rateLimit.js";

export const app = express();

// Behind AWS ALB/CloudFront, this makes req.protocol / req.ip reflect the
// original client rather than the proxy, which matters for rate limiting
// and for building correct https:// file URLs.
app.set("trust proxy", 1);

app.disable("x-powered-by"); // don't advertise the framework in headers
app.use(helmet()); // HSTS, X-Content-Type-Options, etc.

// Structured request logging with a request-id on every log line, so a
// single request's logs can be correlated end to end.
app.use(
  pinoHttp({
    logger,
    autoLogging: { ignore: (req) => req.url === "/health" },
  })
);

if (!env.clientOrigin) {
  console.warn(
    "CLIENT_ORIGIN is not set — CORS will reject all cross-origin requests. " +
      "Set it explicitly in production; never use '*'."
  );
}
app.use(
  cors({
    origin: env.clientOrigin || false,
    credentials: true,
  })
);

app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true, limit: "1mb" }));

app.get("/health", async (_req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ status: "ok", db: "connected" });
  } catch {
    res.status(503).json({ status: "error", db: "disconnected" });
  }
});

// Mounted at both /api (legacy, kept for existing clients) and /api/v1
// (the standardized path going forward — see routes/auth.routes.js for the
// /auth/login alias). Both point at the same router; nothing behaves
// differently between them.
//
// IMPORTANT: these must be two separate app.use() calls, with /api/v1
// registered first — passing ['/api', '/api/v1'] as one array does NOT
// work, because '/api' alone is itself a path-prefix match for
// '/api/v1/...' requests too. Express tries array entries in order and the
// first match wins, so '/api' would strip only that prefix, leave '/v1/...'
// unmatched against the router's routes, and 404 every /api/v1 request.
const API_PREFIXES = ["/api", "/api/v1"];
const AUTH_PATHS = API_PREFIXES.flatMap((p) => [`${p}/login`, `${p}/auth`]);

// Stricter limiter on auth routes, general limiter on everything else under /api.
app.use(AUTH_PATHS, authLimiter);
app.use("/api/v1", apiLimiter, apiRoutes);
app.use("/api", apiLimiter, apiRoutes);

// Note: uploaded files are served publicly (not behind auth) via
// /api/files/:filename — see files.routes.js for why. Relies on
// crypto-random filenames + upload MIME whitelist as compensating controls.

app.use(notFoundHandler);
app.use(errorHandler);
