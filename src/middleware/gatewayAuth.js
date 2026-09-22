import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";
import { parseDeviceKey, secretMatches } from "../utils/deviceKey.js";

const KEY_HEADER = "x-device-key";
const TOUCH_INTERVAL_MS = 30_000;

// Compared against when the id doesn't exist, so an unknown id and a wrong
// secret cost the same and can't be told apart by timing.
const DUMMY_HASH = "0".repeat(64);

// Authenticates an ESP32 gateway by its key. Default deny: anything missing,
// malformed, unknown, disabled or mismatched gets the same 401. Sets
// req.gateway = { id, name }; the key itself is never logged or echoed.
export async function requireGateway(req, res, next) {
  const parsed = parseDeviceKey(req.get(KEY_HEADER));
  if (!parsed) {
    return res.status(401).json({ message: "Missing or invalid device key" });
  }

  try {
    const gateway = await prisma.bleGateway.findUnique({
      where: { id: parsed.id },
      select: { id: true, name: true, keyHash: true, enabled: true, lastSeenAt: true },
    });

    const matches = secretMatches(parsed.secret, gateway?.keyHash ?? DUMMY_HASH);
    if (!gateway || !gateway.enabled || !matches) {
      return res.status(401).json({ message: "Invalid device key" });
    }

    req.gateway = { id: gateway.id, name: gateway.name };

    // Heartbeat for "gateway online" — throttled so a chatty gateway doesn't
    // turn every request into a write. Never blocks or fails the request.
    const last = gateway.lastSeenAt?.getTime() ?? 0;
    if (Date.now() - last > TOUCH_INTERVAL_MS) {
      Promise.resolve(
        prisma.bleGateway.update({ where: { id: gateway.id }, data: { lastSeenAt: new Date() } }),
      ).catch((err) => logger.warn({ err, gatewayId: gateway.id }, "Gateway heartbeat update failed"));
    }

    next();
  } catch (err) {
    next(err);
  }
}
