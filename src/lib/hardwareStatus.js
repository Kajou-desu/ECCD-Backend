import { prisma } from "./prisma.js";

// Is the "seen" side of attendance actually alive? Used by the live monitor and
// by the pickup watch: a student only counts as "gone" if the hardware that
// would have seen them was working, otherwise a dead ESP32, a closed laptop or
// a dropped Wi-Fi would make the whole class look like it left.

// A gateway that has been heard from this recently counts as online.
export const GATEWAY_ONLINE_MS = 30_000;

export async function isGatewayOnline(now = new Date()) {
  const gateway = await prisma.bleGateway.findFirst({
    where: { enabled: true, lastSeenAt: { gt: new Date(now.getTime() - GATEWAY_ONLINE_MS) } },
    select: { id: true },
  });
  return Boolean(gateway);
}

// The teacher's camera streams a frame every second or two, so "a frame was
// processed in the last 30 s" means the camera and recognition are both up.
// Tracked per center (null = Teachers with no center yet): one center's live
// camera says nothing about another's.
// In memory on purpose: it is a liveness hint, not data, and after a restart
// it is correctly "not alive" until the next frame arrives. (The pickup job is
// also per-process, so this assumes a single API instance.)
export const CAMERA_ALIVE_MS = 30_000;
const lastFrameAt = new Map();

export function touchCamera(centerId = null, now = new Date()) {
  lastFrameAt.set(centerId ?? null, now);
}

export function isCameraAlive(centerId = null, now = new Date()) {
  const last = lastFrameAt.get(centerId ?? null);
  return last !== undefined && now.getTime() - last.getTime() <= CAMERA_ALIVE_MS;
}
