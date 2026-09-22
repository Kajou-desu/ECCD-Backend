import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/lib/prisma.js", () => ({
  prisma: { attendanceSession: { updateMany: vi.fn() } },
}));

const { prisma } = await import("../src/lib/prisma.js");
const { closeStaleSessions, STALE_AFTER_MS } = await import("../src/lib/sessionCleanup.js");

beforeEach(() => vi.clearAllMocks());

describe("closeStaleSessions", () => {
  it("closes only active sessions older than the staleness cutoff", async () => {
    prisma.attendanceSession.updateMany.mockResolvedValue({ count: 2 });
    const now = new Date("2026-09-20T12:00:00.000Z");

    const count = await closeStaleSessions(now);

    const args = prisma.attendanceSession.updateMany.mock.calls[0][0];
    expect(args.where.status).toBe("active");
    expect(args.where.startedAt.lt).toEqual(new Date(now.getTime() - STALE_AFTER_MS));
    expect(args.data).toEqual({ status: "closed", endedAt: now });
    expect(count).toBe(2);
  });

  it("never throws — a DB failure must not crash the process from a timer", async () => {
    prisma.attendanceSession.updateMany.mockRejectedValue(new Error("db down"));
    await expect(closeStaleSessions()).resolves.toBe(0);
  });
});
