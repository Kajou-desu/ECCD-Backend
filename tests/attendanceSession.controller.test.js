import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    attendanceSession: {
      findFirst: vi.fn(),
      create: vi.fn(),
      updateMany: vi.fn(),
    },
  },
}));

const { prisma } = await import("../src/lib/prisma.js");
const { getCurrentSession, startSession, stopSession } = await import(
  "../src/controllers/attendanceSession.controller.js"
);

function mockRes() {
  const res = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res;
}

const TODAY = new Date("2026-09-20T00:00:00.000Z"); // school day for the frozen clock below
const row = (over = {}) => ({
  id: 7,
  date: TODAY,
  status: "active",
  startedAt: new Date("2026-09-19T23:31:00.000Z"),
  endedAt: null,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  // 7:31 AM Manila on 2026-09-20 — still 2026-09-19 in UTC.
  vi.setSystemTime(new Date("2026-09-19T23:31:00.000Z"));
});
afterEach(() => vi.useRealTimers());

describe("getCurrentSession", () => {
  it("returns null when nothing is active", async () => {
    prisma.attendanceSession.findFirst.mockResolvedValue(null);
    const res = mockRes();
    await getCurrentSession({}, res, vi.fn());
    expect(res.json).toHaveBeenCalledWith({ session: null });
  });

  it("returns the active session without leaking who started it", async () => {
    prisma.attendanceSession.findFirst.mockResolvedValue({ ...row(), startedById: 99 });
    const res = mockRes();
    await getCurrentSession({}, res, vi.fn());
    const { session } = res.json.mock.calls[0][0];
    expect(session).toMatchObject({ id: 7, date: "2026-09-20", status: "active" });
    expect(session).not.toHaveProperty("startedById");
  });

  it("passes database errors to next() instead of responding", async () => {
    const err = new Error("db down");
    prisma.attendanceSession.findFirst.mockRejectedValue(err);
    const res = mockRes();
    const next = vi.fn();
    await getCurrentSession({}, res, next);
    expect(next).toHaveBeenCalledWith(err);
    expect(res.json).not.toHaveBeenCalled();
  });
});

describe("startSession", () => {
  it("creates a session dated in the SCHOOL timezone, owned by the token's user", async () => {
    prisma.attendanceSession.findFirst.mockResolvedValue(null);
    prisma.attendanceSession.create.mockResolvedValue(row());
    const res = mockRes();

    // Hostile body: neither date nor owner may come from the client.
    const req = { user: { id: 5 }, body: { date: "1999-01-01", startedById: 1 } };
    await startSession(req, res, vi.fn());

    const { data } = prisma.attendanceSession.create.mock.calls[0][0];
    expect(data).toEqual({ date: TODAY, startedById: 5 });
    expect(res.status).toHaveBeenCalledWith(201);
  });

  it("is idempotent: returns today's active session instead of creating another", async () => {
    prisma.attendanceSession.findFirst.mockResolvedValue(row());
    const res = mockRes();
    await startSession({ user: { id: 5 } }, res, vi.fn());
    expect(prisma.attendanceSession.create).not.toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled(); // plain 200
    expect(res.json.mock.calls[0][0].session.id).toBe(7);
  });

  it("closes a leftover session from a previous day, then starts a fresh one", async () => {
    prisma.attendanceSession.findFirst.mockResolvedValue(row({ id: 3, date: new Date("2026-09-19T00:00:00.000Z") }));
    prisma.attendanceSession.updateMany.mockResolvedValue({ count: 1 });
    prisma.attendanceSession.create.mockResolvedValue(row({ id: 8 }));
    const res = mockRes();
    await startSession({ user: { id: 5 } }, res, vi.fn());

    expect(prisma.attendanceSession.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 3, status: "active" } }),
    );
    expect(prisma.attendanceSession.create).toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(201);
  });

  it("returns the winner when a concurrent start trips the one-active-session index", async () => {
    prisma.attendanceSession.findFirst
      .mockResolvedValueOnce(null) // our initial check: nothing active yet
      .mockResolvedValueOnce(row({ id: 9 })); // after the race: the other request's session
    prisma.attendanceSession.create.mockRejectedValue(Object.assign(new Error("unique"), { code: "P2002" }));
    const res = mockRes();
    const next = vi.fn();
    await startSession({ user: { id: 5 } }, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.json.mock.calls[0][0].session.id).toBe(9);
  });

  it("does not swallow other database errors", async () => {
    prisma.attendanceSession.findFirst.mockResolvedValue(null);
    const err = Object.assign(new Error("boom"), { code: "P1001" });
    prisma.attendanceSession.create.mockRejectedValue(err);
    const next = vi.fn();
    await startSession({ user: { id: 5 } }, mockRes(), next);
    expect(next).toHaveBeenCalledWith(err);
  });
});

describe("stopSession", () => {
  it("closes the active session", async () => {
    prisma.attendanceSession.updateMany.mockResolvedValue({ count: 1 });
    const res = mockRes();
    await stopSession({ user: { id: 5 } }, res, vi.fn());

    const args = prisma.attendanceSession.updateMany.mock.calls[0][0];
    expect(args.where).toEqual({ status: "active" });
    expect(args.data).toMatchObject({ status: "closed" });
    expect(args.data.endedAt).toBeInstanceOf(Date);
    expect(res.json).toHaveBeenCalledWith({ session: null });
  });

  it("is idempotent: stopping with nothing active still succeeds", async () => {
    prisma.attendanceSession.updateMany.mockResolvedValue({ count: 0 });
    const res = mockRes();
    const next = vi.fn();
    await stopSession({ user: { id: 5 } }, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith({ session: null });
  });
});
