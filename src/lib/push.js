import webpush from "web-push";
import { env } from "../config/env.js";
import { logger } from "./logger.js";

// The server POSTs to whatever endpoint a client registers, so an unchecked
// endpoint would let any logged-in user make this server call internal URLs
// (SSRF). Browsers only ever hand out endpoints on their vendor's push
// service, so anything else is refused at registration.
const PUSH_SERVICE_HOSTS = [
  "fcm.googleapis.com", // Chrome, Edge (Android), Samsung Internet, Opera, Brave
  "push.services.mozilla.com", // Firefox (updates.push.services.mozilla.com and regional hosts)
  "notify.windows.com", // Edge on Windows (wns2-*.notify.windows.com)
  "push.apple.com", // Safari / iOS Home Screen web apps (web.push.apple.com)
];

export function isAllowedPushEndpoint(endpoint) {
  if (typeof endpoint !== "string" || endpoint.length > 2048) return false;

  let url;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }

  if (url.protocol !== "https:" || url.username || url.password) return false;
  if (url.port && url.port !== "443") return false;

  // Dot-boundary match, so "evilfcm.googleapis.com" and
  // "fcm.googleapis.com.evil.com" don't pass.
  return PUSH_SERVICE_HOSTS.some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`));
}

let vapidReady = false;
function ensureVapid() {
  if (vapidReady) return;
  webpush.setVapidDetails(env.vapid.subject, env.vapid.publicKey, env.vapid.privateKey);
  vapidReady = true;
}

// Sends one push message. Returns "sent", "skipped" (push not configured), or
// "gone" (the browser says the subscription no longer exists — the caller
// should delete it). Any other failure throws; the caller (notifyParents)
// catches it so one dead device never blocks the other channels or parents.
export async function sendPush(subscription, payload) {
  if (!env.vapid.configured) {
    logger.info("[DEV] Web Push not configured — push not sent");
    return "skipped";
  }

  ensureVapid();

  try {
    await webpush.sendNotification(
      { endpoint: subscription.endpoint, keys: { p256dh: subscription.p256dh, auth: subscription.auth } },
      JSON.stringify(payload),
      // An arrival alert that is hours old is misleading, so let the push
      // service drop it rather than deliver it late.
      { TTL: 3600, timeout: 10_000 },
    );
    return "sent";
  } catch (err) {
    if (err?.statusCode === 404 || err?.statusCode === 410) return "gone";
    throw err;
  }
}
