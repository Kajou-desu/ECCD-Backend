import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/lib/prisma.js", () => ({
  prisma: { student: { findUnique: vi.fn(), count: vi.fn() } },
}));

const { prisma } = await import("../src/lib/prisma.js");
const { studentScopeFor, assertCanAccessStudent, assertCanAccessStudents } = await import("../src/utils/ownership.js");
const { liveStudentScope } = await import("../src/utils/studentScope.js");

const teacher = (id, centerId) => ({ id, role: "Teacher", centerId });

beforeEach(() => vi.clearAllMocks());

describe("studentScopeFor", () => {
  it("is the whole center for a Teacher, everyone for an Admin, and null for anyone else", () => {
    expect(studentScopeFor(teacher(1, 4))).toEqual({ teacher: { centerId: 4 } });
    expect(studentScopeFor({ id: 2, role: "Admin" })).toEqual({});
    expect(studentScopeFor({ id: 3, role: "Parent" })).toBeNull();
    expect(studentScopeFor(undefined)).toBeNull();
  });

  it("falls back to the Teacher's own students while they have no center", () => {
    expect(studentScopeFor(teacher(1, null))).toEqual({ teacherId: 1 });
  });

  it("is what live recognition and the monitor use too, and denies other roles", () => {
    expect(liveStudentScope(teacher(1, 4))).toEqual({ teacher: { centerId: 4 } });
    expect(() => liveStudentScope({ role: "Parent" })).toThrow("Forbidden");
  });
});

describe("assertCanAccessStudent for a Teacher", () => {
  it("allows a colleague's student at the same center", async () => {
    prisma.student.findUnique.mockResolvedValue({ teacherId: 99, teacher: { centerId: 4 } });
    await expect(assertCanAccessStudent(teacher(1, 4), 10)).resolves.toBeUndefined();
  });

  it("refuses a student whose teacher is at another center", async () => {
    prisma.student.findUnique.mockResolvedValue({ teacherId: 99, teacher: { centerId: 5 } });
    await expect(assertCanAccessStudent(teacher(1, 4), 10)).rejects.toMatchObject({ status: 403 });
  });

  it("refuses an unassigned student, and one whose teacher has no center", async () => {
    prisma.student.findUnique.mockResolvedValue({ teacherId: null, teacher: null });
    await expect(assertCanAccessStudent(teacher(1, 4), 10)).rejects.toMatchObject({ status: 403 });
    prisma.student.findUnique.mockResolvedValue({ teacherId: 99, teacher: { centerId: null } });
    await expect(assertCanAccessStudent(teacher(1, 4), 10)).rejects.toMatchObject({ status: 403 });
  });

  it("does not match a null center against a null center", async () => {
    prisma.student.findUnique.mockResolvedValue({ teacherId: 99, teacher: { centerId: null } });
    await expect(assertCanAccessStudent(teacher(1, null), 10)).rejects.toMatchObject({ status: 403 });
  });

  it("still allows a Teacher's own student", async () => {
    prisma.student.findUnique.mockResolvedValue({ teacherId: 1, teacher: { centerId: null } });
    await expect(assertCanAccessStudent(teacher(1, null), 10)).resolves.toBeUndefined();
  });
});

describe("assertCanAccessStudents (bulk) is all-or-nothing within the center", () => {
  it("asks for the whole list under the center filter", async () => {
    prisma.student.count.mockResolvedValue(2);
    await expect(assertCanAccessStudents(teacher(1, 4), [1, 2, 2])).resolves.toBeUndefined();
    expect(prisma.student.count).toHaveBeenCalledWith({ where: { id: { in: [1, 2] }, teacher: { centerId: 4 } } });
  });

  it("refuses if any one is outside the center", async () => {
    prisma.student.count.mockResolvedValue(1);
    await expect(assertCanAccessStudents(teacher(1, 4), [1, 2])).rejects.toMatchObject({ status: 403 });
  });
});
