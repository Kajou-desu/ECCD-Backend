import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";

process.env.JWT_SECRET = "test-secret-at-least-32-characters-long";
process.env.CLIENT_ORIGIN = "http://localhost:5173";

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    user: { findUnique: vi.fn(), delete: vi.fn() },
    activityLog: { create: vi.fn(), findMany: vi.fn(), count: vi.fn() },
    event: { findUnique: vi.fn(), create: vi.fn(), delete: vi.fn() },
    center: { findUnique: vi.fn(), findFirst: vi.fn(), create: vi.fn() },
  },
}));

const { prisma } = await import("../src/lib/prisma.js");
const { signToken } = await import("../src/utils/jwt.js");
const { app } = await import("../src/app.js");
const { recordActivity } = await import("../src/services/activityLog.service.js");
const { schoolDayStart } = await import("../src/controllers/activityLogs.controller.js");

function auth(role, id = 1) {
  const user = { id, email: `${role.toLowerCase()}@school.test`, role, isActive: true, tokenVersion: 0 };
  prisma.user.findUnique.mockResolvedValue(user);
  return `Bearer ${signToken(user)}`;
}

// The log is written after the response finishes; give it a tick.
const settle = () => new Promise((r) => setTimeout(r, 20));

beforeEach(() => {
  vi.clearAllMocks();
  prisma.activityLog.create.mockResolvedValue({});
  prisma.activityLog.findMany.mockResolvedValue([]);
  prisma.activityLog.count.mockResolvedValue(0);
});

describe("recordActivity", () => {
  const actor = { id: 3, email: "a@school.test", role: "Admin" };

  it("stores one row, with control characters removed and the summary truncated", async () => {
    await recordActivity({ actor, action: "student.update", summary: `x\n\u0000${"y".repeat(500)}` });
    const { data } = prisma.activityLog.create.mock.calls[0][0];
    expect(data.actorId).toBe(3);
    expect(data.summary).not.toMatch(/[\u0000-\u001f]/);
    expect(data.summary.length).toBe(300);
  });

  it("skips an entry with no actor or no summary", async () => {
    await recordActivity({ actor: null, action: "a.b", summary: "x" });
    await recordActivity({ actor, action: "a.b", summary: "" });
    expect(prisma.activityLog.create).not.toHaveBeenCalled();
  });

  it("never throws when the database fails", async () => {
    prisma.activityLog.create.mockRejectedValueOnce(new Error("db down"));
    await expect(recordActivity({ actor, action: "a.b", summary: "x" })).resolves.toBeUndefined();
  });
});

describe("GET /api/activity-logs", () => {
  it("401 without a token, 403 for every role but Admin", async () => {
    expect((await request(app).get("/api/activity-logs")).status).toBe(401);
    for (const role of ["Teacher", "Parent", "Guardian"]) {
      const res = await request(app).get("/api/activity-logs").set("Authorization", auth(role));
      expect(res.status).toBe(403);
    }
    expect(prisma.activityLog.findMany).not.toHaveBeenCalled();
  });

  it("lists newest first with paging for an Admin", async () => {
    prisma.activityLog.findMany.mockResolvedValue([{ id: 2 }]);
    prisma.activityLog.count.mockResolvedValue(51);
    const res = await request(app).get("/api/activity-logs?page=2&pageSize=25").set("Authorization", auth("Admin"));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ logs: [{ id: 2 }], total: 51, page: 2, pageSize: 25 });
    const arg = prisma.activityLog.findMany.mock.calls[0][0];
    expect(arg.skip).toBe(25);
    expect(arg.take).toBe(25);
    expect(arg.orderBy).toEqual([{ createdAt: "desc" }, { id: "desc" }]);
  });

  it("filters by category, actor, school-day range and text", async () => {
    const res = await request(app)
      .get("/api/activity-logs")
      .query({ category: "student", actorId: "4", from: "2026-10-12", to: "2026-10-13", q: "Ana" })
      .set("Authorization", auth("Admin"));
    expect(res.status).toBe(200);
    const { where } = prisma.activityLog.findMany.mock.calls[0][0];
    expect(where.action).toEqual({ startsWith: "student." });
    expect(where.actorId).toBe(4);
    // Manila is UTC+8: 12 Oct 00:00 there is 11 Oct 16:00Z; the range ends before 14 Oct 00:00 there.
    expect(where.createdAt.gte.toISOString()).toBe("2026-10-11T16:00:00.000Z");
    expect(where.createdAt.lt.toISOString()).toBe("2026-10-13T16:00:00.000Z");
    expect(where.OR).toHaveLength(2);
  });

  it.each([
    ["category=nope"],
    ["pageSize=101"],
    ["page=0"],
    ["actorId=abc"],
    ["from=2026-13-40"],
    ["from=2026-10-14&to=2026-10-12"],
  ])("400 for %s", async (qs) => {
    const res = await request(app).get(`/api/activity-logs?${qs}`).set("Authorization", auth("Admin"));
    expect(res.status).toBe(400);
    expect(prisma.activityLog.findMany).not.toHaveBeenCalled();
  });
});

