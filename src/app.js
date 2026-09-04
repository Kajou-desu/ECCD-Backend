import express from "express";
import cors from "cors";
import helmet from "helmet";
import { env } from "./config/env.js";
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

app.get("/health", (_req, res) => res.json({ status: "ok" }));

// Stricter limiter on auth routes, general limiter on everything else under /api.
app.use("/api/login", authLimiter);
app.use("/api/auth", authLimiter);
app.use("/api", apiLimiter, apiRoutes);

// Note: uploaded files are served publicly (not behind auth) via
// /api/files/:filename — see files.routes.js for why. Relies on
// crypto-random filenames + upload MIME whitelist as compensating controls.

app.use(notFoundHandler);
app.use(errorHandler);
