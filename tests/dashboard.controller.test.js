import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    dailyTheme: { findUnique: vi.fn(), upsert: vi.fn() },
    student: { count: vi.fn() },
    attendance: { count: vi.fn() },
    material: { count: vi.fn() },
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

beforeEach(() => {
  vi.clearAllMocks();
});

describe("upsertDailyTheme", () => {
  it("upserts the given date with the provided fields", async () => {
    prisma.dailyTheme.upsert.mockResolvedValue({ id: 1, date: new Date("2026-09-21T00:00:00.000Z") });

    const req = {
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

describe("getDailyTheme", () => {
  it("looks up the school-local day before UTC midnight", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-19T23:30:00.000Z"));
    prisma.dailyTheme.findUnique.mockResolvedValue(null);

    const res = mockRes();
    await getDailyTheme({}, res, vi.fn());

    expect(prisma.dailyTheme.findUnique).toHaveBeenCalledWith({
      where: { date: new Date("2026-09-20T00:00:00.000Z") },
      include: { material: true },
    });
    vi.useRealTimers();
  });

  it("returns a signed URL for the linked activity file", async () => {
    prisma.dailyTheme.findUnique.mockResolvedValue({
      id: 1,
      material: { id: 17, title: "Letter A worksheet", fileUrl: "activity.pdf" },
    });

    const res = mockRes();
    const req = { protocol: "https", get: () => "classroom.example" };
    await getDailyTheme(req, res, vi.fn());

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      material: expect.objectContaining({
        id: 17,
        fileUrl: expect.stringMatching(/^https:\/\/classroom\.example\/api\/files\/activity\.pdf\?/),
      }),
    }));
  });
});

describe("getDashboardStats", () => {
  afterEach(() => vi.useRealTimers());

  it("counts the school's current day, not the server's (UTC) day", async () => {
    // 7:30 AM Sept 30 in Manila is still Sept 29 in UTC.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-29T23:30:00.000Z"));
    prisma.student.count.mockResolvedValue(10);
    prisma.attendance.count.mockResolvedValueOnce(4).mockResolvedValueOnce(1);
    prisma.material.count.mockResolvedValue(3);

    const res = mockRes();
    await getDashboardStats({}, res, vi.fn());

    const day = new Date("2026-09-30T00:00:00.000Z");
    expect(prisma.attendance.count).toHaveBeenCalledWith({ where: { date: day, status: "present" } });
    expect(prisma.attendance.count).toHaveBeenCalledWith({ where: { date: day, status: "absent" } });
    expect(res.json).toHaveBeenCalledWith({ totalStudents: 10, presentToday: 4, absentToday: 1, totalMaterials: 3 });
  });
});
