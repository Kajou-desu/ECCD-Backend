import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { notificationIpLimiter, notificationUserLimiter } from "../middleware/rateLimit.js";
import {
  getNotifications,
  getNotificationPreferences,
  updateNotificationPreferences,
  getPushPublicKey,
  subscribePush,
  unsubscribePush,
  markNotificationRead,
  markAllNotificationsRead,
  dismissNotification,
  dismissAllNotifications,
} from "../controllers/notifications.controller.js";

const router = Router();

// IP ceiling first (unauthenticated floods), then identity, then per-user budget.
router.use(notificationIpLimiter, requireAuth, notificationUserLimiter);

router.get("/", getNotifications);
router.get("/preferences", getNotificationPreferences);
router.put("/preferences", updateNotificationPreferences);
router.get("/push/public-key", getPushPublicKey);
router.post("/push/subscribe", subscribePush);
router.post("/push/unsubscribe", unsubscribePush);
router.patch("/read-all", markAllNotificationsRead);
router.patch("/:id/read", markNotificationRead);
router.delete("/:id", dismissNotification);
router.delete("/", dismissAllNotifications);

export default router;
