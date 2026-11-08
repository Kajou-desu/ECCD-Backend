import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    center: { findUnique: vi.fn() },
    schoolTimeSettings: { findUnique: vi.fn(), upsert: vi.fn(), findMany: vi.fn() },
  },
}));

const { prisma } = await import("../src/lib/prisma.js");
const { getSchoolTimes, updateSchoolTimes } = await import("../src/controllers/schoolTimes.controller.js");
const { loadSchoolTimes, schoolTimesFor } = await import("../src/lib/schoolTimes.js");
const { DEFAULT_SCHOOL_TIMES } = await import("../src/utils/schoolTimes.js");

const admin = { id: 1, role: "Admin", centerId: null };
const teacher = { id: 5, role: "Teacher", centerId: 8 };
const body = { morningStart: "08:30", morningEnd: "11:00", afternoonStart: "13:15", afternoonEnd: "15:00" };
const row = { centerId: 8, morningStartMin: 510, morningEndMin: 660, afternoonStartMin: 795, afternoonEndMin: 900 };

function mockRes() {
  const res = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res;
}
const call = async (fn, req) => {
  const res = mockRes();
  const next = vi.fn();
  await fn({ query: {}, body: {}, ...req }, res, next);
  return { res, next, payload: res.json.mock.calls[0]?.[0], error: next.mock.calls[0]?.[0] };
};

beforeEach(() => {
  vi.clearAllMocks();
  prisma.center.findUnique.mockResolvedValue({ id: 8 });
  prisma.schoolTimeSettings.findUnique.mockResolvedValue(null);
  prisma.schoolTimeSettings.upsert.mockImplementation(async ({ create }) => ({ id: 1, ...create }));
});

describe("getSchoolTimes", () => {
  it("shows the defaults, marked as such, until a center saves times", async () => {
    const { payload } = await call(getSchoolTimes, { user: teacher });
    expect(payload).toEqual({
      centerId: 8,
      morningStart: "08:00",
      morningEnd: "10:30",
      afternoonStart: "13:00",
      afternoonEnd: "14:30",
      isDefault: true,
    });
  });

  it("shows the saved times", async () => {
    prisma.schoolTimeSettings.findUnique.mockResolvedValue(row);
    const { payload } = await call(getSchoolTimes, { user: teacher });
    expect(payload).toMatchObject({ centerId: 8, morningStart: "08:30", afternoonStart: "13:15", isDefault: false });
  });

  it("gives a Teacher their own center whatever centerId is sent", async () => {
    await call(getSchoolTimes, { user: teacher, query: { centerId: "99" } });
    expect(prisma.schoolTimeSettings.findUnique).toHaveBeenCalledWith({ where: { centerId: 8 } });
    expect(prisma.center.findUnique.mock.calls[0][0].where).toEqual({ id: 8 });
  });

  it("refuses a Teacher with no center instead of guessing one", async () => {
    const { error } = await call(getSchoolTimes, { user: { ...teacher, centerId: null } });
    expect(error.status).toBe(403);
    expect(prisma.schoolTimeSettings.findUnique).not.toHaveBeenCalled();
  });

  it("makes an Admin name the center", async () => {
    const { error } = await call(getSchoolTimes, { user: admin });
    expect(error.status).toBe(400);
    const ok = await call(getSchoolTimes, { user: admin, query: { centerId: "8" } });
    expect(ok.payload.centerId).toBe(8);
  });

  it.each([["abc"], ["0"], ["-1"], ["1e3"], ["99999999999"]])("rejects the Admin centerId %j", async (centerId) => {
    const { error } = await call(getSchoolTimes, { user: admin, query: { centerId } });
    expect(error.status).toBe(400);
  });

  it("answers 404 for a center that does not exist", async () => {
    prisma.center.findUnique.mockResolvedValue(null);
    const { error } = await call(getSchoolTimes, { user: admin, query: { centerId: "77" } });
    expect(error.status).toBe(404);
  });

  it.each([["Parent"], ["Guardian"], [undefined]])("denies the role %s by default", async (role) => {
    const { error } = await call(getSchoolTimes, { user: { id: 9, role, centerId: 8 }, query: { centerId: "8" } });
    expect(error.status).toBe(403);
    expect(prisma.schoolTimeSettings.findUnique).not.toHaveBeenCalled();
  });
});

