import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";

process.env.JWT_SECRET = "test-secret-at-least-32-characters-long";
process.env.CLIENT_ORIGIN = "http://localhost:5173";

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    event: { findMany: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn() },
  },
}));

const { prisma } = await import("../src/lib/prisma.js");
const { signToken } = await import("../src/utils/jwt.js");
const { app } = await import("../src/app.js");

const URL = "/api/events";

function auth(role) {
  const user = { id: 1, email: `${role.toLowerCase()}@school.test`, role, isActive: true, tokenVersion: 0 };
  prisma.user.findUnique.mockResolvedValue(user);
  return `Bearer ${signToken(user)}`;
}

beforeEach(() => {
  vi.clearAllMocks();
  prisma.event.findMany.mockResolvedValue([]);
});

describe("GET /api/events", () => {
  it("401 without a token", async () => {
    const res = await request(app).get(URL).query({ month: "2026-08" });
    expect(res.status).toBe(401);
  });

  it.each(["Teacher", "Admin", "Parent", "Guardian"])("200 for %s", async (role) => {
    const res = await request(app).get(URL).query({ month: "2026-08" }).set("Authorization", auth(role));
    expect(res.status).toBe(200);
    expect(prisma.event.findMany).toHaveBeenCalled();
  });
});

describe("write endpoints stay Teacher/Admin only", () => {
  it("403 for a Parent creating an event; Teacher can", async () => {
    const body = { title: "Founding Day", date: "2026-08-20", category: "Event" };
    const parentRes = await request(app).post(URL).set("Authorization", auth("Parent")).send(body);
    expect(parentRes.status).toBe(403);
    expect(prisma.event.create).not.toHaveBeenCalled();

    prisma.event.create.mockResolvedValue({ id: 1, ...body });
    const teacherRes = await request(app).post(URL).set("Authorization", auth("Teacher")).send(body);
    expect(teacherRes.status).toBe(201);
  });

  it("403 for a Guardian updating or deleting an event", async () => {
    const updateRes = await request(app)
      .put(`${URL}/1`)
      .set("Authorization", auth("Guardian"))
      .send({ title: "x", date: "2026-08-20", category: "Event" });
    expect(updateRes.status).toBe(403);
    expect(prisma.event.update).not.toHaveBeenCalled();

    const deleteRes = await request(app).delete(`${URL}/1`).set("Authorization", auth("Guardian"));
    expect(deleteRes.status).toBe(403);
    expect(prisma.event.delete).not.toHaveBeenCalled();
  });
});
