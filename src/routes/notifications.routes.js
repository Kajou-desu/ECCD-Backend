import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import {
  getNotifications,
  markNotificationRead,
  markAllNotificationsRead,
  dismissNotification,
  dismissAllNotifications,
} from "../controllers/notifications.controller.js";

const router = Router();

router.use(requireAuth);

router.get("/", getNotifications);
router.patch("/read-all", markAllNotificationsRead);
router.patch("/:id/read", markNotificationRead);
router.delete("/:id", dismissNotification);
router.delete("/", dismissAllNotifications);

export default router;
