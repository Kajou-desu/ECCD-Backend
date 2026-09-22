import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    attendanceSession: { findFirst: vi.fn(), create: vi.fn(), updateMany: vi.fn() },
    attendanceSignal: { findMany: vi.fn() },
    attendanceVerification: { findMany: vi.fn() },
    bleGateway: { findFirst: vi.fn() },
  },
}));
vi.mock("../src/services/recognitionClient.js", () => ({ isRecognitionConfigured: vi.fn(() => true) }));

const { prisma } = await import("../src/lib/prisma.js");
const { isRecognitionConfigured } = await import("../src/services/recognitionClient.js");
const { getMonitor } = await import("../src/controllers/attendanceSession.controller.js");

const NOW = new Date("2026-09-20T00:00:30.000Z");
const ago = (secs) => new Date(NOW.getTime() - secs * 1000);
const SESSION = { id: 3, date: new Date("2026-09-20T00:00:00.000Z"), status: "active", startedAt: ago(60), endedAt: null };

// Defaults (env): faceMaxDistance 0.5, bleMinRssi -70, window 30s, minHits 2
const sig = (studentId, name, kind, score, hits, lastSeenAt) => ({
  studentId, kind, score, hits, lastSeenAt, student: { name },
});
const verification = (studentId, name, verifiedAt) => ({ verifiedAt, attendance: { studentId, student: { name } } });

function mockRes() {
  const res = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res;
}
async function monitor() {
  const res = mockRes();
  const next = vi.fn();
  await getMonitor({}, res, next);
  return { body: res.json.mock.calls[0]?.[0], next };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  prisma.attendanceSession.findFirst.mockResolvedValue(SESSION);
  prisma.attendanceSignal.findMany.mockResolvedValue([]);
  prisma.attendanceVerification.findMany.mockResolvedValue([]);
  prisma.bleGateway.findFirst.mockResolvedValue({ id: 1 });
  isRecognitionConfigured.mockReturnValue(true);
});
afterEach(() => vi.useRealTimers());

describe("getMonitor", () => {
  it("returns { session: null } and reads nothing else when no session is active", async () => {
    prisma.attendanceSession.findFirst.mockResolvedValue(null);
    const { body } = await monitor();
    expect(body).toEqual({ session: null });
    expect(prisma.attendanceSignal.findMany).not.toHaveBeenCalled();
  });

  it("classifies verified / face-only / BLE-only, sorted, with counts", async () => {
    prisma.attendanceSignal.findMany.mockResolvedValue([
      sig(2, "Ben", "face", 0.3, 3, ago(2)),
      sig(3, "Cara", "ble", -55, 3, ago(2)),
      sig(1, "Ana", "face", 0.3, 3, ago(2)),
      sig(1, "Ana", "ble", -55, 3, ago(2)),
    ]);
    prisma.attendanceVerification.findMany.mockResolvedValue([verification(1, "Ana", ago(1))]);

    const { body } = await monitor();
    expect(body.students.map((s) => [s.name, s.status])).toEqual([
      ["Ana", "verified"], ["Ben", "face_only"], ["Cara", "ble_only"],
    ]);
    expect(body.counts).toEqual({ verified: 1, faceOnly: 1, bleOnly: 1 });
    expect(body.session).toMatchObject({ id: 3, date: "2026-09-20", status: "active" });
  });

  it("does not show evidence the verifier itself would ignore", async () => {
    prisma.attendanceSignal.findMany.mockResolvedValue([
      sig(1, "Stale", "face", 0.3, 3, ago(40)),   // older than the 30 s window
      sig(2, "OneHit", "ble", -55, 1, ago(2)),    // a single stray reading
      sig(3, "TooFar", "ble", -90, 5, ago(2)),    // weak signal = not near the door
      sig(4, "BadMatch", "face", 0.7, 5, ago(2)), // poor face match
    ]);
    const { body } = await monitor();
    expect(body.students).toEqual([]);
    expect(body.counts).toEqual({ verified: 0, faceOnly: 0, bleOnly: 0 });
  });

  it("keeps a verified student listed even after their live signals go stale", async () => {
    prisma.attendanceSignal.findMany.mockResolvedValue([sig(1, "Ana", "face", 0.3, 3, ago(300))]);
    prisma.attendanceVerification.findMany.mockResolvedValue([verification(1, "Ana", ago(200))]);
    const { body } = await monitor();
    expect(body.students).toHaveLength(1);
    expect(body.students[0]).toMatchObject({ studentId: 1, name: "Ana", status: "verified" });
  });

  it("orders verified students most-recent first", async () => {
    prisma.attendanceVerification.findMany.mockResolvedValue([
      verification(1, "Ana", ago(30)), verification(2, "Ben", ago(5)), verification(3, "Cara", ago(15)),
    ]);
    const { body } = await monitor();
    expect(body.students.map((s) => s.name)).toEqual(["Ben", "Cara", "Ana"]);
  });

  it("reports gateway and recognition availability", async () => {
    let { body } = await monitor();
    expect(body).toMatchObject({ gatewayOnline: true, recognitionAvailable: true });
    // "online" = seen within 30 s
    expect(prisma.bleGateway.findFirst.mock.calls[0][0].where.lastSeenAt.gt).toEqual(ago(30));
    expect(prisma.bleGateway.findFirst.mock.calls[0][0].where.enabled).toBe(true);

    prisma.bleGateway.findFirst.mockResolvedValue(null);
    isRecognitionConfigured.mockReturnValue(false);
    ({ body } = await monitor());
    expect(body).toMatchObject({ gatewayOnline: false, recognitionAvailable: false });
  });

  it("only reads the ACTIVE session's signals and verifications", async () => {
    await monitor();
    expect(prisma.attendanceSignal.findMany.mock.calls[0][0].where).toEqual({ sessionId: 3 });
    expect(prisma.attendanceVerification.findMany.mock.calls[0][0].where).toEqual({ sessionId: 3 });
  });

  it("passes database errors to next()", async () => {
    const err = new Error("db down");
    prisma.attendanceSignal.findMany.mockRejectedValue(err);
    const { next } = await monitor();
    expect(next).toHaveBeenCalledWith(err);
  });
});
