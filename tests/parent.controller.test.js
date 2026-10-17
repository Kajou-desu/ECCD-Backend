import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    student: { findUnique: vi.fn() },
    attendance: { findMany: vi.fn(), count: vi.fn() },
    submission: { findMany: vi.fn() },
    weeklyGoal: { findMany: vi.fn() },
    studentGoalProgress: { count: vi.fn(), findMany: vi.fn() },
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
  prisma.studentGoalProgress.count.mockResolvedValue(0);
  prisma.studentGoalProgress.findMany.mockResolvedValue([]);
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
    prisma.attendance.count.mockResolvedValue(0);
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

  it("works out the attendance rate from two database counts, not by loading every record", async () => {
    prisma.student.findUnique.mockResolvedValue({ session: "morning" });
    // 1st count: all recorded days; 2nd: the present ones.
    prisma.attendance.count.mockResolvedValueOnce(8).mockResolvedValueOnce(6);
    prisma.submission.findMany.mockResolvedValue([]);
    prisma.weeklyGoal.findMany.mockResolvedValue([]);
    const res = mockRes();

    await getChildProgress({ params: { childId: "5" }, user: { id: 1, role: "Admin" } }, res, vi.fn());

    expect(prisma.attendance.count).toHaveBeenCalledWith({ where: { studentId: 5 } });
    expect(prisma.attendance.count).toHaveBeenCalledWith({ where: { studentId: 5, status: "present" } });
    expect(prisma.attendance.findMany).not.toHaveBeenCalled();
    expect(res.json.mock.calls[0][0]).toMatchObject({ attendance: "75%" });
  });

  it("moves a completed goal out of this week's goals and into the milestones", async () => {
    prisma.student.findUnique.mockResolvedValue({ session: "morning" });
    prisma.attendance.count.mockResolvedValue(0);
    prisma.submission.findMany.mockResolvedValue([]);
    prisma.weeklyGoal.findMany.mockResolvedValue([
      { id: 1, title: "Counting to 10", progress: [{ progress: 100, status: "Mastered" }] },
      { id: 2, title: "Fine motor skills", progress: [{ progress: 95, status: "Almost there" }] },
    ].map((g) => ({ ...g })));
    prisma.studentGoalProgress.count.mockResolvedValue(4);
    prisma.studentGoalProgress.findMany.mockResolvedValue([
      { id: 31, goal: { title: "Counting to 10", category: "Numeracy", weekStart: new Date("2026-10-05T00:00:00.000Z") } },
      { id: 22, goal: { title: "Shapes", category: null, weekStart: new Date("2026-09-28T00:00:00.000Z") } },
    ]);

    const res = mockRes();
    await getChildProgress({ params: { childId: "5" }, user: { id: 1, role: "Admin" }, protocol: "https", get: () => "x" }, res, vi.fn());

    const body = res.json.mock.calls[0][0];
    expect(body.weeklyGoals.map((g) => g.title)).toEqual(["Fine motor skills"]); // completed one moved out
    expect(body.weeklyGoalsTotal).toBe(2);
    expect(body.milestones).toBe(4); // the real total, not just the 2 listed
    expect(body.milestoneList).toEqual([
      { id: 31, title: "Counting to 10", category: "Numeracy", weekStart: "2026-10-05" },
      { id: 22, title: "Shapes", category: null, weekStart: "2026-09-28" },
    ]);
  });

  it("only counts and lists this child's completed goals, newest week first", async () => {
    prisma.student.findUnique.mockResolvedValue({ session: "morning" });
    prisma.attendance.count.mockResolvedValue(0);
    prisma.submission.findMany.mockResolvedValue([]);
    prisma.weeklyGoal.findMany.mockResolvedValue([]);
    await getChildProgress({ params: { childId: "5" }, user: { id: 1, role: "Admin" } }, mockRes(), vi.fn());

    expect(prisma.studentGoalProgress.count).toHaveBeenCalledWith({ where: { studentId: 5, progress: 100 } });
    const query = prisma.studentGoalProgress.findMany.mock.calls[0][0];
    expect(query.where).toEqual({ studentId: 5, progress: 100 });
    expect(query.orderBy[0]).toEqual({ goal: { weekStart: "desc" } });
    expect(query.take).toBe(50);
  });

  it("returns recent activities with submittedAt and a signed fileUrl, without notes", async () => {
    process.env.JWT_SECRET = "test-secret";
    prisma.student.findUnique.mockResolvedValue({ session: "morning" });
    prisma.attendance.count.mockResolvedValue(0);
    prisma.weeklyGoal.findMany.mockResolvedValue([]);
    prisma.submission.findMany.mockResolvedValue([
      {
        id: 7,
        submittedAt: new Date("2026-09-12T02:00:00.000Z"),
        fileUrl: "work-123.pdf",
        material: { title: "Shapes", category: "Math" },
      },
    ]);

    const req = {
      params: { childId: "5" },
      user: { id: 1, role: "Admin" },
      protocol: "https",
      get: () => "api.example.test",
    };
    const res = mockRes();

    await getChildProgress(req, res, vi.fn());

    const [payload] = res.json.mock.calls[0][0].recentActivities;
    expect(payload).toMatchObject({
      id: 7,
      activity: "Shapes",
      category: "Math",
      status: "completed",
      submittedAt: "2026-09-12T02:00:00.000Z",
    });
    expect(payload.fileUrl).toMatch(
      /^https:\/\/api\.example\.test\/api\/files\/work-123\.pdf\?exp=\d+&sig=[0-9a-f]+$/,
    );
    expect(payload).not.toHaveProperty("notes");
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
