import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/lib/prisma.js", () => ({ prisma: { student: { findMany: vi.fn() } } }));
vi.mock("../src/lib/activeSession.js", () => ({ findActiveSession: vi.fn() }));
vi.mock("../src/services/attendanceVerification.service.js", () => ({ recordSignal: vi.fn() }));
vi.mock("../src/services/recognitionClient.js", () => ({
  isRecognitionConfigured: vi.fn(),
  recognizeFrame: vi.fn(),
}));

const { prisma } = await import("../src/lib/prisma.js");
const { findActiveSession } = await import("../src/lib/activeSession.js");
const { recordSignal } = await import("../src/services/attendanceVerification.service.js");
const { isRecognitionConfigured, recognizeFrame } = await import("../src/services/recognitionClient.js");
const { processFrame, isJpeg, isConfidentMatch } = await import("../src/controllers/attendanceFrame.controller.js");

const CFG = { faceMaxDistance: 0.5, faceMinMargin: 0.05 };
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
const SESSION = { id: 3, date: new Date("2026-09-20T00:00:00.000Z") };
const face = (over = {}) => ({ box: [1, 2, 3, 4], studentId: 5, distance: 0.4, margin: 0.2, ...over });

function mockRes() {
  const res = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res;
}
const run = async (over = {}) => {
  const res = mockRes();
  const next = vi.fn();
  await processFrame({ file: { buffer: JPEG }, ...over }, res, next);
  return { res, next, body: res.json.mock.calls[0]?.[0] };
};

beforeEach(() => {
  vi.clearAllMocks();
  isRecognitionConfigured.mockReturnValue(true);
  findActiveSession.mockResolvedValue(SESSION);
  recognizeFrame.mockResolvedValue({ width: 640, height: 480, faces: [] });
  prisma.student.findMany.mockResolvedValue([{ id: 5, name: "Ana Reyes" }]);
  recordSignal.mockResolvedValue({ state: "pending" });
});

describe("isJpeg", () => {
  it("checks the actual bytes, not the declared type", () => {
    expect(isJpeg(JPEG)).toBe(true);
    expect(isJpeg(Buffer.from("<html><script>", "utf8"))).toBe(false);
    expect(isJpeg(Buffer.from([0x89, 0x50, 0x4e, 0x47]))).toBe(false); // PNG
    expect(isJpeg(Buffer.alloc(0))).toBe(false);
    expect(isJpeg(undefined)).toBe(false);
  });
});

describe("isConfidentMatch — the backend's own thresholds decide", () => {
  it("accepts a close, unambiguous match", () => {
    expect(isConfidentMatch(face(), CFG)).toBe(true);
  });
  it("rejects a match that is too far (boundary inclusive)", () => {
    expect(isConfidentMatch(face({ distance: 0.5 }), CFG)).toBe(true);
    expect(isConfidentMatch(face({ distance: 0.51 }), CFG)).toBe(false);
  });
  it("rejects a look-alike: winner barely ahead of the runner-up", () => {
    expect(isConfidentMatch(face({ margin: 0.04 }), CFG)).toBe(false);
    expect(isConfidentMatch(face({ margin: 0.05 }), CFG)).toBe(true);
  });
  it("margin null (only one student enrolled) is allowed", () => {
    expect(isConfidentMatch(face({ margin: null }), CFG)).toBe(true);
  });
  it("rejects unknown faces", () => {
    expect(isConfidentMatch(face({ studentId: null, distance: null, margin: null }), CFG)).toBe(false);
  });
});

