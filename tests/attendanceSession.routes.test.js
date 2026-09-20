import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";

process.env.JWT_SECRET = "test-secret-at-least-32-characters-long";
process.env.CLIENT_ORIGIN = "http://localhost:5173";

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    $queryRaw: vi.fn(),
    user: { findUnique: vi.fn() },
    attendanceSession: { findFirst: vi.fn(), create: vi.fn(), updateMany: vi.fn() },
  },
}));

const { prisma } = await import("../src/lib/prisma.js");
const { signToken } = await import("../src/utils/jwt.js");
const { app } = await import("../src/app.js");

// requireAuth re-reads the user from the DB on every request, so the mocked
// user record IS the identity/role under test.
function loginAs(role, id = 1) {
  const user = { id, email: `u${id}@school.test`, role, isActive: true, tokenVersion: 0 };
  prisma.user.findUnique.mockResolvedValue(user);
  return `Bearer ${signToken(user)}`;
}

beforeEach(() => {
  vi.clearAllMocks();
  prisma.attendanceSession.findFirst.mockResolvedValue(null);
});

describe("attendance session routes — access control (default deny)", () => {
  it.each([
    ["get", "/api/attendance/session/current"],
    ["post", "/api/attendance/session/start"],
    ["post", "/api/attendance/session/stop"],
  ])("%s %s: 401 without a token, and never touches the session table", async (method, url) => {
    const res = await request(app)[method](url);
    expect(res.status).toBe(401);
    expect(prisma.attendanceSession.findFirst).not.toHaveBeenCalled();
    expect(prisma.attendanceSession.create).not.toHaveBeenCalled();
    expect(prisma.attendanceSession.updateMany).not.toHaveBeenCalled();
  });

  it.each(["Parent", "Guardian"])("403 for role %s on every session endpoint", async (role) => {
    const auth = loginAs(role);
    for (const [method, url] of [
      ["get", "/api/attendance/session/current"],
      ["post", "/api/attendance/session/start"],
      ["post", "/api/attendance/session/stop"],
    ]) {
      const res = await request(app)[method](url).set("Authorization", auth);
      expect(res.status).toBe(403);
    }
    expect(prisma.attendanceSession.create).not.toHaveBeenCalled();
    expect(prisma.attendanceSession.updateMany).not.toHaveBeenCalled();
  });

  it.each(["Teacher", "Admin"])("%s can read current session (also under /api/v1)", async (role) => {
    const auth = loginAs(role);
    for (const prefix of ["/api", "/api/v1"]) {
      const res = await request(app).get(`${prefix}/attendance/session/current`).set("Authorization", auth);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ session: null });
    }
  });

  it("start creates a session for the authenticated teacher and ignores body fields", async () => {
    const auth = loginAs("Teacher", 42);
    prisma.attendanceSession.create.mockResolvedValue({
      id: 1, date: new Date("2026-09-20T00:00:00.000Z"), status: "active",
      startedAt: new Date(), endedAt: null,
    });
    const res = await request(app)
      .post("/api/attendance/session/start")
      .set("Authorization", auth)
      .send({ startedById: 1, date: "1999-01-01" });

    expect(res.status).toBe(201);
    expect(prisma.attendanceSession.create.mock.calls[0][0].data.startedById).toBe(42);
  });

  it("does not shadow the existing attendance routes", async () => {
    const auth = loginAs("Parent");
    // Existing behaviour: teacher/admin-only roster route still answers 403 to a Parent.
    const res = await request(app).get("/api/attendance?date=2026-09-20").set("Authorization", auth);
    expect(res.status).toBe(403);
  });
});

describe("rate limiting for live attendance", () => {
  it("polling well past the general 300/15min limit is NOT throttled on session paths", async () => {
    const auth = loginAs("Teacher", 7);
    let last;
    for (let i = 0; i < 320; i += 1) {
      last = await request(app).get("/api/attendance/session/current").set("Authorization", auth);
    }
    expect(last.status).toBe(200);
  }, 30_000);

  it("the general limit still applies to every other path (behaviour unchanged)", async () => {
    let last;
    for (let i = 0; i < 305; i += 1) {
      last = await request(app).get("/api/some-other-path");
    }
    expect(last.status).toBe(429);
  }, 30_000);
});
