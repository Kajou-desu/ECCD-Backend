import { Router } from "express";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { getEvents } from "../controllers/events.controller.js";

const router = Router();

router.get("/", requireAuth, requireRole("Teacher", "Admin"), getEvents);

export default router;
