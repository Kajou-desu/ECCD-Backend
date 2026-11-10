import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";

process.env.JWT_SECRET = "test-secret-at-least-32-characters-long";
process.env.CLIENT_ORIGIN = "http://localhost:5173";

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    student: { findUnique: vi.fn() },
    attendance: { updateMany: vi.fn() },
  },
}));

const { prisma } = await import("../src/lib/prisma.js");
const { signToken } = await import("../src/utils/jwt.js");
const { app } = await import("../src/app.js");

function loginAs(role, id = 1) {
  const user = { id, email: `u${id}@school.test`, role, isActive: true, tokenVersion: 0 };
  prisma.user.findUnique.mockResolvedValue(user);
  return `Bearer ${signToken(user)}`;
}

beforeEach(() => vi.clearAllMocks());

describe("PATCH /api/attendance/:studentId/still-here — access control", () => {
  it("401 without a token, and writes nothing", async () => {
    const res = await request(app).patch("/api/attendance/5/still-here");
    expect(res.status).toBe(401);
    expect(prisma.attendance.updateMany).not.toHaveBeenCalled();
  });

  it.each(["Parent", "Guardian"])("403 for role %s, and writes nothing", async (role) => {
    const res = await request(app).patch("/api/attendance/5/still-here").set("Authorization", loginAs(role));
    expect(res.status).toBe(403);
    expect(prisma.attendance.updateMany).not.toHaveBeenCalled();
  });

  it("403 for a Teacher on another teacher's student, and writes nothing", async () => {
    const auth = loginAs("Teacher", 7);
    prisma.student.findUnique.mockResolvedValue({ teacherId: 99 });
    const res = await request(app).patch("/api/attendance/5/still-here").set("Authorization", auth);
    expect(res.status).toBe(403);
    expect(prisma.attendance.updateMany).not.toHaveBeenCalled();
  });
});