describe("updateSchoolTimes", () => {
  it("saves a Teacher's own center, ignoring a centerId in the body", async () => {
    const { payload } = await call(updateSchoolTimes, { user: teacher, body: { ...body, centerId: 99 } });
    expect(prisma.schoolTimeSettings.upsert).toHaveBeenCalledWith({
      where: { centerId: 8 },
      update: { morningStartMin: 510, morningEndMin: 660, afternoonStartMin: 795, afternoonEndMin: 900 },
      create: { centerId: 8, morningStartMin: 510, morningEndMin: 660, afternoonStartMin: 795, afternoonEndMin: 900 },
    });
    expect(payload).toMatchObject({ centerId: 8, morningStart: "08:30", afternoonEnd: "15:00", isDefault: false });
  });

  it("lets an Admin save any named center", async () => {
    await call(updateSchoolTimes, { user: admin, body: { ...body, centerId: 3 } });
    expect(prisma.schoolTimeSettings.upsert.mock.calls[0][0].where).toEqual({ centerId: 3 });
  });

  it("makes an Admin name the center, and writes nothing without one", async () => {
    const { error } = await call(updateSchoolTimes, { user: admin, body });
    expect(error.status).toBe(400);
    expect(prisma.schoolTimeSettings.upsert).not.toHaveBeenCalled();
  });

  it("refuses a Teacher with no center", async () => {
    const { error } = await call(updateSchoolTimes, { user: { ...teacher, centerId: null }, body });
    expect(error.status).toBe(403);
    expect(prisma.schoolTimeSettings.upsert).not.toHaveBeenCalled();
  });

  it.each([
    [{ ...body, morningEnd: "08:00" }],
    [{ ...body, afternoonStart: "10:00" }],
    [{ ...body, morningStart: "7am" }],
    [{}],
  ])("answers 400 and saves nothing for %j", async (bad) => {
    const { error } = await call(updateSchoolTimes, { user: teacher, body: bad });
    expect(error.status).toBe(400);
    expect(prisma.schoolTimeSettings.upsert).not.toHaveBeenCalled();
  });

  it("answers 404 when the Admin's center does not exist (foreign key)", async () => {
    prisma.schoolTimeSettings.upsert.mockRejectedValue(Object.assign(new Error("fk"), { code: "P2003" }));
    const { error } = await call(updateSchoolTimes, { user: admin, body: { ...body, centerId: 77 } });
    expect(error.status).toBe(404);
  });

  it("passes unexpected database errors on untouched (the error handler hides them)", async () => {
    const boom = new Error("connection lost");
    prisma.schoolTimeSettings.upsert.mockRejectedValue(boom);
    const { error } = await call(updateSchoolTimes, { user: teacher, body });
    expect(error).toBe(boom);
    expect(error.expose).toBeUndefined();
  });

  it.each([["Parent"], ["Guardian"]])("denies %s by default", async (role) => {
    const { error } = await call(updateSchoolTimes, { user: { id: 9, role, centerId: 8 }, body });
    expect(error.status).toBe(403);
    expect(prisma.schoolTimeSettings.upsert).not.toHaveBeenCalled();
  });
});

describe("loadSchoolTimes / schoolTimesFor", () => {
  it("asks once for the distinct centers involved and skips missing ones", async () => {
    prisma.schoolTimeSettings.findMany.mockResolvedValue([row]);
    const map = await loadSchoolTimes([8, 8, undefined, null, 9]);
    expect(prisma.schoolTimeSettings.findMany).toHaveBeenCalledOnce();
    expect(prisma.schoolTimeSettings.findMany.mock.calls[0][0].where).toEqual({ centerId: { in: [8, 9] } });
    expect(schoolTimesFor(map, 8)).toBe(row);
  });

  it("does not query at all when no student has a center", async () => {
    const map = await loadSchoolTimes([undefined, null]);
    expect(prisma.schoolTimeSettings.findMany).not.toHaveBeenCalled();
    expect(map.size).toBe(0);
  });

  it("falls back to the defaults for a center with no saved times, or none at all", () => {
    expect(schoolTimesFor(new Map(), 9)).toBe(DEFAULT_SCHOOL_TIMES);
    expect(schoolTimesFor(new Map(), undefined)).toBe(DEFAULT_SCHOOL_TIMES);
  });
});
