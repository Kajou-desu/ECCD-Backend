import { z } from "zod";
import { normalizeMac } from "../utils/macAddress.js";

// A gateway reports only WHAT it saw: a tag's MAC and its signal strength. It
// never sends a student id (it doesn't need one, and it keeps student data off
// the device) and its timestamps are not trusted — the server uses its own
// clock. An empty `events` array is a valid heartbeat.
const deviceIdentifier = z
  .string()
  .max(32)
  .transform((value, ctx) => {
    const mac = normalizeMac(value);
    if (!mac) {
      ctx.addIssue({ code: "custom", message: "Invalid device identifier" });
      return z.NEVER;
    }
    return mac;
  });

export const gatewayEventsSchema = z.object({
  events: z
    .array(
      z.object({
        deviceIdentifier,
        // dBm. Real BLE RSSI is roughly -127..0.
        rssi: z.number().int().min(-127).max(0),
      }),
    )
    .max(50),
});
