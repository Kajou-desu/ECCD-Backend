import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    weeklyGoal: { findMany: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn(), findUnique: vi.fn() },
    student: { findMany: vi.fn() },
    studentGoalProgress: { upsert: vi.fn() },
    // Array-style $transaction (as used by updateGoalProgress): resolve
    // like Promise.all over the array of prisma-call promises passed in.
    $transaction: vi.fn((arg) => Promise.all(arg)),
  },
}));

const { prisma } = await import("../src/lib/prisma.js");
const {
  getWeeklyGoals,
  createWeeklyGoal,
  updateWeeklyGoal,
  deleteWeeklyGoal,
  updateGoalProgress,
} = await import("../src/controllers/weeklyGoals.controller.js");

function mockRes() {
  const res = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  res.send = vi.fn().mockReturnValue(res);
  return res;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("getWeeklyGoals", () => {
  it("pairs each goal with every active student's progress, defaulting to 0/Not started", async () => {
    prisma.weeklyGoal.findMany.mockResolvedValue([
      {
        id: 1,
        weekStart: new Date(Date.UTC(2026, 8, 21)),
        session: "morning",
        title: "Counting to 10",
        description: null,
        category: "Numeracy",
        progress: [{ studentId: 5, progress: 60, status: "In progress" }],
      },
    ]);
    prisma.student.findMany.mockResolvedValue([
      { id: 5, name: "Ari Bell" },
      { id: 6, name: "Bo Cruz" },
    ]);

    const req = { query: { week: "2026-09-21", session: "morning" } };
    const res = mockRes();
    const next = vi.fn();

    await getWeeklyGoals(req, res, next);

    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        session: "morning",
        goals: [
          expect.objectContaining({
            id: 1,
            title: "Counting to 10",
            students: [
              { studentId: 5, name: "Ari Bell", progress: 60, status: "In progress" },
              { studentId: 6, name: "Bo Cruz", progress: 0, status: "Not started" },
            ],
          }),
        ],
      }),
    );
  });

  it("rejects an invalid session", async () => {
    const req = { query: { session: "midnight" } };
    const res = mockRes();
    const next = vi.fn();

    await getWeeklyGoals(req, res, next);

    expect(prisma.weeklyGoal.findMany).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 400 }));
  });
});

describe("createWeeklyGoal", () => {
  it("creates a goal for the resolved week, attributed to the authenticated teacher", async () => {
    prisma.weeklyGoal.create.mockResolvedValue({
      id: 1,
      weekStart: new Date(Date.UTC(2026, 8, 21)),
      session: "morning",
      title: "Counting to 10",
      description: null,
      category: "Numeracy",
    });

    const req = {
      body: { weekStart: "2026-09-21", session: "morning", title: "Counting to 10", category: "Numeracy" },
      user: { id: 9 },
    };
    const res = mockRes();
    const next = vi.fn();

    await createWeeklyGoal(req, res, next);

    expect(prisma.weeklyGoal.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        session: "morning",
        title: "Counting to 10",
        category: "Numeracy",
        createdById: 9,
      }),
    });
    expect(res.status).toHaveBeenCalledWith(201);
  });

  it("returns 409 when a goal with the same title already exists for that week/session", async () => {
    const conflict = new Error("duplicate");
    conflict.code = "P2002";
    prisma.weeklyGoal.create.mockRejectedValue(conflict);

    const req = {
      body: { weekStart: "2026-09-21", session: "morning", title: "Counting to 10" },
      user: { id: 9 },
    };
    const res = mockRes();
    const next = vi.fn();

    await createWeeklyGoal(req, res, next);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(next).not.toHaveBeenCalled();
  });

  it("rejects a blank title", async () => {
    const req = { body: { weekStart: "2026-09-21", session: "morning", title: "   " }, user: { id: 9 } };
    const res = mockRes();
    const next = vi.fn();

    await createWeeklyGoal(req, res, next);

    expect(prisma.weeklyGoal.create).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 400 }));
  });
});

describe("updateWeeklyGoal", () => {
  it("returns 404 when the goal doesn't exist", async () => {
    const notFound = new Error("missing");
    notFound.code = "P2025";
    prisma.weeklyGoal.update.mockRejectedValue(notFound);

    const req = { params: { id: "999" }, body: { title: "New title" } };
    const res = mockRes();
    const next = vi.fn();

    await updateWeeklyGoal(req, res, next);

    expect(res.status).toHaveBeenCalledWith(404);
  });
});

describe("deleteWeeklyGoal", () => {
  it("deletes an existing goal", async () => {
    prisma.weeklyGoal.delete.mockResolvedValue({ id: 1 });

    const req = { params: { id: "1" } };
    const res = mockRes();
    const next = vi.fn();

    await deleteWeeklyGoal(req, res, next);

    expect(prisma.weeklyGoal.delete).toHaveBeenCalledWith({ where: { id: 1 } });
    expect(res.status).toHaveBeenCalledWith(204);
  });
});

describe("updateGoalProgress", () => {
  it("upserts progress for every student in the bulk update", async () => {
    prisma.weeklyGoal.findUnique.mockResolvedValue({ id: 1 });
    prisma.studentGoalProgress.upsert
      .mockResolvedValueOnce({ studentId: 5, progress: 80, status: "Almost there" })
      .mockResolvedValueOnce({ studentId: 6, progress: 100, status: "Mastered" });

    const req = {
      params: { id: "1" },
      body: {
        updates: [
          { studentId: 5, progress: 80, status: "Almost there" },
          { studentId: 6, progress: 100, status: "Mastered" },
        ],
      },
    };
    const res = mockRes();
    const next = vi.fn();

    await updateGoalProgress(req, res, next);

    expect(prisma.studentGoalProgress.upsert).toHaveBeenCalledTimes(2);
    expect(res.json).toHaveBeenCalledWith([
      { studentId: 5, progress: 80, status: "Almost there" },
      { studentId: 6, progress: 100, status: "Mastered" },
    ]);
  });

  it("rejects an out-of-range progress value before touching the database", async () => {
    prisma.weeklyGoal.findUnique.mockResolvedValue({ id: 1 });

    const req = {
      params: { id: "1" },
      body: { updates: [{ studentId: 5, progress: 150, status: "Nope" }] },
    };
    const res = mockRes();
    const next = vi.fn();

    await updateGoalProgress(req, res, next);

    expect(prisma.studentGoalProgress.upsert).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 400 }));
  });

  it("returns 404 when the goal doesn't exist", async () => {
    prisma.weeklyGoal.findUnique.mockResolvedValue(null);

    const req = {
      params: { id: "999" },
      body: { updates: [{ studentId: 5, progress: 50, status: "In progress" }] },
    };
    const res = mockRes();
    const next = vi.fn();

    await updateGoalProgress(req, res, next);

    expect(res.status).toHaveBeenCalledWith(404);
  });
});
