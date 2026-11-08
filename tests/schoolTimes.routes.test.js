import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";

process.env.JWT_SECRET = "test-secret-at-least-32-characters-long";
process.env.CLIENT_ORIGIN = "http://localhost:5173";

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    center: { findUnique: vi.fn() },
    schoolTimeSettings: { findUnique: vi.fn(), upsert: vi.fn() },
    attendance: { count: vi.fn(), deleteMany: vi.fn() },
    student: { count: vi.fn() },
    activityLog: { create: vi.fn() },
  },
}));

const { prisma } = await import("../src/lib/prisma.js");
const { signToken } = await import("../src/utils/jwt.js");
const { app } = await import("../src/app.js");

// A Bearer token, so the cookie/CSRF origin check never applies: any 401/403
// below can only come from authentication or the role guard.
function auth(role, centerId = 8) {
  const user = { id: 1, email: `${role.toLowerCase()}@school.test`, role, centerId, isActive: true, tokenVersion: 0 };
  prisma.user.findUnique.mockResolvedValue({ ...user, notifyByEmail: true, notifyBySms: true });
  return `Bearer ${signToken(user)}`;
}

const times = { morningStart: "08:30", morningEnd: "11:00", afternoonStart: "13:15", afternoonEnd: "15:00" };

beforeEach(() => {
  vi.clearAllMocks();
  prisma.center.findUnique.mockResolvedValue({ id: 8, name: "ECCD Test" });
  prisma.schoolTimeSettings.findUnique.mockResolvedValue(null);
  prisma.schoolTimeSettings.upsert.mockImplementation(async ({ create }) => ({ id: 1, ...create }));
  prisma.attendance.deleteMany.mockResolvedValue({ count: 2 });
  prisma.attendance.count.mockResolvedValue(2);
  prisma.student.count.mockResolvedValue(1);
});

describe("school times routes", () => {
  it("require sign-in", async () => {
    expect((await request(app).get("/api/school-times")).status).toBe(401);
    expect((await request(app).put("/api/school-times").send(times)).status).toBe(401);
  });

  it.each(["Parent", "Guardian"])("are closed to %s", async (role) => {
    const token = auth(role);
    expect((await request(app).get("/api/school-times").set("Authorization", token)).status).toBe(403);
    expect((await request(app).put("/api/school-times").set("Authorization", token).send(times)).status).toBe(403);
    expect(prisma.schoolTimeSettings.upsert).not.toHaveBeenCalled();
  });

  it("let a Teacher read and save their own center", async () => {
    const token = auth("Teacher");
    const read = await request(app).get("/api/school-times").set("Authorization", token);
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({ centerId: 8, isDefault: true });

    const saved = await request(app).put("/api/school-times").set("Authorization", token).send({ ...times, centerId: 99 });
    expect(saved.status).toBe(200);
    expect(prisma.schoolTimeSettings.upsert.mock.calls[0][0].where).toEqual({ centerId: 8 });
  });

  it("let an Admin save a named center and need one to be named", async () => {
    const token = auth("Admin", null);
    expect((await request(app).put("/api/school-times").set("Authorization", token).send(times)).status).toBe(400);
    const saved = await request(app).put("/api/school-times").set("Authorization", token).send({ ...times, centerId: 3 });
    expect(saved.status).toBe(200);
    expect(prisma.schoolTimeSettings.upsert.mock.calls[0][0].where).toEqual({ centerId: 3 });
  });

  it("answer invalid times with a plain 400 message and nothing else", async () => {
    const res = await request(app)
      .put("/api/school-times")
      .set("Authorization", auth("Teacher"))
      .send({ ...times, morningEnd: "07:00" });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ message: "The morning session must end after it starts" });
  });

  it("hide database failures behind a generic message", async () => {
    prisma.schoolTimeSettings.upsert.mockRejectedValue(new Error('relation "school_time_settings" does not exist'));
    const res = await request(app).put("/api/school-times").set("Authorization", auth("Teacher")).send(times);
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ message: "Something went wrong" });
  });
});

describe("attendance delete route", () => {
  const body = { from: "2026-09-01", allStudents: true };

  it("requires sign-in", async () => {
    expect((await request(app).post("/api/attendance/delete").send(body)).status).toBe(401);
    expect(prisma.attendance.deleteMany).not.toHaveBeenCalled();
  });

  it.each(["Parent", "Guardian"])("is closed to %s", async (role) => {
    const res = await request(app).post("/api/attendance/delete").set("Authorization", auth(role)).send(body);
    expect(res.status).toBe(403);
    expect(prisma.attendance.deleteMany).not.toHaveBeenCalled();
    expect(prisma.attendance.count).not.toHaveBeenCalled();
  });

  it.each(["Teacher", "Admin"])("lets a %s preview and then delete", async (role) => {
    const token = auth(role);
    const preview = await request(app).post("/api/attendance/delete").set("Authorization", token).send({ ...body, dryRun: true });
    expect(preview.body).toEqual({ dryRun: true, wouldDelete: 2 });
    const done = await request(app).post("/api/attendance/delete").set("Authorization", token).send(body);
    expect(done.body).toEqual({ dryRun: false, deleted: 2 });
  });

  it("is not mistaken for a student id route", async () => {
    // PUT /:studentId must still treat "delete" as an id (and reject it), never run the delete
    const res = await request(app)
      .put("/api/attendance/delete")
      .set("Authorization", auth("Teacher"))
      .send({ date: "2026-09-01", status: "present" });
    expect(res.status).toBe(400);
    expect(prisma.attendance.deleteMany).not.toHaveBeenCalled();
  });

  it("answers a bad request with a plain message", async () => {
    const res = await request(app).post("/api/attendance/delete").set("Authorization", auth("Teacher")).send({ from: "2026-09-01" });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ message: "Choose the students with either studentIds or allStudents" });
  });
});
