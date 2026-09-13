import { prisma } from "../lib/prisma.js";
import { parseId } from "../utils/validate.js";

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
