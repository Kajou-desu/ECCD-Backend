import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    event: { findMany: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn() },
  },
}));

const { prisma } = await import("../src/lib/prisma.js");
const { getEvents, createEvent, updateEvent, deleteEvent } = await import("../src/controllers/events.controller.js");

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
      {
        id: 1,
        title: "Founding Day",
        description: "School celebration",
        date: new Date(Date.UTC(2026, 7, 15)),
        category: "Holiday",
      },
    ]);

    const req = { query: { month: "2026-08" } };
    const res = mockRes();
    const next = vi.fn();

    await getEvents(req, res, next);

    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        daily: { 15: "Holiday" },
        logs: expect.arrayContaining([
          expect.objectContaining({
            id: 1,
            title: "Founding Day",
            description: "School celebration",
            dateKey: "2026-08-15",
            status: "Holiday",
          }),
        ]),
      }),
    );
  });

  it("maps legacy Others events to the Event category", async () => {
    prisma.event.findMany.mockResolvedValue([
      {
        id: 2,
        title: "Class Picnic",
        description: null,
        date: new Date(Date.UTC(2026, 7, 20)),
        category: "Others",
      },
    ]);

    const res = mockRes();
    await getEvents({ query: { month: "2026-08" } }, res, vi.fn());

    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        daily: { 20: "Event" },
        logs: [expect.objectContaining({ status: "Event" })],
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
      body: { title: "Founding Day", date: "2026-08-20", category: "Event" },
    };
    const res = mockRes();
    const next = vi.fn();

    await createEvent(req, res, next);

    expect(prisma.event.create).toHaveBeenCalledWith({
      data: {
        title: "Founding Day",
        date: new Date(Date.UTC(2026, 7, 20)),
        category: "Event",
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

describe("updateEvent", () => {
  it("updates an event with validated fields", async () => {
    prisma.event.update.mockResolvedValue({ id: 1, title: "Updated Day" });
    const req = {
      params: { id: "1" },
      body: {
        title: "Updated Day",
        date: "2026-08-21",
        category: "Event",
        description: "Updated details",
      },
    };
    const res = mockRes();
    const next = vi.fn();

    await updateEvent(req, res, next);

    expect(prisma.event.update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: {
        title: "Updated Day",
        date: new Date(Date.UTC(2026, 7, 21)),
        category: "Event",
        description: "Updated details",
      },
    });
    expect(res.json).toHaveBeenCalledWith({ id: 1, title: "Updated Day" });
    expect(next).not.toHaveBeenCalled();
  });

  it("returns 404 when the event does not exist", async () => {
    prisma.event.update.mockRejectedValue({ code: "P2025" });
    const res = mockRes();

    await updateEvent(
      { params: { id: "1" }, body: { title: "Updated", date: "2026-08-21", category: "Event" } },
      res,
      vi.fn(),
    );

    expect(res.status).toHaveBeenCalledWith(404);
  });
});

describe("deleteEvent", () => {
  it("deletes an event and returns no content", async () => {
    prisma.event.delete.mockResolvedValue({ id: 1 });
    const res = mockRes();
    res.send = vi.fn().mockReturnValue(res);

    await deleteEvent({ params: { id: "1" } }, res, vi.fn());

    expect(prisma.event.delete).toHaveBeenCalledWith({ where: { id: 1 } });
    expect(res.status).toHaveBeenCalledWith(204);
    expect(res.send).toHaveBeenCalled();
  });

  it("returns 404 when the event does not exist", async () => {
    prisma.event.delete.mockRejectedValue({ code: "P2025" });
    const res = mockRes();

    await deleteEvent({ params: { id: "1" } }, res, vi.fn());

    expect(res.status).toHaveBeenCalledWith(404);
  });
});
