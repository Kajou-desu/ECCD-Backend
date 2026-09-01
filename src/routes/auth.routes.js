import { Router } from "express";
import { login, forgotPassword, resetPassword } from "../controllers/auth.controller.js";

const router = Router();

router.post("/login", login);
router.post("/auth/forgot-password", forgotPassword);
router.post("/auth/reset-password", resetPassword);

export default router;
