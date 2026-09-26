import { Router } from "express";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { getDashboardStats, getDailyTheme, upsertDailyTheme } from "../controllers/dashboard.controller.js";

const router = Router();

router.get("/stats", requireAuth, requireRole("Teacher", "Admin"), getDashboardStats);
router.get("/daily-theme", requireAuth, requireRole("Teacher", "Admin"), getDailyTheme);
router.put("/daily-theme", requireAuth, requireRole("Teacher", "Admin"), upsertDailyTheme);

export default router;
