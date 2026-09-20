import { Router } from "express";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { sessionIpLimiter, sessionUserLimiter } from "../middleware/rateLimit.js";
import {
  getCurrentSession,
  startSession,
  stopSession,
} from "../controllers/attendanceSession.controller.js";

const router = Router();

// Order matters: IP ceiling first (cheap, protects the auth lookup), then
// identity + role, then the per-user limiter, which needs req.user.
router.use(sessionIpLimiter, requireAuth, requireRole("Teacher", "Admin"), sessionUserLimiter);

router.get("/current", getCurrentSession);
router.post("/start", startSession);
router.post("/stop", stopSession);

export default router;
