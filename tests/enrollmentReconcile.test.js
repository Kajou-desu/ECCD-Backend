import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/lib/prisma.js", () => ({ prisma: { student: { findMany: vi.fn() } } }));
const recognition = vi.hoisted(() => ({ listEnrolledStudentIds: vi.fn(), removeStudentEnrollment: vi.fn() }));
vi.mock("../src/services/recognitionClient.js", () => recognition);

const { prisma } = await import("../src/lib/prisma.js");
const { planReconcile, reconcileEnrollments } = await import("../src/services/enrollmentReconcile.js");

beforeEach(() => {
  vi.clearAllMocks();
  recognition.listEnrolledStudentIds.mockResolvedValue([1, 2, 3, 4]);
  // 1 active, 2 inactive, 3 and 4 do not exist
  prisma.student.findMany.mockResolvedValue([
    { id: 1, status: "active" },
    { id: 2, status: "inactive" },
  ]);
  recognition.removeStudentEnrollment.mockResolvedValue(undefined);
});

describe("planReconcile", () => {
  it("separates orphans from inactive students and leaves active ones alone", () => {
    expect(planReconcile([1, 2, 3], [{ id: 1, status: "active" }, { id: 2, status: "inactive" }])).toEqual({
      orphans: [3],
      inactive: [2],
    });
  });
});

describe("reconcileEnrollments", () => {
  it("changes nothing unless asked to", async () => {
    const result = await reconcileEnrollments();
    expect(result).toMatchObject({ enrolled: 4, orphans: [3, 4], inactive: [2], erased: [], applied: false });
    expect(recognition.removeStudentEnrollment).not.toHaveBeenCalled();
  });

  it("with apply, erases orphans only", async () => {
    const result = await reconcileEnrollments({ apply: true });
    expect(result.erased).toEqual([3, 4]);
    expect(recognition.removeStudentEnrollment.mock.calls.map((c) => c[0])).toEqual([3, 4]);
  });

  it("erases inactive students' photos only when purgeInactive is also set", async () => {
    const result = await reconcileEnrollments({ apply: true, purgeInactive: true });
    expect(result.erased).toEqual([3, 4, 2]);
    expect(recognition.removeStudentEnrollment).not.toHaveBeenCalledWith(1); // active: never touched
  });

  it("purgeInactive without apply does nothing", async () => {
    await reconcileEnrollments({ purgeInactive: true });
    expect(recognition.removeStudentEnrollment).not.toHaveBeenCalled();
  });

  it("keeps going when one erase fails, and reports it by id only", async () => {
    recognition.removeStudentEnrollment.mockRejectedValueOnce(new Error("connect ECONNREFUSED 10.1.2.3:8001"));
    const result = await reconcileEnrollments({ apply: true });
    expect(result.failed).toEqual([3]);
    expect(result.erased).toEqual([4]);
    expect(JSON.stringify(result)).not.toContain("10.1.2.3");
  });

  it("does not query the database when nothing is enrolled", async () => {
    recognition.listEnrolledStudentIds.mockResolvedValue([]);
    const result = await reconcileEnrollments({ apply: true });
    expect(prisma.student.findMany).not.toHaveBeenCalled();
    expect(result).toMatchObject({ enrolled: 0, orphans: [], inactive: [], erased: [] });
  });
});
