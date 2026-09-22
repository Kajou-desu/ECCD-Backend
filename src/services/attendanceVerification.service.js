import { prisma } from "../lib/prisma.js";
import { env } from "../config/env.js";

// Face + BLE => verified attendance.
//
// A student is marked present only when BOTH signals — a face match from the
// camera and a BLE tag sighting from the gateway — are present, fresh, and
// stable. Neither alone is enough. The decision logic is in pure functions
// (mergeSignal / isSignalPresent / evaluate) so it can be tested exhaustively;
// recordSignal is the thin database wrapper around them.

// Weight of the newest reading in the smoothed score. RSSI in particular jumps
// around by 10+ dB between adjacent packets, so one reading is never trusted.
const SMOOTHING = 0.5;

// Folds a new reading into the previous signal row (or starts a new run).
// `prev` is { score, hits, lastSeenAt } | null.
export function mergeSignal(prev, value, now, cfg = env.verification) {
  const continuing = prev && now.getTime() - prev.lastSeenAt.getTime() <= cfg.windowMs;
  return {
    score: continuing ? SMOOTHING * value + (1 - SMOOTHING) * prev.score : value,
    hits: continuing ? prev.hits + 1 : 1,
    lastSeenAt: now,
  };
}

// Is this signal currently a valid piece of evidence? Fresh, seen enough times
// in a row, and good enough (close enough match / near enough tag).
export function isSignalPresent(kind, signal, now, cfg = env.verification) {
  if (!signal) return false;
  if (now.getTime() - signal.lastSeenAt.getTime() > cfg.windowMs) return false;
  if (signal.hits < cfg.minHits) return false;
  return kind === "face" ? signal.score <= cfg.faceMaxDistance : signal.score >= cfg.bleMinRssi;
}

// "verified" only if both signals are present; otherwise "pending".
export function evaluate({ face, ble, now, cfg = env.verification }) {
  return isSignalPresent("face", face, now, cfg) && isSignalPresent("ble", ble, now, cfg)
    ? "verified"
    : "pending";
}

const SIGNAL_SELECT = { score: true, hits: true, lastSeenAt: true };
const keyOf = (sessionId, studentId, kind) => ({ sessionId_studentId_kind: { sessionId, studentId, kind } });

// Creates the attendance record + its audit row atomically — but only if the
// student has NO record for that day yet. A record that already exists (a
// teacher marked it, an earlier verification, an excused absence) is never
// overwritten; the unique (studentId, date) key makes this race-safe.
async function markVerified({ sessionId, sessionDate, studentId, face, ble, now }) {
  return prisma.$transaction(async (tx) => {
    const { count } = await tx.attendance.createMany({
      data: [{ studentId, date: sessionDate, status: "present", arrivedAt: now }],
      skipDuplicates: true,
    });
    if (count === 0) return { state: "already_recorded" };

    const attendance = await tx.attendance.findUnique({
      where: { studentId_date: { studentId, date: sessionDate } },
      select: { id: true },
    });
    await tx.attendanceVerification.create({
      data: {
        attendanceId: attendance.id,
        sessionId,
        faceDistance: face.score,
        bleRssi: ble.score,
        verifiedAt: now,
      },
    });
    return { state: "verified", arrivedAt: now };
  });
}

// Records one sighting and, if it completes the pair, marks the student present.
// Callers must already have established that the session is active and the
// student exists and is active. `kind` is "face" (value = match distance) or
// "ble" (value = RSSI). Returns { state: "pending" | "verified" | "already_recorded" }.
export async function recordSignal({ sessionId, sessionDate, studentId, kind, value, now = new Date() }) {
  const prev = await prisma.attendanceSignal.findUnique({
    where: keyOf(sessionId, studentId, kind),
    select: SIGNAL_SELECT,
  });
  const next = mergeSignal(prev, value, now);

  await prisma.attendanceSignal.upsert({
    where: keyOf(sessionId, studentId, kind),
    create: { sessionId, studentId, kind, ...next },
    update: next,
  });

  const otherKind = kind === "face" ? "ble" : "face";
  const other = await prisma.attendanceSignal.findUnique({
    where: keyOf(sessionId, studentId, otherKind),
    select: SIGNAL_SELECT,
  });

  const face = kind === "face" ? next : other;
  const ble = kind === "ble" ? next : other;
  if (evaluate({ face, ble, now }) !== "verified") return { state: "pending" };

  return markVerified({ sessionId, sessionDate, studentId, face, ble, now });
}
