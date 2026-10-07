import { prisma } from "../lib/prisma.js";
import { env } from "../config/env.js";
import { isAllowedPushEndpoint } from "../lib/push.js";
import { AppError } from "../middleware/errorHandler.js";
import { parseId } from "../utils/validate.js";

// Only these fields can be changed through the preferences endpoint. Anything
// else in the body is rejected rather than ignored, so a client can never
// reach other user columns (role, isActive, ...) through this route.
const PREFERENCE_KEYS = ["notifyByEmail", "notifyBySms"];
const PREFERENCE_SELECT = { notifyByEmail: true, notifyBySms: true };

// GET /api/notifications/preferences
export async function getNotificationPreferences(req, res, next) {
  try {
    // Identity comes from the verified token (req.user), never from the request.
    const prefs = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: PREFERENCE_SELECT,
    });

    if (!prefs) return res.status(404).json({ message: "Not found" });
    res.json(prefs);
  } catch (err) {
    next(err);
  }
}

// PUT /api/notifications/preferences  { notifyByEmail?: boolean, notifyBySms?: boolean }
export async function updateNotificationPreferences(req, res, next) {
  try {
    const body = req.body;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new AppError("Invalid notification preferences", 400);
    }

    const data = {};
    for (const key of Object.keys(body)) {
      if (!PREFERENCE_KEYS.includes(key) || typeof body[key] !== "boolean") {
        throw new AppError("Invalid notification preferences", 400);
      }
      data[key] = body[key];
    }
    if (Object.keys(data).length === 0) {
      throw new AppError("Invalid notification preferences", 400);
    }

    const prefs = await prisma.user.update({
      where: { id: req.user.id },
      data,
      select: PREFERENCE_SELECT,
    });

    res.json(prefs);
  } catch (err) {
    next(err);
  }
}

// A phone plus a laptop plus a tablet or two; more than this is a runaway client.
const MAX_PUSH_DEVICES_PER_USER = 10;
// Keys from PushSubscription.toJSON() are unpadded base64url strings.
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;

function isBase64Url(value, maxLength) {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength && BASE64URL_RE.test(value);
}

// GET /api/notifications/push/public-key
// publicKey is null when the server has no VAPID keys, which the settings page
// reads as "push unavailable". The key is public by design (browsers need it).
export function getPushPublicKey(_req, res) {
  res.json({ publicKey: env.vapid.configured ? env.vapid.publicKey : null });
}

// POST /api/notifications/push/subscribe  { endpoint, keys: { p256dh, auth } }
export async function subscribePush(req, res, next) {
  try {
    if (!env.vapid.configured) throw new AppError("Push notifications are not available", 400);

    const body = req.body;
    const keys = body?.keys;
    if (
      !body ||
      typeof body !== "object" ||
      !isAllowedPushEndpoint(body.endpoint) ||
      !keys ||
      typeof keys !== "object" ||
      !isBase64Url(keys.p256dh, 128) ||
      !isBase64Url(keys.auth, 64)
    ) {
      throw new AppError("Invalid push subscription", 400);
    }

    // Re-registering a device you already have doesn't count against the cap.
    const others = await prisma.pushSubscription.count({
      where: { userId: req.user.id, endpoint: { not: body.endpoint } },
    });
    if (others >= MAX_PUSH_DEVICES_PER_USER) throw new AppError("Too many devices registered for push", 400);

    // The endpoint identifies a browser, not a person: if someone else signed
    // in on this browser before, the row moves to the current user.
    await prisma.pushSubscription.upsert({
      where: { endpoint: body.endpoint },
      create: { userId: req.user.id, endpoint: body.endpoint, p256dh: keys.p256dh, auth: keys.auth },
      update: { userId: req.user.id, p256dh: keys.p256dh, auth: keys.auth },
    });

    res.json({ subscribed: true });
  } catch (err) {
    next(err);
  }
}

// POST /api/notifications/push/unsubscribe  { endpoint }
export async function unsubscribePush(req, res, next) {
  try {
    const endpoint = req.body?.endpoint;
    if (typeof endpoint !== "string" || endpoint.length === 0 || endpoint.length > 2048) {
      throw new AppError("Invalid push subscription", 400);
    }

    // Scoped to the caller: knowing someone else's endpoint can't remove it.
    // Removing something already gone is fine (idempotent).
    await prisma.pushSubscription.deleteMany({ where: { endpoint, userId: req.user.id } });
    res.status(204).send();
  } catch (err) {
    next(err);
  }
}

const DEFAULT_NOTIFICATION_LIMIT = 100;
const MAX_NOTIFICATION_LIMIT = 200;

// GET /api/notifications?unread=true&limit=100  (newest first, limit max 200)
export async function getNotifications(req, res, next) {
  try {
    const unreadOnly = req.query.unread === "true";
    const limit = req.query.limit === undefined ? DEFAULT_NOTIFICATION_LIMIT : parseId(req.query.limit, "limit");
    if (limit > MAX_NOTIFICATION_LIMIT) {
      throw new AppError(`limit must be ${MAX_NOTIFICATION_LIMIT} or less`, 400);
    }

    const notifications = await prisma.notification.findMany({
      where: {
        userId: req.user.id,
        ...(unreadOnly ? { isRead: false } : {}),
      },
      orderBy: { createdAt: "desc" },
      take: limit,
    });

    res.json(notifications);
  } catch (err) {
    next(err);
  }
}

// PATCH /api/notifications/:id/read
export async function markNotificationRead(req, res, next) {
  try {
    const id = parseId(req.params.id, "id");

    // Scoping the update to userId (not just id) means a notification
    // belonging to another user 404s instead of ever being touched here.
    const result = await prisma.notification.updateMany({
      where: { id, userId: req.user.id },
      data: { isRead: true },
    });

    if (result.count === 0) return res.status(404).json({ message: "Notification not found" });
    res.json({ message: "Notification marked as read" });
  } catch (err) {
    next(err);
  }
}

// PATCH /api/notifications/read-all
export async function markAllNotificationsRead(req, res, next) {
  try {
    await prisma.notification.updateMany({
      where: { userId: req.user.id, isRead: false },
      data: { isRead: true },
    });
    res.json({ message: "All notifications marked as read" });
  } catch (err) {
    next(err);
  }
}

// DELETE /api/notifications/:id
export async function dismissNotification(req, res, next) {
  try {
    const id = parseId(req.params.id, "id");

    const result = await prisma.notification.deleteMany({
      where: { id, userId: req.user.id },
    });

    if (result.count === 0) return res.status(404).json({ message: "Notification not found" });
    res.status(204).send();
  } catch (err) {
    next(err);
  }
}

// DELETE /api/notifications
export async function dismissAllNotifications(req, res, next) {
  try {
    await prisma.notification.deleteMany({ where: { userId: req.user.id } });
    res.status(204).send();
  } catch (err) {
    next(err);
  }
}
