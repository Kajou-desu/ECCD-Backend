import { Router } from "express";
import { requireAuth, requireRole } from "../middleware/auth.js";
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
// Email/SMS/push alerts are only ever sent to parents and guardians (see
// attendanceNotification.service.js); staff receive in-app notifications only,
// so these settings endpoints are closed to them.
const parentsOnly = requireRole("Parent", "Guardian");
router.get("/preferences", parentsOnly, getNotificationPreferences);
router.put("/preferences", parentsOnly, updateNotificationPreferences);
router.get("/push/public-key", parentsOnly, getPushPublicKey);
router.post("/push/subscribe", parentsOnly, subscribePush);
router.post("/push/unsubscribe", parentsOnly, unsubscribePush);
router.patch("/read-all", markAllNotificationsRead);
router.patch("/:id/read", markNotificationRead);
router.delete("/:id", dismissNotification);
router.delete("/", dismissAllNotifications);

export default router;
