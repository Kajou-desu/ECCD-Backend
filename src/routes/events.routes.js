import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { getEvents } from "../controllers/events.controller.js";

const router = Router();

router.get("/", requireAuth, getEvents);

export default router;
