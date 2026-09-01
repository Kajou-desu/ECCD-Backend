import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { upload } from "../middleware/upload.js";
import { submitStudentWork } from "../controllers/submissions.controller.js";

const router = Router();

router.post("/", requireAuth, upload.single("file"), submitStudentWork);

export default router;