describe("processFrame — gating", () => {
  it("503 when recognition isn't configured, without touching anything else", async () => {
    isRecognitionConfigured.mockReturnValue(false);
    const { res } = await run();
    expect(res.status).toHaveBeenCalledWith(503);
    expect(findActiveSession).not.toHaveBeenCalled();
    expect(recognizeFrame).not.toHaveBeenCalled();
  });

  it("409 when no session is active: the frame is never forwarded", async () => {
    findActiveSession.mockResolvedValue(null);
    const { res } = await run();
    expect(res.status).toHaveBeenCalledWith(409);
    expect(recognizeFrame).not.toHaveBeenCalled();
  });

  it("400 with no file, and 400 for a non-JPEG payload", async () => {
    expect((await run({ file: undefined })).res.status).toHaveBeenCalledWith(400);
    expect((await run({ file: { buffer: Buffer.from("<html>") } })).res.status).toHaveBeenCalledWith(400);
    expect(recognizeFrame).not.toHaveBeenCalled();
  });

  it("502 with a generic message when the service fails — no internals leak", async () => {
    recognizeFrame.mockRejectedValue(new Error("connect ECONNREFUSED 10.1.2.3:8001 (key=abc)"));
    const { res, body } = await run();
    expect(res.status).toHaveBeenCalledWith(502);
    expect(body).toEqual({ message: "Recognition unavailable" });
    expect(JSON.stringify(body)).not.toMatch(/10\.1\.2\.3|ECONNREFUSED|abc/);
  });
});

describe("processFrame — recognition outcomes", () => {
  it("records a face signal for a confident match and reports the name", async () => {
    recognizeFrame.mockResolvedValue({ width: 640, height: 480, faces: [face()] });
    const { body } = await run();

    expect(recordSignal).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 3, sessionDate: SESSION.date, studentId: 5, kind: "face", value: 0.4,
    }));
    expect(body.faces[0]).toEqual({ box: [1, 2, 3, 4], student: { id: 5, name: "Ana Reyes" }, verified: false });
    expect(body.verified).toEqual([]);
  });

  it("reports newly verified students", async () => {
    const arrivedAt = new Date();
    recordSignal.mockResolvedValue({ state: "verified", arrivedAt });
    recognizeFrame.mockResolvedValue({ width: 640, height: 480, faces: [face()] });
    const { body } = await run();
    expect(body.verified).toEqual([{ studentId: 5, name: "Ana Reyes", arrivedAt }]);
    expect(body.faces[0].verified).toBe(true);
  });

  it("does NOT record or name a face that misses the thresholds", async () => {
    recognizeFrame.mockResolvedValue({ width: 640, height: 480, faces: [
      face({ distance: 0.7 }),                                   // too far
      face({ studentId: 6, margin: 0.01 }),                      // look-alike
      face({ studentId: null, distance: null, margin: null }),   // unknown
    ] });
    const { body } = await run();
    expect(recordSignal).not.toHaveBeenCalled();
    expect(prisma.student.findMany).not.toHaveBeenCalled(); // not even looked up
    expect(body.faces).toHaveLength(3);
    expect(body.faces.every((f) => f.student === null)).toBe(true); // boxes only, no names
  });

  it("trusts neither face when one student appears twice in a frame", async () => {
    recognizeFrame.mockResolvedValue({ width: 640, height: 480, faces: [face(), face({ box: [9, 9, 9, 9] })] });
    const { body } = await run();
    expect(recordSignal).not.toHaveBeenCalled();
    expect(body.faces.every((f) => f.student === null)).toBe(true);
  });

  it("ignores a matched id that isn't an ACTIVE student (looked up with status filter)", async () => {
    prisma.student.findMany.mockResolvedValue([]); // inactive/unknown => filtered out by the query
    recognizeFrame.mockResolvedValue({ width: 640, height: 480, faces: [face()] });
    const { body } = await run();
    expect(prisma.student.findMany.mock.calls[0][0].where.status).toBe("active");
    expect(recordSignal).not.toHaveBeenCalled();
    expect(body.faces[0].student).toBeNull();
  });

  it("handles several students in one frame, sequentially", async () => {
    prisma.student.findMany.mockResolvedValue([{ id: 5, name: "Ana" }, { id: 6, name: "Ben" }]);
    recognizeFrame.mockResolvedValue({ width: 640, height: 480, faces: [face(), face({ studentId: 6, distance: 0.3 })] });
    await run();
    expect(recordSignal.mock.calls.map((c) => c[0].studentId)).toEqual([5, 6]);
  });

  it("passes unexpected errors to next()", async () => {
    const err = new Error("db down");
    findActiveSession.mockRejectedValue(err);
    const { next } = await run();
    expect(next).toHaveBeenCalledWith(err);
  });
});
