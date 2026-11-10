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

// A center has two cameras: the ENTRY camera (watches the door students come in
// by; feeds automatic attendance) and the EXIT camera (watches the door they
// leave by; feeds automatic pickup). Each sends a frame every second or two, so
// "a frame was processed in the last 30 s" means that camera and recognition are
// both up.
export const CAMERA_ROLES = ["entry", "exit"];

// Tracked per center AND per role (centerId null = Teachers with no center yet):
// one center's live camera says nothing about another's, and the entry camera
// being up says nothing about the exit camera.
// In memory on purpose: it is a liveness hint, not data, and after a restart
// it is correctly "not alive" until the next frame arrives. (The pickup job is
// also per-process, so this assumes a single API instance.)
export const CAMERA_ALIVE_MS = 30_000;
const lastFrameAt = new Map();
const cameraKey = (centerId, role) => `${role}:${centerId ?? "none"}`;

export function touchCamera(centerId = null, now = new Date(), role = "entry") {
  lastFrameAt.set(cameraKey(centerId, role), now);
}

export function isCameraAlive(centerId = null, now = new Date(), role = "entry") {
  const last = lastFrameAt.get(cameraKey(centerId, role));
  return last !== undefined && now.getTime() - last.getTime() <= CAMERA_ALIVE_MS;
}
