import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";

process.env.JWT_SECRET = "test-secret-at-least-32-characters-long";
process.env.CLIENT_ORIGIN = "http://localhost:5173";

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    noClassDay: { findMany: vi.fn(), createMany: vi.fn(), delete: vi.fn() },
  },
}));

const { prisma } = await import("../src/lib/prisma.js");
const { signToken } = await import("../src/utils/jwt.js");
const { app } = await import("../src/app.js");
const { weekdaysBetween } = await import("../src/controllers/noClassDays.controller.js");

const URL = "/api/no-class-days";

function auth(role) {
  const user = { id: 4, email: `${role.toLowerCase()}@school.test`, role, isActive: true, tokenVersion: 0 };
  prisma.user.findUnique.mockResolvedValue(user);
  return `Bearer ${signToken(user)}`;
}

beforeEach(() => {
  vi.clearAllMocks();
  prisma.noClassDay.findMany.mockResolvedValue([]);
  prisma.noClassDay.createMany.mockImplementation(async ({ data }) => ({ count: data.length }));
});

describe("weekdaysBetween", () => {
  it("skips Saturdays and Sundays", () => {
    // 2026-10-09 is a Friday, 2026-10-13 a Tuesday
    expect(weekdaysBetween("2026-10-09", "2026-10-13").map((d) => d.toISOString().slice(0, 10))).toEqual([
      "2026-10-09",
      "2026-10-12",
      "2026-10-13",
    ]);
  });
  it("is empty for a weekend", () => {
    expect(weekdaysBetween("2026-10-10", "2026-10-11")).toEqual([]);
  });
});

describe("GET /api/no-class-days", () => {
  it("lists a month for every role that can see the calendar", async () => {
    prisma.noClassDay.findMany.mockResolvedValue([{ id: 1, date: new Date("2026-10-14T00:00:00.000Z"), reason: "Typhoon" }]);
    for (const role of ["Teacher", "Admin", "Parent", "Guardian"]) {
      const res = await request(app).get(`${URL}?month=2026-10`).set("Authorization", auth(role));
      expect(res.status).toBe(200);
      expect(res.body).toEqual([{ id: 1, dateKey: "2026-10-14", reason: "Typhoon" }]);
    }
    const where = prisma.noClassDay.findMany.mock.calls[0][0].where;
    expect(where.date.gte.toISOString()).toBe("2026-10-01T00:00:00.000Z");
    expect(where.date.lt.toISOString()).toBe("2026-11-01T00:00:00.000Z");
  });

  it("needs a login and a valid month", async () => {
    expect((await request(app).get(`${URL}?month=2026-10`)).status).toBe(401);
    expect((await request(app).get(`${URL}?month=nope`).set("Authorization", auth("Teacher"))).status).toBe(400);
  });
});

describe("POST /api/no-class-days", () => {
  it("sets one day", async () => {
    const res = await request(app).post(URL).set("Authorization", auth("Teacher")).send({ from: "2026-10-14", reason: "  Typhoon  " });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ requested: 1, created: 1 });
    const { data, skipDuplicates } = prisma.noClassDay.createMany.mock.calls[0][0];
    expect(skipDuplicates).toBe(true);
    expect(data).toEqual([{ date: new Date("2026-10-14T00:00:00.000Z"), reason: "Typhoon", createdById: 4 }]);
  });

  it("sets a range, leaving weekends out, and reports days that were already set", async () => {
    prisma.noClassDay.createMany.mockResolvedValue({ count: 2 });
    const res = await request(app).post(URL).set("Authorization", auth("Admin")).send({ from: "2026-10-09", to: "2026-10-13" });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ requested: 3, created: 2 }); // one of the three already existed
    expect(prisma.noClassDay.createMany.mock.calls[0][0].data.map((d) => d.date.toISOString().slice(0, 10))).toEqual([
      "2026-10-09",
      "2026-10-12",
      "2026-10-13",
    ]);
  });

  it("refuses a weekend, a backwards range, a huge range and bad dates", async () => {
    const token = auth("Teacher");
    const post = (body) => request(app).post(URL).set("Authorization", token).send(body);
    expect((await post({ from: "2026-10-10", to: "2026-10-11" })).status).toBe(400);
    expect((await post({ from: "2026-10-14", to: "2026-10-12" })).status).toBe(400);
    expect((await post({ from: "2026-01-01", to: "2026-12-31" })).status).toBe(400);
    expect((await post({ from: "tomorrow" })).status).toBe(400);
    expect((await post({})).status).toBe(400);
    expect((await post({ from: "2026-10-14", reason: "x".repeat(201) })).status).toBe(400);
    expect(prisma.noClassDay.createMany).not.toHaveBeenCalled();
  });

  it("is staff only", async () => {
    for (const role of ["Parent", "Guardian"]) {
      const res = await request(app).post(URL).set("Authorization", auth(role)).send({ from: "2026-10-14" });
      expect(res.status).toBe(403);
    }
    expect((await request(app).post(URL).send({ from: "2026-10-14" })).status).toBe(401);
    expect(prisma.noClassDay.createMany).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/no-class-days/:id", () => {
  it("makes the day a school day again", async () => {
    prisma.noClassDay.delete.mockResolvedValue({});
    const res = await request(app).delete(`${URL}/7`).set("Authorization", auth("Teacher"));
    expect(res.status).toBe(204);
    expect(prisma.noClassDay.delete).toHaveBeenCalledWith({ where: { id: 7 } });
  });

  it("404s an unknown day, rejects a bad id, and is staff only", async () => {
    prisma.noClassDay.delete.mockRejectedValue(Object.assign(new Error("x"), { code: "P2025" }));
    expect((await request(app).delete(`${URL}/7`).set("Authorization", auth("Admin"))).status).toBe(404);
    expect((await request(app).delete(`${URL}/abc`).set("Authorization", auth("Admin"))).status).toBe(400);
    expect((await request(app).delete(`${URL}/7`).set("Authorization", auth("Parent"))).status).toBe(403);
  });
});
