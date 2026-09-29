import { prisma } from "../lib/prisma.js";
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

// GET /api/notifications?unread=true
export async function getNotifications(req, res, next) {
  try {
    const unreadOnly = req.query.unread === "true";

    const notifications = await prisma.notification.findMany({
      where: {
        userId: req.user.id,
        ...(unreadOnly ? { isRead: false } : {}),
      },
      orderBy: { createdAt: "desc" },
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