describe("schoolDayStart", () => {
  it("is midnight in the school timezone", () => {
    expect(schoolDayStart("2026-10-12", "Asia/Manila").toISOString()).toBe("2026-10-11T16:00:00.000Z");
    expect(schoolDayStart("2026-10-12", "America/New_York").toISOString()).toBe("2026-10-12T04:00:00.000Z");
    expect(schoolDayStart("2026-10-12", "UTC").toISOString()).toBe("2026-10-12T00:00:00.000Z");
  });
});

describe("POST /api/activity-logs/export", () => {
  it("records the export against the signed-in user, not the body", async () => {
    const res = await request(app)
      .post("/api/activity-logs/export")
      .set("Authorization", auth("Teacher", 9))
      .send({ kind: "students", rows: 12, actorId: 1, actorEmail: "evil@x.test" });
    expect(res.status).toBe(204);
    const { data } = prisma.activityLog.create.mock.calls[0][0];
    expect(data).toMatchObject({ actorId: 9, actorEmail: "teacher@school.test", action: "export.csv" });
    expect(data.summary).toBe("Exported Student list (12 rows)");
  });

  it("401 without a token; 400 for an unknown kind or bad row count", async () => {
    expect((await request(app).post("/api/activity-logs/export").send({ kind: "students" })).status).toBe(401);
    const a = auth("Teacher");
    expect((await request(app).post("/api/activity-logs/export").set("Authorization", a).send({ kind: "x" })).status).toBe(400);
    expect((await request(app).post("/api/activity-logs/export").set("Authorization", a).send({ kind: "students", rows: -1 })).status).toBe(400);
    expect(prisma.activityLog.create).not.toHaveBeenCalled();
  });
});

describe("audited routes", () => {
  it("logs a successful event create with its title", async () => {
    prisma.event.create.mockResolvedValue({ id: 7, title: "Founding Day" });
    const res = await request(app)
      .post("/api/events")
      .set("Authorization", auth("Teacher", 5))
      .send({ title: "Founding Day", date: "2026-08-20", category: "Event" });
    expect(res.status).toBe(201);
    await settle();
    expect(prisma.activityLog.create.mock.calls[0][0].data).toMatchObject({
      actorId: 5,
      action: "event.create",
      targetType: "event",
      targetId: 7,
      summary: 'Created event "Founding Day"',
    });
  });

  it("does not log a refused or failed request", async () => {
    await request(app).post("/api/events").set("Authorization", auth("Parent")).send({ title: "x" }); // 403
    await request(app).post("/api/events").set("Authorization", auth("Teacher")).send({}); // 400
    await settle();
    expect(prisma.activityLog.create).not.toHaveBeenCalled();
  });

  it("reads the name before a delete so the entry can say what was removed", async () => {
    prisma.event.findUnique.mockResolvedValue({ title: "Field Trip" });
    prisma.event.delete.mockResolvedValue({});
    const res = await request(app).delete("/api/events/3").set("Authorization", auth("Admin"));
    expect(res.status).toBe(204);
    await settle();
    expect(prisma.activityLog.create.mock.calls[0][0].data).toMatchObject({
      action: "event.delete",
      targetId: 3,
      summary: 'Deleted event "Field Trip"',
    });
  });

  it("still succeeds when writing the log fails", async () => {
    prisma.activityLog.create.mockRejectedValue(new Error("db down"));
    prisma.event.create.mockResolvedValue({ id: 8, title: "Open House" });
    const res = await request(app)
      .post("/api/events")
      .set("Authorization", auth("Admin"))
      .send({ title: "Open House", date: "2026-08-21", category: "Event" });
    expect(res.status).toBe(201);
  });
});
