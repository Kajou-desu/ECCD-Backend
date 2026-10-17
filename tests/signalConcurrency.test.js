import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/lib/prisma.js", () => ({
  prisma: { studentBleDevice: { findMany: vi.fn() } },
}));
vi.mock("../src/lib/activeSession.js", () => ({ findActiveSession: vi.fn() }));
vi.mock("../src/services/attendanceVerification.service.js", () => ({ recordSignal: vi.fn() }));

const { prisma } = await import("../src/lib/prisma.js");
const { findActiveSession } = await import("../src/lib/activeSession.js");
const { recordSignal } = await import("../src/services/attendanceVerification.service.js");
const { mapWithLimit } = await import("../src/utils/concurrency.js");
const { postEvents } = await import("../src/controllers/attendanceGateway.controller.js");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe("mapWithLimit", () => {
  it("returns results in input order and never exceeds the limit", async () => {
    let running = 0;
    let peak = 0;
    const out = await mapWithLimit([30, 5, 20, 1, 10, 2], 3, async (ms, i) => {
      running++;
      peak = Math.max(peak, running);
      await sleep(ms);
      running--;
      return i;
    });
    expect(out).toEqual([0, 1, 2, 3, 4, 5]);
    expect(peak).toBe(3);
  });

  it("handles an empty list and a limit below 1", async () => {
    expect(await mapWithLimit([], 4, async () => 1)).toEqual([]);
    expect(await mapWithLimit([1, 2], 0, async (x) => x * 2)).toEqual([2, 4]);
  });

  it("rejects with the first failure after the running calls finish", async () => {
    const done = [];
    await expect(
      mapWithLimit([1, 2, 3], 3, async (x) => {
        await sleep(x * 5);
        done.push(x);
        if (x === 1) throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(done).toEqual([1, 2, 3]); // nothing left running in the background
  });
});

describe("gateway events", () => {
  const run = async (events) => {
    const res = { json: vi.fn() };
    await postEvents({ body: { events } }, res, (err) => {
      throw err;
    });
    return res.json.mock.calls[0][0];
  };

  beforeEach(() => {
    vi.clearAllMocks();
    findActiveSession.mockResolvedValue({ id: 1, date: new Date("2026-10-13") });
  });

  it("records different students together but one student's tags in order", async () => {
    // students 1 and 2 have a tag each; student 3 carries two tags.
    prisma.studentBleDevice.findMany.mockResolvedValue([
      { deviceIdentifier: "AA:00", studentId: 1 },
      { deviceIdentifier: "BB:00", studentId: 2 },
      { deviceIdentifier: "CC:01", studentId: 3 },
      { deviceIdentifier: "CC:02", studentId: 3 },
    ]);
    const inFlight = new Set();
    let overlappedSameStudent = false;
    let peak = 0;
    const log = [];
    recordSignal.mockImplementation(async ({ studentId, value }) => {
      if (inFlight.has(studentId)) overlappedSameStudent = true;
      inFlight.add(studentId);
      peak = Math.max(peak, inFlight.size);
      log.push(`${studentId}:${value}`);
      await sleep(15);
      inFlight.delete(studentId);
      return { state: "pending" };
    });

    const body = await run([
      { deviceIdentifier: "AA:00", rssi: -50 },
      { deviceIdentifier: "CC:01", rssi: -60 },
      { deviceIdentifier: "BB:00", rssi: -55 },
      { deviceIdentifier: "CC:02", rssi: -62 },
      { deviceIdentifier: "ZZ:99", rssi: -40 }, // not registered
    ]);

    expect(body).toEqual({ sessionActive: true, accepted: 4 });
    expect(peak).toBe(3); // three students at once
    expect(overlappedSameStudent).toBe(false);
    expect(log.filter((l) => l.startsWith("3:"))).toEqual(["3:-60", "3:-62"]); // arrival order kept
    expect(recordSignal).toHaveBeenCalledTimes(4);
  });

  it("answers an unaffected heartbeat and an idle gateway as before", async () => {
    expect(await run([])).toEqual({ sessionActive: true, accepted: 0 });
    findActiveSession.mockResolvedValue(null);
    expect(await run([{ deviceIdentifier: "AA:00", rssi: -50 }])).toEqual({ sessionActive: false, accepted: 0 });
  });
});
