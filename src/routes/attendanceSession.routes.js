import { Router } from "express";
import { requireAuth, requireRole } from "../middleware/auth.js";
import multer from "multer";
import {
  sessionIpLimiter,
  sessionUserLimiter,
  frameIpLimiter,
  frameUserLimiter,
} from "../middleware/rateLimit.js";
import {
  getCurrentSession,
  getMonitor,
  startSession,
  stopSession,
} from "../controllers/attendanceSession.controller.js";
import { processFrame } from "../controllers/attendanceFrame.controller.js";

const router = Router();

// Camera frames: small in-memory JPEGs (a 640px frame is ~50 KB). Hard caps on
// size, count and fields; nothing here ever touches the disk.
const frameUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 200 * 1024, files: 1, fields: 0, parts: 2 },
  fileFilter: (_req, file, cb) => cb(null, file.mimetype === "image/jpeg"),
}).single("frame");

// Registered BEFORE the router-wide middleware below so a frame stream draws on
// its own budget (frame limiters) instead of the polling limiter's.
router.post(
  "/frame",
  frameIpLimiter,
  requireAuth,
  requireRole("Teacher", "Admin"),
  frameUserLimiter,
  frameUpload,
  processFrame,
);

// Order matters: IP ceiling first (cheap, protects the auth lookup), then
// identity + role, then the per-user limiter, which needs req.user.
router.use(sessionIpLimiter, requireAuth, requireRole("Teacher", "Admin"), sessionUserLimiter);

router.get("/current", getCurrentSession);
router.get("/monitor", getMonitor);
router.post("/start", startSession);
router.post("/stop", stopSession);

export default router;
