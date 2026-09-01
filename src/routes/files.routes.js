import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { getFile } from "../controllers/files.controller.js";

const router = Router();

router.get("/:filename", requireAuth, getFile);

export default router;
