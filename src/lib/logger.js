import pino from "pino";
import { env } from "../config/env.js";

// Credentials must never reach the logs. pino-http serializes every request's
// headers by default, which would otherwise write each caller's
// `Authorization: Bearer <JWT>` (and any cookie) to the log stream in
// plaintext. Redaction is applied at the root logger so it covers every log
// line, including any added in the future.
const redact = {
  paths: [
    "req.headers.authorization",
    "req.headers.cookie",
    'res.headers["set-cookie"]',
  ],
  censor: "[REDACTED]",
};

// Factory so tests can build the *real* production logger against an
// in-memory stream instead of re-declaring its config.
export function createLogger(stream) {
  return pino(
    {
      level: process.env.LOG_LEVEL || "info",
      redact,
      // Pretty-print in dev only; production emits structured JSON for log
      // aggregation (CloudWatch, Datadog, etc.). A custom stream (tests)
      // can't be combined with a transport.
      transport: stream || env.isProduction ? undefined : { target: "pino-pretty" },
    },
    stream
  );
}

export const logger = createLogger();
