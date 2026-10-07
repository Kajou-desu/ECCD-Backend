import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";

process.env.JWT_SECRET = "test-secret-at-least-32-characters-long";
process.env.CLIENT_ORIGIN = "http://localhost:5173";

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    $queryRaw: vi.fn(),
    user: { findUnique: vi.fn() },
    student: { findUnique: vi.fn() },
    parentChild: { findUnique: vi.fn() },
  },
}));
vi.mock("../src/services/recognitionClient.js", async (importOriginal) => ({
  ...(await importOriginal()),
  isRecognitionConfigured: vi.fn(() => true),
  removeStudentEnrollment: vi.fn(),
}));

const { prisma } = await import("../src/lib/prisma.js");
const { isRecognitionConfigured, removeStudentEnrollment } = await import("../src/services/recognitionClient.js");
const { signToken } = await import("../src/utils/jwt.js");
const { app } = await import("../src/app.js");

const URL = "/api/students/5/enrollment-photos";

function auth(role = "Teacher", id = 9) {
  const user = { id, email: "t@school.test", role, isActive: true, tokenVersion: 0 };
  prisma.user.findUnique.mockResolvedValue(user);
  return `Bearer ${signToken(user)}`;
}

beforeEach(() => {
  vi.clearAllMocks();
  isRecognitionConfigured.mockReturnValue(true);
  prisma.student.findUnique.mockResolvedValue({ id: 5, teacherId: 9 });
  prisma.parentChild.findUnique.mockResolvedValue(null);
  removeStudentEnrollment.mockResolvedValue(undefined);
});

describe("DELETE /students/:id/enrollment-photos", () => {
  it("401 anonymous; 403 Parent (even one linked to the child); the service is never asked", async () => {
    expect((await request(app).delete(URL)).status).toBe(401);
    prisma.parentChild.findUnique.mockResolvedValue({ parentId: 9, studentId: 5 });
    expect((await request(app).delete(URL).set("Authorization", auth("Parent"))).status).toBe(403);
    expect(removeStudentEnrollment).not.toHaveBeenCalled();
  });

  it("403 for a Teacher who isn't connected to that student (no IDOR)", async () => {
    prisma.student.findUnique.mockResolvedValue({ id: 5, teacherId: 77 });
    const res = await request(app).delete(URL).set("Authorization", auth("Teacher", 9));
    expect(res.status).toBe(403);
    expect(removeStudentEnrollment).not.toHaveBeenCalled();
  });

  it("204 for the owning Teacher and for an Admin; removes exactly that student's enrollment", async () => {
    const teacher = await request(app).delete(URL).set("Authorization", auth());
    expect(teacher.status).toBe(204);
    expect(teacher.text).toBe("");
    expect(removeStudentEnrollment).toHaveBeenCalledWith(5);

    expect((await request(app).delete(URL).set("Authorization", auth("Admin", 1))).status).toBe(204);
  });

  it("400 for a non-numeric student id, without calling the service", async () => {
    const res = await request(app).delete("/api/students/abc/enrollment-photos").set("Authorization", auth());
    expect(res.status).toBe(400);
    expect(removeStudentEnrollment).not.toHaveBeenCalled();
  });

  it("503 when recognition isn't configured", async () => {
    isRecognitionConfigured.mockReturnValue(false);
    expect((await request(app).delete(URL).set("Authorization", auth())).status).toBe(503);
    expect(removeStudentEnrollment).not.toHaveBeenCalled();
  });

  it("502 with a generic message when the service fails", async () => {
    removeStudentEnrollment.mockRejectedValue(new Error("connect ECONNREFUSED 10.1.2.3:8001 key=abc"));
    const res = await request(app).delete(URL).set("Authorization", auth());
    expect(res.status).toBe(502);
    expect(res.body).toEqual({ message: "Face recognition service unavailable" });
    expect(JSON.stringify(res.body)).not.toMatch(/10\.1\.2\.3|ECONNREFUSED|abc/);
  });
});
