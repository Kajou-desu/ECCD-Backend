import { Router } from "express";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { getChildren } from "../controllers/parent.controller.js";

const router = Router();

router.get("/children", requireAuth, requireRole("Parent", "Guardian"), getChildren);

export default router;
