import { Router } from "express";
import { login, logout, forgotPassword, resetPassword } from "../controllers/auth.controller.js";
import { forgotPasswordLimiter } from "../middleware/rateLimit.js";
import { validateBody } from "../middleware/validateBody.js";
import { loginSchema, forgotPasswordSchema, resetPasswordSchema } from "../schemas/auth.schema.js";
import { auditLogin } from "../middleware/auditRoutes.js";

const router = Router();

// /auth/login is the standardized path (audit 5.1); /login is kept as a
// backward-compatible alias for existing clients — both call the same
// handler, nothing behaves differently between them.
router.post("/login", validateBody(loginSchema), auditLogin, login);
router.post("/auth/login", validateBody(loginSchema), auditLogin, login);
router.post("/auth/logout", logout);
router.post("/auth/forgot-password", forgotPasswordLimiter, validateBody(forgotPasswordSchema), forgotPassword);
router.post("/auth/reset-password", validateBody(resetPasswordSchema), resetPassword);

export default router;
