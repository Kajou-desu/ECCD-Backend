import { env } from "../config/env.js";
import { logger } from "./logger.js";

const SEMAPHORE_URL = "https://api.semaphore.co/api/v4/messages";

// Philippine mobile number, with or without country code: 09XXXXXXXXX,
// 639XXXXXXXXX or +639XXXXXXXXX. Semaphore only delivers to PH numbers, so
// anything else is skipped rather than sent (and billed) for nothing.
const PH_MOBILE_RE = /^(?:\+?63|0)9\d{9}$/;

function normalizePhone(phone) {
  return String(phone ?? "").replace(/[\s\-()]/g, "");
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

  const res = await fetch(SEMAPHORE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!res.ok) {
    // Provider response body may contain account/billing detail — server
    // log only, never surfaced to a client.
    const detail = await res.text().catch(() => "");
    logger.error({ status: res.status, detail }, "Semaphore SMS request failed");
    throw new Error(`Semaphore request failed with status ${res.status}`);
  }
}
