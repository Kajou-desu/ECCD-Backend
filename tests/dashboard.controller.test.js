import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    dailyTheme: { findUnique: vi.fn(), upsert: vi.fn() },
    student: { count: vi.fn() },
    attendance: { count: vi.fn(), findMany: vi.fn() },
    schoolTimeSettings: { findMany: vi.fn() },
    material: { count: vi.fn(), findUnique: vi.fn() },
  },
}));

const { prisma } = await import("../src/lib/prisma.js");
const { getDashboardStats, getDailyTheme, upsertDailyTheme } = await import("../src/controllers/dashboard.controller.js");

function mockRes() {
  const res = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res;
}

const TEACHER = { id: 7, role: "Teacher", centerId: 4 };
const ADMIN = { id: 1, role: "Admin", centerId: null };

beforeEach(() => {
  vi.clearAllMocks();
  prisma.attendance.findMany.mockReset().mockResolvedValue([]);
  prisma.schoolTimeSettings.findMany.mockReset().mockResolvedValue([]);
});

describe("upsertDailyTheme", () => {
  it("upserts the given date with the provided fields", async () => {
    prisma.dailyTheme.upsert.mockResolvedValue({ id: 1, date: new Date("2026-09-21T00:00:00.000Z") });
    prisma.material.findUnique.mockResolvedValue({ id: 17 });

    const req = {
      user: TEACHER,
      body: {
        date: "2026-09-21",
        letter: "A",
        label: "Apple",
        subtitle: "Fruits",
        title: "Letter A Day",
        description: "Exploring the letter A",
        objectives: ["Recognize the letter A", "Name 3 fruits"],
        materialId: 17,
      },
    };
    const res = mockRes();
    const next = vi.fn();

    await upsertDailyTheme(req, res, next);

    // The attached activity has to be one of the Teacher's own center's.
    expect(prisma.material.findUnique).toHaveBeenCalledWith({
      where: { id: 17, centerId: 4 },
      select: { id: true },
    });
    expect(prisma.dailyTheme.upsert).toHaveBeenCalledWith({
      where: { date: new Date("2026-09-21T00:00:00.000Z") },
      create: expect.objectContaining({
        date: new Date("2026-09-21T00:00:00.000Z"),
        letter: "A",
        title: "Letter A Day",
        objectives: ["Recognize the letter A", "Name 3 fruits"],
        materialId: 17,
      }),
      update: expect.objectContaining({ letter: "A", title: "Letter A Day", materialId: 17 }),
    });
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }));
  });

  it("rejects a missing title", async () => {
    const req = { body: { letter: "A", label: "Apple", objectives: [] } };
    const res = mockRes();
    const next = vi.fn();

    await upsertDailyTheme(req, res, next);

    expect(prisma.dailyTheme.upsert).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 400 }));
  });

  it("rejects a malformed date", async () => {
    const req = { body: { date: "not-a-date", letter: "A", label: "Apple", title: "T", objectives: [] } };
    const res = mockRes();
    const next = vi.fn();

    await upsertDailyTheme(req, res, next);

    expect(prisma.dailyTheme.upsert).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 400 }));
  });
});

describe("upsertDailyTheme and centers", () => {
  const theme = { letter: "A", label: "Apple", title: "Letter A Day", objectives: [] };

  it("refuses an activity of another center, without saving the theme", async () => {
    prisma.material.findUnique.mockResolvedValue(null);
    const res = mockRes();

    await upsertDailyTheme({ user: TEACHER, body: { ...theme, materialId: 99 } }, res, vi.fn());

    expect(prisma.material.findUnique).toHaveBeenCalledWith({ where: { id: 99, centerId: 4 }, select: { id: true } });
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ message: "Material not found" });
    expect(prisma.dailyTheme.upsert).not.toHaveBeenCalled();
  });

  it("lets an Admin attach any center's activity", async () => {
    prisma.material.findUnique.mockResolvedValue({ id: 99 });
    prisma.dailyTheme.upsert.mockResolvedValue({ id: 1 });

    await upsertDailyTheme({ user: ADMIN, body: { ...theme, materialId: 99 } }, mockRes(), vi.fn());

    expect(prisma.material.findUnique).toHaveBeenCalledWith({ where: { id: 99 }, select: { id: true } });
    expect(prisma.dailyTheme.upsert).toHaveBeenCalled();
  });

  it("refuses a Teacher with no center only when an activity is attached", async () => {
    const noCenter = { id: 8, role: "Teacher", centerId: null };
    prisma.dailyTheme.upsert.mockResolvedValue({ id: 1 });

    const next = vi.fn();
    await upsertDailyTheme({ user: noCenter, body: { ...theme, materialId: 5 } }, mockRes(), next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 403 }));
    expect(prisma.dailyTheme.upsert).not.toHaveBeenCalled();

    // A theme without an activity involves no center at all, so it still works.
    await upsertDailyTheme({ user: noCenter, body: theme }, mockRes(), vi.fn());
    expect(prisma.material.findUnique).not.toHaveBeenCalled();
    expect(prisma.dailyTheme.upsert).toHaveBeenCalledTimes(1);
  });
});

