import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";

process.env.JWT_SECRET = "test-secret-at-least-32-characters-long";
process.env.CLIENT_ORIGIN = "http://localhost:5173";

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    $queryRaw: vi.fn(),
    user: { findUnique: vi.fn() },
    attendanceSession: { findFirst: vi.fn(), create: vi.fn(), updateMany: vi.fn() },
    pickupWatchOverride: { findFirst: vi.fn().mockResolvedValue(null), findMany: vi.fn().mockResolvedValue([]), create: vi.fn(), updateMany: vi.fn() },
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
    ["post", "/api/attendance/session/pickup-watch/start"],
    ["post", "/api/attendance/session/pickup-watch/stop"],
    ["get", "/api/attendance/session/monitor"],
  ])("%s %s: 401 without a token, and never touches the session table", async (method, url) => {
    const res = await request(app)[method](url);
    expect(res.status).toBe(401);
    expect(prisma.attendanceSession.findFirst).not.toHaveBeenCalled();
    expect(prisma.attendanceSession.create).not.toHaveBeenCalled();
    expect(prisma.attendanceSession.updateMany).not.toHaveBeenCalled();
    expect(prisma.pickupWatchOverride.create).not.toHaveBeenCalled();
  });

  it.each(["Parent", "Guardian"])("403 for role %s on every session endpoint", async (role) => {
    const auth = loginAs(role);
    for (const [method, url] of [
      ["get", "/api/attendance/session/current"],
      ["post", "/api/attendance/session/start"],
      ["post", "/api/attendance/session/stop"],
      ["post", "/api/attendance/session/pickup-watch/start"],
      ["post", "/api/attendance/session/pickup-watch/stop"],
      ["get", "/api/attendance/session/monitor"],
    ]) {
      const res = await request(app)[method](url).set("Authorization", auth);
      expect(res.status).toBe(403);
    }
    expect(prisma.pickupWatchOverride.create).not.toHaveBeenCalled();
    expect(prisma.attendanceSession.create).not.toHaveBeenCalled();
    expect(prisma.attendanceSession.updateMany).not.toHaveBeenCalled();
  });

  it.each(["Teacher", "Admin"])("%s can read current session (also under /api/v1)", async (role) => {
    const auth = loginAs(role);
    for (const prefix of ["/api", "/api/v1"]) {
      const res = await request(app).get(`${prefix}/attendance/session/current`).set("Authorization", auth);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ session: null })
      expect(res.body).not.toHaveProperty("pickupChecks");
      expect(typeof res.body.pickupWindow.active).toBe("boolean"); // depends on the real clock, so only the shape
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
      .send({ startedById: 1, date: "1999-01-01", centerId: 99 });

    expect(res.status).toBe(201);
    const { data } = prisma.attendanceSession.create.mock.calls[0][0];
    expect(data.startedById).toBe(42);
    expect(data.centerId).toBeNull(); // this Teacher has no center; the body's 99 is ignored
  });

  it("a Teacher's session belongs to the center on their account, not the one they name", async () => {
    const user = { id: 42, email: "u42@school.test", role: "Teacher", centerId: 2, isActive: true, tokenVersion: 0 };
    prisma.user.findUnique.mockResolvedValue(user);
    prisma.attendanceSession.create.mockResolvedValue({
      id: 1, date: new Date("2026-09-20T00:00:00.000Z"), status: "active", startedAt: new Date(), endedAt: null,
    });
    const auth = `Bearer ${signToken(user)}`;

    await request(app).post("/api/attendance/session/start").set("Authorization", auth).send({ centerId: 99 });
    await request(app).post("/api/attendance/session/stop?centerId=99").set("Authorization", auth).send({ centerId: 99 });

    expect(prisma.attendanceSession.create.mock.calls[0][0].data.centerId).toBe(2);
    expect(prisma.attendanceSession.updateMany.mock.calls[0][0].where).toEqual({ status: "active", centerId: 2 });
  });

  it("an Admin must say which center: 400 without one, and nothing is written", async () => {
    const auth = loginAs("Admin", 1);
    for (const body of [{}, { centerId: "x" }, { centerId: 0 }]) {
      const res = await request(app).post("/api/attendance/session/start").set("Authorization", auth).send(body);
      expect(res.status).toBe(400);
    }
    const stop = await request(app).post("/api/attendance/session/stop").set("Authorization", auth).send({});
    expect(stop.status).toBe(400);
    expect(prisma.attendanceSession.create).not.toHaveBeenCalled();
    expect(prisma.attendanceSession.updateMany).not.toHaveBeenCalled();
  });

  it("an Admin can start and read the center they name", async () => {
    const auth = loginAs("Admin", 1);
    prisma.attendanceSession.create.mockResolvedValue({
      id: 1, date: new Date("2026-09-20T00:00:00.000Z"), status: "active", startedAt: new Date(), endedAt: null,
    });
    const started = await request(app).post("/api/attendance/session/start").set("Authorization", auth).send({ centerId: 3 });
    expect(started.status).toBe(201);
    expect(prisma.attendanceSession.create.mock.calls[0][0].data.centerId).toBe(3);

    await request(app).get("/api/attendance/session/current?centerId=3").set("Authorization", auth);
    expect(prisma.attendanceSession.findFirst.mock.calls.at(-1)[0].where).toEqual({ status: "active", centerId: 3 });
  });

  it("no longer has a pickup prompt answer endpoint", async () => {
    const res = await request(app)
      .post("/api/attendance/session/pickup-checks/9/answer")
      .set("Authorization", loginAs("Teacher"))
      .send({ stillHere: true });
    expect(res.status).toBe(404);
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
