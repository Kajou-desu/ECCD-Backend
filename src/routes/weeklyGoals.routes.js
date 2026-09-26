import { Router } from "express";
import { requireAuth, requireRole } from "../middleware/auth.js";
import {
  getWeeklyGoals,
  createWeeklyGoal,
  updateWeeklyGoal,
  deleteWeeklyGoal,
  updateGoalProgress,
} from "../controllers/weeklyGoals.controller.js";

const router = Router();

router.use(requireAuth, requireRole("Teacher", "Admin"));

router.get("/", getWeeklyGoals);
router.post("/", createWeeklyGoal);
router.put("/:id", updateWeeklyGoal);
router.delete("/:id", deleteWeeklyGoal);
router.put("/:id/progress", updateGoalProgress);

export default router;
