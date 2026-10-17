import { Router } from "express";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { listActivityLogs, recordExport } from "../controllers/activityLogs.controller.js";

const router = Router();

router.use(requireAuth);
// Reading the trail is Admin only (default deny).
router.get("/", requireRole("Admin"), listActivityLogs);
// Any signed-in user reports their own exports (the actor is req.user, never the body).
router.post("/export", recordExport);

export default router;
