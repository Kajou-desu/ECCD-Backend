import { env } from "../config/env.js";
import { logger } from "./logger.js";
// Semaphore only delivers to PH mobiles, so anything else is skipped rather
// than sent (and billed) for nothing. Same rule the account forms enforce.
import { PH_MOBILE_RE, normalizePhone } from "../utils/validate.js";

const SEMAPHORE_URL = "https://api.semaphore.co/api/v4/messages";

// Semaphore caps this endpoint at 120 calls/minute. Only statuses where the
// message was certainly NOT accepted are retried (429 rate limit, 503
// unavailable). Timeouts and other 5xx are deliberately not retried: the
// message may already be queued, and a retry would text the parent twice.
const RETRY_STATUSES = new Set([429, 503]);
const MAX_RETRIES = 2;
const MAX_WAIT_MS = 10_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Honors Retry-After (seconds) when the provider sends it, else backs off
// 2s then 4s. Capped so a fire-and-forget send never lingers for long.
function retryDelayMs(res, attempt) {
  const header = res.headers?.get("retry-after");
  const seconds = header === null || header === undefined ? NaN : Number(header);
  const ms = Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : 2000 * (attempt + 1);
  return Math.min(ms, MAX_WAIT_MS);
}

// Sends one SMS via Semaphore. With no API key configured, logs instead of
// sending so local dev doesn't need a paid SMS account. Throws on an
// unrecognised number or a failed request — the caller (notifyParents)
// catches it so one parent's bad number never blocks the others' emails/SMS.
export async function sendSms(phone, message) {
  if (!env.semaphore.configured) {
    logger.info("[DEV] Semaphore not configured — SMS not sent");
    return;
  }

  const number = normalizePhone(phone);
  if (!PH_MOBILE_RE.test(number)) {
    throw new Error("Recipient is not a valid PH mobile number");
  }

  const body = new URLSearchParams({
    apikey: env.semaphore.apiKey,
    number,
    message,
    ...(env.semaphore.senderName ? { sendername: env.semaphore.senderName } : {}),
  });

  let res;
  for (let attempt = 0; ; attempt++) {
    res = await fetch(SEMAPHORE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    if (res.ok || !RETRY_STATUSES.has(res.status) || attempt >= MAX_RETRIES) break;
    logger.warn({ status: res.status, attempt: attempt + 1 }, "Semaphore SMS throttled/unavailable — retrying");
    await sleep(retryDelayMs(res, attempt));
  }

  if (!res.ok) {
    // Provider response body may contain account/billing detail — server
    // log only, never surfaced to a client.
    const detail = await res.text().catch(() => "");
    logger.error({ status: res.status, detail }, "Semaphore SMS request failed");
    throw new Error(`Semaphore request failed with status ${res.status}`);
  }
}
