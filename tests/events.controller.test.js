import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    event: { findMany: vi.fn(), create: vi.fn() },
  },
}));

const { prisma } = await import("../src/lib/prisma.js");
const { getEvents, createEvent } = await import("../src/controllers/events.controller.js");

function mockRes() {
  const res = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("getEvents", () => {
  it("groups events by day and category for the requested month", async () => {
    prisma.event.findMany.mockResolvedValue([
      { date: new Date(Date.UTC(2026, 7, 15)), category: "Holiday" },
    ]);

    const req = { query: { month: "2026-08" } };
    const res = mockRes();
    const next = vi.fn();

    await getEvents(req, res, next);

    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        daily: { 15: "Holiday" },
        logs: expect.arrayContaining([expect.objectContaining({ status: "Holiday" })]),
      }),
    );
  });

  it("rejects a malformed month", async () => {
    const req = { query: { month: "not-a-month" } };
    const res = mockRes();
    const next = vi.fn();

    await getEvents(req, res, next);

    expect(prisma.event.findMany).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 400 }));
  });
});

describe("createEvent", () => {
  it("creates an event with a valid payload", async () => {
    prisma.event.create.mockResolvedValue({ id: 1, title: "Founding Day", category: "Others" });

    const req = {
      body: { title: "Founding Day", date: "2026-08-20", category: "Others" },
    };
    const res = mockRes();
    const next = vi.fn();

    await createEvent(req, res, next);

    expect(prisma.event.create).toHaveBeenCalledWith({
      data: {
        title: "Founding Day",
        date: new Date(Date.UTC(2026, 7, 20)),
        category: "Others",
        description: null,
      },
    });
    expect(res.status).toHaveBeenCalledWith(201);
  });

  it("rejects an invalid category", async () => {
    const req = {
      body: { title: "Founding Day", date: "2026-08-20", category: "Festival" },
    };
    const res = mockRes();
    const next = vi.fn();

    await createEvent(req, res, next);

    expect(prisma.event.create).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 400 }));
  });

  it("rejects a missing title", async () => {
    const req = { body: { date: "2026-08-20", category: "Others" } };
    const res = mockRes();
    const next = vi.fn();

    await createEvent(req, res, next);

    expect(prisma.event.create).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 400 }));
  });
});