describe("getDailyTheme", () => {
  it("looks up the school-local day before UTC midnight", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-19T23:30:00.000Z"));
    prisma.dailyTheme.findUnique.mockResolvedValue(null);

    const res = mockRes();
    await getDailyTheme({ user: TEACHER }, res, vi.fn());

    expect(prisma.dailyTheme.findUnique).toHaveBeenCalledWith({
      where: { date: new Date("2026-09-20T00:00:00.000Z") },
      include: { material: true },
    });
    vi.useRealTimers();
  });

  it("returns a signed URL for the linked activity file", async () => {
    prisma.dailyTheme.findUnique.mockResolvedValue({
      id: 1,
      material: { id: 17, title: "Letter A worksheet", fileUrl: "activity.pdf", centerId: 4 },
    });

    const res = mockRes();
    const req = { user: TEACHER, protocol: "https", get: () => "classroom.example" };
    await getDailyTheme(req, res, vi.fn());

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      material: expect.objectContaining({
        id: 17,
        fileUrl: expect.stringMatching(/^https:\/\/classroom\.example\/api\/files\/activity\.pdf\?/),
      }),
    }));
  });

  it("hides an activity of another center, but still shows the school-wide theme", async () => {
    prisma.dailyTheme.findUnique.mockResolvedValue({
      id: 1,
      title: "Letter A Day",
      material: { id: 17, title: "Other center's worksheet", fileUrl: "secret.pdf", centerId: 9 },
    });

    const res = mockRes();
    await getDailyTheme({ user: TEACHER, protocol: "https", get: () => "classroom.example" }, res, vi.fn());

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ title: "Letter A Day", material: null }));
  });

  it("shows an Admin the activity whichever center it belongs to, and a Teacher with no center none", async () => {
    const theme = { id: 1, material: { id: 17, title: "W", fileUrl: "a.pdf", centerId: 9 } };
    prisma.dailyTheme.findUnique.mockResolvedValue(theme);
    const base = { protocol: "https", get: () => "classroom.example" };

    const admin = mockRes();
    await getDailyTheme({ ...base, user: ADMIN }, admin, vi.fn());
    expect(admin.json).toHaveBeenCalledWith(expect.objectContaining({ material: expect.objectContaining({ id: 17 }) }));

    const noCenter = mockRes();
    await getDailyTheme({ ...base, user: { id: 8, role: "Teacher", centerId: null } }, noCenter, vi.fn());
    expect(noCenter.json).toHaveBeenCalledWith(expect.objectContaining({ material: null }));
  });
});

