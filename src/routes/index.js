import { Router } from "express";
import authRoutes from "./auth.routes.js";
import studentRoutes from "./students.routes.js";
import attendanceRoutes from "./attendance.routes.js";
import albumRoutes from "./albums.routes.js";
import materialRoutes from "./materials.routes.js";
import submissionRoutes from "./submissions.routes.js";
import parentRoutes from "./parent.routes.js";
import eventRoutes from "./events.routes.js";
import dashboardRoutes from "./dashboard.routes.js";
import fileRoutes from "./files.routes.js";
import userRoutes from "./users.routes.js";
import profileRoutes from "./profile.routes.js";
import notificationRoutes from "./notifications.routes.js";

const router = Router();

// Mounted at both /api and /api/v1 (see app.js) — paths below are relative
// to whichever prefix was used.
router.use("/", authRoutes); // /login, /auth/login, /auth/forgot-password, /auth/reset-password
router.use("/students", studentRoutes); // /api/students/*
router.use("/attendance", attendanceRoutes); // /api/attendance/*
router.use("/albums", albumRoutes); // /api/albums
router.use("/materials", materialRoutes); // /api/materials/*
router.use("/submissions", submissionRoutes); // /api/submissions
router.use("/parent", parentRoutes); // /api/parent/children
router.use("/events", eventRoutes); // /api/events
router.use("/dashboard", dashboardRoutes); // /api/dashboard/*
router.use("/files", fileRoutes); // /api/files/:filename (public - see files.routes.js)
router.use("/users", userRoutes); // /api/users/all, /api/users/register, /api/users/delete/:id
router.use("/profile", profileRoutes); // /api/profile/update
router.use("/notifications", notificationRoutes); // /api/notifications/*

export default router;
