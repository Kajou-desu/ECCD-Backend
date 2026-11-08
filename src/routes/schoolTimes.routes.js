import { Router } from "express";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { schoolTimesUserLimiter } from "../middleware/rateLimit.js";
import { getSchoolTimes, updateSchoolTimes } from "../controllers/schoolTimes.controller.js";
import { auditSchoolTimesUpdate } from "../middleware/auditRoutes.js";

const router = Router();

router.use(requireAuth);
router.get("/", requireRole("Teacher", "Admin"), getSchoolTimes);
router.put("/", requireRole("Teacher", "Admin"), schoolTimesUserLimiter, auditSchoolTimesUpdate, updateSchoolTimes);

export default router;
