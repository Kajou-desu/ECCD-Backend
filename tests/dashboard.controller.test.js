import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    dailyTheme: { upsert: vi.fn() },
  },
}));

const { prisma } = await import("../src/lib/prisma.js");
const { upsertDailyTheme } = await import("../src/controllers/dashboard.controller.js");

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
      }),
      update: expect.objectContaining({ letter: "A", title: "Letter A Day" }),
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
