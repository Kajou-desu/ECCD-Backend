import { Router } from "express";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { getEvents, createEvent } from "../controllers/events.controller.js";

const router = Router();

router.get("/", requireAuth, requireRole("Teacher", "Admin"), getEvents);
router.post("/", requireAuth, requireRole("Teacher", "Admin"), createEvent);

export default router;
