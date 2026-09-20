import { Router } from "express";
import { requireGateway } from "../middleware/gatewayAuth.js";
import { validateBody } from "../middleware/validateBody.js";
import { gatewayIpLimiter, gatewayDeviceLimiter } from "../middleware/rateLimit.js";
import { gatewayEventsSchema } from "../schemas/attendanceGateway.schema.js";
import { getRegistry, postEvents } from "../controllers/attendanceGateway.controller.js";

const router = Router();

// Order: IP ceiling (cheap, before any DB lookup) -> device key -> per-device limiter.
router.use(gatewayIpLimiter, requireGateway, gatewayDeviceLimiter);

router.get("/devices", getRegistry);
router.post("/events", validateBody(gatewayEventsSchema), postEvents);

export default router;
