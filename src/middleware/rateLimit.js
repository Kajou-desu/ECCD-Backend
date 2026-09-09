import rateLimit from "express-rate-limit";
import { RedisStore } from "rate-limit-redis";
import Redis from "ioredis";
import { env } from "../config/env.js";
import { logger } from "../lib/logger.js";

// Without a shared store, each server instance (behind a load balancer)
// tracks its own counts and limits reset on every deploy/restart. When
// REDIS_URL is set, counts are shared across instances and survive
// restarts; otherwise this falls back to express-rate-limit's in-memory
// store, which is fine for a single instance but not for horizontal scaling.
let redisClient = null;
function getStore(prefix) {
  if (!env.redisUrl) return undefined;

  if (!redisClient) {
    // maxRetriesPerRequest: null tells ioredis to keep queueing/retrying
    // the connection in the background rather than rejecting in-flight
    // commands (including its own internal handshake commands) with an
    // unhandled MaxRetriesPerRequestError, which would otherwise crash the
    // whole process on a Redis outage.
    redisClient = new Redis(env.redisUrl, { maxRetriesPerRequest: null });
    redisClient.on("error", (err) => logger.error({ err }, "Redis connection error"));
  }

  return new RedisStore({
    prefix,
    sendCommand: (...args) => redisClient.call(...args),
  });
}

if (!env.redisUrl) {
  logger.warn(
    "REDIS_URL is not set — rate limiting uses an in-memory store, which " +
      "does not work correctly across multiple server instances. Set " +
      "REDIS_URL in any load-balanced deployment."
  );
}

// General API traffic
export const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 min
  limit: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Too many requests, please try again later" },
  store: getStore("rl:api:"),
  // If Redis is down, fail open (allow the request) rather than take the
  // whole API down with it — logged loudly so it's visible in monitoring.
  passOnStoreError: true,
});

// Login / password-reset endpoints — much stricter to slow brute force
// and OTP-guessing attempts.
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Too many attempts, please try again later" },
  store: getStore("rl:auth:"),
  passOnStoreError: true,
});

// Exported separately (rather than inlined below) so it's unit-testable
// without spinning up the whole rate-limit middleware.
export function emailRateLimitKey(req) {
  const email = req.body?.email;
  // Falls back to a constant key when the body has no email (shouldn't
  // happen post-validateBody, but never let a missing key generator input
  // throw) — worst case it behaves like a low-traffic bucket shared by
  // malformed requests, not a bypass.
  return typeof email === "string" && email.trim() ? email.trim().toLowerCase() : "unknown";
}

// authLimiter above is keyed by IP by default, which stops a single-source
// brute force but not an attacker spreading login/OTP attempts for one
// target account across many IPs. This second limiter is keyed by the
// request's `email` field instead, so it catches that case regardless of
// how many IPs are used. Both limiters run on the same routes (see
// AUTH_PATHS in app.js) — either one tripping blocks the request.
export const authEmailLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Too many attempts for this account, please try again later" },
  store: getStore("rl:auth-email:"),
  passOnStoreError: true,
  keyGenerator: emailRateLimitKey,
});
