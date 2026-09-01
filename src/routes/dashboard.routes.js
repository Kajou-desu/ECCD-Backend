import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { getDashboardStats, getDailyTheme } from "../controllers/dashboard.controller.js";

const router = Router();

router.get("/stats", requireAuth, getDashboardStats);
router.get("/daily-theme", requireAuth, getDailyTheme);

export default router;
