import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    student: { findUnique: vi.fn() },
    attendance: { findMany: vi.fn() },
    submission: { findMany: vi.fn() },
    weeklyGoal: { findMany: vi.fn() },
    parentChild: { findMany: vi.fn(), findUnique: vi.fn() },
  },
}));

const { prisma } = await import("../src/lib/prisma.js");
const { getChildren, getChildProgress } = await import("../src/controllers/parent.controller.js");

function mockRes() {
  const res = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("getChildren", () => {
  it("skips orphaned parent-child links without crashing", async () => {
    prisma.parentChild.findMany.mockResolvedValue([
      { student: null },
      {
        student: {
          id: 7,
          name: "Maria Santos",
          photo: "uploads/child-7.jpg",
          teacher: { name: "Ms. Reyes" },
        },
      },
    ]);

    const req = {
      user: { id: 12 },
      protocol: "https",
      get: vi.fn().mockReturnValue("eccd-backend-production.up.railway.app"),
    };
    const res = mockRes();
    const next = vi.fn();

    await getChildren(req, res, next);

    expect(res.json).toHaveBeenCalledWith([
      expect.objectContaining({
        id: 7,
        name: "Maria Santos",
        teacher: "Ms. Reyes",
      }),
    ]);
    expect(next).not.toHaveBeenCalled();
  });
});

describe("getChildProgress", () => {
  it("returns this week's goals for the child's session with the child's own progress", async () => {
    prisma.student.findUnique.mockResolvedValue({ session: "morning" });
    prisma.attendance.findMany.mockResolvedValue([]);
    prisma.submission.findMany.mockResolvedValue([]);
    prisma.weeklyGoal.findMany.mockResolvedValue([
      { id: 1, title: "Counting to 10", progress: [{ progress: 40, status: "In progress" }] },
      { id: 2, title: "Fine motor skills", progress: [] },
    ]);

    // Admin here, not Teacher: an Admin's ownership check is a no-op, so
    // the single student.findUnique mock above only needs to satisfy this
    // controller's own {session} lookup, not also a Teacher ownership check
    // sharing the same mocked call.
    const req = { params: { childId: "5" }, user: { id: 1, role: "Admin" } };
    const res = mockRes();
    const next = vi.fn();

    await getChildProgress(req, res, next);

    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        weeklyGoals: [
          { id: 1, title: "Counting to 10", progress: 40, status: "In progress" },
          { id: 2, title: "Fine motor skills", progress: 0, status: "Not started" },
        ],
      }),
    );
  });

  it("returns 404 when the child doesn't exist", async () => {
    prisma.student.findUnique.mockResolvedValue(null);

    const req = { params: { childId: "999" }, user: { id: 1, role: "Admin" } };
    const res = mockRes();
    const next = vi.fn();

    await getChildProgress(req, res, next);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(prisma.weeklyGoal.findMany).not.toHaveBeenCalled();
  });

  it("denies a parent with no link to the child", async () => {
    const req = { params: { childId: "5" }, user: { id: 1, role: "Parent" } };
    const res = mockRes();
    const next = vi.fn();
    prisma.parentChild.findUnique.mockResolvedValue(null);

    await getChildProgress(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 403 }));
    expect(prisma.student.findUnique).not.toHaveBeenCalled();
  });
});
