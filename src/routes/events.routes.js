import { Router } from "express";
import { requireAuth, requireRole } from "../middleware/auth.js";
import {
	getEvents,
	createEvent,
	updateEvent,
	deleteEvent,
} from "../controllers/events.controller.js";

const router = Router();

router.get("/", requireAuth, requireRole("Teacher", "Admin"), getEvents);
router.post("/", requireAuth, requireRole("Teacher", "Admin"), createEvent);
router.put("/:id", requireAuth, requireRole("Teacher", "Admin"), updateEvent);
router.delete("/:id", requireAuth, requireRole("Teacher", "Admin"), deleteEvent);

export default router;
