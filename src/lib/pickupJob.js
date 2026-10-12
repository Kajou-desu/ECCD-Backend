import { logger } from "./logger.js";
import { runPickupWatch } from "../services/pickupWatch.service.js";

// Often enough for a 15-second prompt to be created and expired on time.
const TICK_MS = 10_000;

let running = false;

async function tick() {
  // Never overlap: a slow tick must not be started twice (that could double-prompt).
  if (running) return;
  running = true;
  try {
    await runPickupWatch();
  } catch (err) {
    logger.error({ err }, "Pickup watch failed");
  } finally {
    running = false;
  }
}

// Returns the interval handle so callers can clearInterval() on shutdown.
export function startPickupJob() {
  return setInterval(tick, TICK_MS);
}
