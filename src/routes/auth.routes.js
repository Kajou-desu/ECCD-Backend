import { Router } from "express";
import { login, forgotPassword, resetPassword } from "../controllers/auth.controller.js";
import { validateBody } from "../middleware/validateBody.js";
import { loginSchema, forgotPasswordSchema, resetPasswordSchema } from "../schemas/auth.schema.js";

const router = Router();

// /auth/login is the standardized path (audit 5.1); /login is kept as a
// backward-compatible alias for existing clients — both call the same
// handler, nothing behaves differently between them.
router.post("/login", validateBody(loginSchema), login);
router.post("/auth/login", validateBody(loginSchema), login);
router.post("/auth/forgot-password", validateBody(forgotPasswordSchema), forgotPassword);
router.post("/auth/reset-password", validateBody(resetPasswordSchema), resetPassword);

export default router;
