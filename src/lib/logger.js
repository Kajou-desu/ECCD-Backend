import pino from "pino";
import { env } from "../config/env.js";

export const logger = pino({
  level: process.env.LOG_LEVEL || "info",
  // Pretty-print in dev only; production emits structured JSON for log
  // aggregation (CloudWatch, Datadog, etc.).
  transport: env.isProduction ? undefined : { target: "pino-pretty" },
});
