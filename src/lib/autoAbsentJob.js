import { logger } from "./logger.js";
import { runAutoAbsent } from "../services/autoAbsent.service.js";

// Session ends are minute-precise, and each group is only ever done once, so a
// minute is frequent enough and repeated ticks are harmless.
const TICK_MS = 60_000;

let running = false;

async function tick() {
  if (running) return; // never overlap a slow tick
  running = true;
  try {
    await runAutoAbsent();
  } catch (err) {
    logger.error({ err }, "Automatic absent marking failed");
  } finally {
    running = false;
  }
}

// Returns the interval handle so callers can clearInterval() on shutdown.
export function startAutoAbsentJob() {
  return setInterval(tick, TICK_MS);
}
