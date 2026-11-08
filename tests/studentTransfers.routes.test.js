import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";

process.env.JWT_SECRET = "test-secret-at-least-32-characters-long";
process.env.CLIENT_ORIGIN = "http://localhost:5173";

vi.mock("../src/lib/prisma.js", () => {
  const prisma = {
    user: { findUnique: vi.fn(), findFirst: vi.fn(), findMany: vi.fn(), updateMany: vi.fn() },
    student: { findUnique: vi.fn(), updateMany: vi.fn() },
    studentTransfer: { create: vi.fn(), findFirst: vi.fn(), findMany: vi.fn(), findUnique: vi.fn(), updateMany: vi.fn() },
    parentChild: { findMany: vi.fn(), count: vi.fn() },
    notification: { create: vi.fn() },
    attendance: { findMany: vi.fn(), updateMany: vi.fn() },
    schoolTimeSettings: { findMany: vi.fn() },
    activityLog: { create: vi.fn() },
    $transaction: vi.fn(),
  };
  prisma.$transaction.mockImplementation(async (cb) => cb(prisma));
  return { prisma };
});

const { prisma } = await import("../src/lib/prisma.js");
const { signToken } = await import("../src/utils/jwt.js");
const { app } = await import("../src/app.js");

function auth(role, id = 10, centerId = 1) {
  const user = { id, email: `${role.toLowerCase()}${id}@school.test`, role, centerId, isActive: true, tokenVersion: 0 };
  prisma.user.findUnique.mockResolvedValue({ ...user, notifyByEmail: true, notifyBySms: true });
  return `Bearer ${signToken(user)}`;
}

const dina = { id: 20, name: "Dina", centerId: 2, center: { name: "South" } };
const ann = { id: 10, name: "Ann", centerId: 1, center: { name: "North" } };
const row = { id: 7, studentId: 5, status: "pending", fromTeacherId: 10, toTeacherId: 20, fromCenterId: 1, toCenterId: 2, fromSession: "morning", toSession: "morning", createdAt: new Date(), resolvedAt: null, student: { id: 5, name: "Ana Cruz" }, fromTeacher: ann, toTeacher: dina };

beforeEach(() => {
  vi.clearAllMocks();
  prisma.$transaction.mockImplementation(async (cb) => cb(prisma));
  prisma.student.findUnique.mockResolvedValue({ id: 5, name: "Ana Cruz", session: "morning", teacherId: 10, teacher: ann });
  prisma.student.updateMany.mockResolvedValue({ count: 1 });
  prisma.user.findFirst.mockResolvedValue(dina);
  prisma.studentTransfer.findFirst.mockResolvedValue(null);
  prisma.studentTransfer.create.mockResolvedValue(row);
  prisma.studentTransfer.findUnique.mockResolvedValue(row);
  prisma.studentTransfer.findMany.mockResolvedValue([]);
  prisma.studentTransfer.updateMany.mockResolvedValue({ count: 1 });
  prisma.parentChild.findMany.mockResolvedValue([]);
  prisma.attendance.findMany.mockResolvedValue([]);
  prisma.schoolTimeSettings.findMany.mockResolvedValue([]);
});

describe("student transfer routes", () => {
  const all = [
    ["get", "/api/student-transfers"],
    ["get", "/api/student-transfers/teachers"],
    ["post", "/api/student-transfers"],
    ["post", "/api/student-transfers/7/accept"],
    ["post", "/api/student-transfers/7/decline"],
    ["post", "/api/student-transfers/7/cancel"],
  ];

  it.each(all)("%s %s requires sign-in", async (method, path) => {
    expect((await request(app)[method](path)).status).toBe(401);
  });

  it.each(["Parent", "Guardian"])("are closed to %s", async (role) => {
    const token = auth(role);
    for (const [method, path] of all) {
      expect((await request(app)[method](path).set("Authorization", token).send({ studentId: 5 })).status).toBe(403);
    }
    expect(prisma.studentTransfer.create).not.toHaveBeenCalled();
    expect(prisma.student.updateMany).not.toHaveBeenCalled();
  });

  it("the student's teacher can ask for a cross-center transfer (202) and it is logged", async () => {
    const res = await request(app).post("/api/student-transfers").set("Authorization", auth("Teacher")).send({ studentId: 5, toTeacherId: 20 });
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ id: 7, status: "pending", student: { name: "Ana Cruz" }, toTeacher: { name: "Dina", centerName: "South" } });
    expect(prisma.student.updateMany).not.toHaveBeenCalled();
    await new Promise((r) => setTimeout(r, 0));
    expect(prisma.activityLog.create.mock.calls[0][0].data).toMatchObject({
      action: "student.transfer",
      summary: 'Asked to transfer student "Ana Cruz" to "Dina"',
    });
  });

  it("another teacher can't start a transfer for someone else's student", async () => {
    const res = await request(app).post("/api/student-transfers").set("Authorization", auth("Teacher", 11)).send({ studentId: 5, toTeacherId: 20 });
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ message: "Forbidden" });
    expect(prisma.studentTransfer.create).not.toHaveBeenCalled();
  });

  it("the receiving teacher accepts: the student moves and the acceptance is logged", async () => {
    const res = await request(app).post("/api/student-transfers/7/accept").set("Authorization", auth("Teacher", 20, 2));
    expect(res.status).toBe(200);
    expect(prisma.student.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { teacherId: 20, session: "morning" } }));
    await new Promise((r) => setTimeout(r, 0));
    expect(prisma.activityLog.create.mock.calls[0][0].data).toMatchObject({ action: "student.transfer", targetType: "student_transfer", targetId: 7 });
  });

  it("the teacher who asked cannot accept their own request", async () => {
    const res = await request(app).post("/api/student-transfers/7/accept").set("Authorization", auth("Teacher", 10));
    expect(res.status).toBe(403);
    expect(prisma.student.updateMany).not.toHaveBeenCalled();
  });

  it("answers a malformed id with a plain 400", async () => {
    const res = await request(app).post("/api/student-transfers/abc/accept").set("Authorization", auth("Teacher", 20, 2));
    expect(res.status).toBe(400);
  });

  it("hides internals when something unexpected fails", async () => {
    prisma.studentTransfer.create.mockRejectedValue(new Error("connection string postgres://secret"));
    const res = await request(app).post("/api/student-transfers").set("Authorization", auth("Teacher")).send({ studentId: 5, toTeacherId: 20 });
    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toMatch(/postgres|secret/);
  });
});