describe("getDashboardStats", () => {
  afterEach(() => vi.useRealTimers());

  // 8:20 AM and 7:50 AM local time (Asia/Manila) on the school day 2026-09-30.
  const row = (arrivedAt, centerId = undefined, session = "morning") => ({
    arrivedAt: arrivedAt ? new Date(arrivedAt) : null,
    student: { session, teacher: centerId === undefined ? null : { centerId } },
  });

  it("counts the school's current day, not the server's (UTC) day", async () => {
    // 7:30 AM Sept 30 in Manila is still Sept 29 in UTC.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-29T23:30:00.000Z"));
    prisma.student.count.mockResolvedValue(10);
    prisma.attendance.findMany.mockResolvedValue([row("2026-09-29T23:50:00Z"), row("2026-09-30T00:20:00Z")]);
    prisma.attendance.count.mockResolvedValueOnce(1).mockResolvedValueOnce(2);
    prisma.material.count.mockResolvedValue(3);

    const res = mockRes();
    await getDashboardStats({ user: { id: 1, role: "Admin" } }, res, vi.fn());

    const day = new Date("2026-09-30T00:00:00.000Z");
    expect(prisma.attendance.findMany.mock.calls[0][0].where).toEqual({ date: day, status: "present", student: {} });
    expect(prisma.attendance.count).toHaveBeenCalledWith({ where: { date: day, status: "absent", student: {} } });
    expect(prisma.attendance.count).toHaveBeenCalledWith({ where: { date: day, status: "excused", student: {} } });
    expect(res.json).toHaveBeenCalledWith({
      totalStudents: 10,
      presentToday: 2,
      lateToday: 1,
      absentToday: 1,
      excusedToday: 2,
      totalMaterials: 3,
    });
  });

  it("counts late against each student's own center's school times", async () => {
    prisma.student.count.mockResolvedValue(3);
    prisma.attendance.count.mockResolvedValue(0);
    prisma.material.count.mockResolvedValue(0);
    prisma.attendance.findMany.mockResolvedValue([
      row("2026-09-30T00:20:00Z", 4), // 8:20 — center 4 starts at 8:30, so on time
      row("2026-09-30T00:20:00Z", 5), // 8:20 — center 5 has saved nothing, default 8:00
      row("2026-09-30T00:20:00Z"), // 8:20 — no teacher, default
      row(null, 5), // marked by hand: never late
    ]);
    prisma.schoolTimeSettings.findMany.mockResolvedValue([
      { centerId: 4, morningStartMin: 8 * 60 + 30, afternoonStartMin: 13 * 60 },
    ]);
    const res = mockRes();
    await getDashboardStats({ user: ADMIN }, res, vi.fn());
    expect(res.json.mock.calls[0][0]).toMatchObject({ presentToday: 4, lateToday: 2 });
    expect(prisma.schoolTimeSettings.findMany.mock.calls[0][0].where).toEqual({ centerId: { in: [4, 5] } });
  });

  it("counts a Teacher's whole center, so two teachers there get the same numbers", async () => {
    prisma.student.count.mockResolvedValue(3);
    prisma.attendance.count.mockResolvedValue(2);
    prisma.material.count.mockResolvedValue(1);
    for (const id of [7, 8]) {
      vi.clearAllMocks();
      prisma.student.count.mockResolvedValue(3);
      prisma.attendance.count.mockResolvedValue(2);
      prisma.attendance.findMany.mockResolvedValue([]);
      await getDashboardStats({ user: { id, role: "Teacher", centerId: 4 } }, mockRes(), vi.fn());
      expect(prisma.student.count).toHaveBeenCalledWith({ where: { teacher: { centerId: 4 } } });
      expect(prisma.attendance.findMany.mock.calls[0][0].where).toEqual({
        date: expect.any(Date),
        status: "present",
        student: { teacher: { centerId: 4 } },
      });
      for (const status of ["absent", "excused"]) {
        expect(prisma.attendance.count).toHaveBeenCalledWith({
          where: { date: expect.any(Date), status, student: { teacher: { centerId: 4 } } },
        });
      }
    }
  });

  it("falls back to a Teacher's own students while they have no center", async () => {
    prisma.student.count.mockResolvedValue(1);
    await getDashboardStats({ user: { id: 7, role: "Teacher", centerId: null } }, mockRes(), vi.fn());
    expect(prisma.student.count).toHaveBeenCalledWith({ where: { teacherId: 7 } });
  });

  it("counts only the materials of a Teacher's own center, and every material for an Admin", async () => {
    prisma.student.count.mockResolvedValue(1);
    prisma.attendance.count.mockResolvedValue(0);
    prisma.material.count.mockResolvedValue(2);

    await getDashboardStats({ user: TEACHER }, mockRes(), vi.fn());
    expect(prisma.material.count).toHaveBeenLastCalledWith({ where: { centerId: 4 } });

    await getDashboardStats({ user: ADMIN }, mockRes(), vi.fn());
    expect(prisma.material.count).toHaveBeenLastCalledWith({ where: {} });
  });

  it("shows 0 materials, without counting, to a Teacher with no center", async () => {
    prisma.student.count.mockResolvedValue(1);
    prisma.attendance.count.mockResolvedValue(0);
    const res = mockRes();

    await getDashboardStats({ user: { id: 7, role: "Teacher", centerId: null } }, res, vi.fn());

    expect(prisma.material.count).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ totalMaterials: 0 }));
  });

  it("refuses any other role without querying", async () => {
    const res = mockRes();
    await getDashboardStats({ user: { id: 9, role: "Parent" } }, res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(403);
    expect(prisma.student.count).not.toHaveBeenCalled();
  });
});
