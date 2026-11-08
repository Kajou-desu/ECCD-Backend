import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/lib/prisma.js", () => {
  const prisma = {
    student: { findUnique: vi.fn(), updateMany: vi.fn() },
    user: { findFirst: vi.fn(), findMany: vi.fn(), updateMany: vi.fn() },
    studentTransfer: { create: vi.fn(), findFirst: vi.fn(), findMany: vi.fn(), findUnique: vi.fn(), updateMany: vi.fn() },
    parentChild: { findMany: vi.fn(), count: vi.fn() },
    notification: { create: vi.fn() },
    attendance: { findMany: vi.fn(), updateMany: vi.fn() },
    schoolTimeSettings: { findMany: vi.fn() },
    $transaction: vi.fn(),
  };
  prisma.$transaction.mockImplementation(async (cb) => cb(prisma));
  return { prisma };
});

const { prisma } = await import("../src/lib/prisma.js");
const ctl = await import("../src/controllers/studentTransfers.controller.js");

const teacherA = { id: 10, role: "Teacher", centerId: 1 }; // the student's teacher, center 1 (morning)
const colleague = { id: 11, name: "Cora", centerId: 1, center: { name: "North" } };
const abroad = { id: 20, name: "Dina", centerId: 2, center: { name: "South" } };
const admin = { id: 1, role: "Admin", centerId: null };
const STUDENT = { id: 5, name: "Ana Cruz", session: "morning", teacherId: 10, teacher: { id: 10, name: "Ann", centerId: 1, center: { name: "North" } } };

function mockRes() {
  const res = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res;
}
async function call(fn, req) {
  const res = mockRes();
  const next = vi.fn();
  await fn({ body: {}, params: {}, query: {}, ...req }, res, next);
  return { res, next, status: res.status.mock.calls[0]?.[0] ?? 200, payload: res.json.mock.calls[0]?.[0], error: next.mock.calls[0]?.[0] };
}

const transferRow = (over = {}) => ({
  id: 7, studentId: 5, status: "pending",
  fromTeacherId: 10, toTeacherId: 20, fromCenterId: 1, toCenterId: 2,
  fromSession: "morning", toSession: "morning",
  createdAt: new Date("2026-11-08T00:00:00Z"), resolvedAt: null,
  student: { id: 5, name: "Ana Cruz" },
  fromTeacher: { id: 10, name: "Ann", centerId: 1, center: { name: "North" } },
  toTeacher: abroad,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  prisma.$transaction.mockImplementation(async (cb) => cb(prisma));
  prisma.student.findUnique.mockResolvedValue(STUDENT);
  prisma.student.updateMany.mockResolvedValue({ count: 1 });
  // Active Teachers by id: the student's own teacher (10), a colleague (11), a teacher at another center (20).
  prisma.user.findFirst.mockImplementation(async ({ where }) => ({ 10: transferRow().fromTeacher, 11: colleague, 20: abroad })[where.id] ?? null);
  prisma.user.updateMany.mockResolvedValue({ count: 1 });
  prisma.studentTransfer.findFirst.mockResolvedValue(null);
  prisma.studentTransfer.create.mockImplementation(async ({ data }) => transferRow({ ...data, id: 7, toTeacher: data.toTeacherId === 11 ? colleague : data.toTeacherId === 10 ? transferRow().fromTeacher : abroad }));
  prisma.studentTransfer.updateMany.mockResolvedValue({ count: 1 });
  prisma.studentTransfer.findUnique.mockResolvedValue(transferRow());
  prisma.parentChild.findMany.mockResolvedValue([]);
  prisma.parentChild.count.mockResolvedValue(0);
  prisma.attendance.findMany.mockResolvedValue([]);
  prisma.schoolTimeSettings.findMany.mockResolvedValue([]);
});

describe("starting a transfer", () => {
  it("moves a student to the other session with the same teacher at once", async () => {
    const { status, payload, error } = await call(ctl.createTransfer, { user: teacherA, body: { studentId: 5, toSession: "afternoon" } });
    expect(error).toBeUndefined();
    expect(status).toBe(200);
    expect(payload).toMatchObject({ status: "accepted", fromSession: "morning", toSession: "afternoon" });
    expect(prisma.student.updateMany).toHaveBeenCalledWith({
      where: { id: 5, teacherId: 10, session: "morning" },
      data: { teacherId: 10, session: "afternoon" },
    });
    expect(prisma.notification.create).not.toHaveBeenCalled(); // nobody else is involved
  });

  it("moves a student to a colleague at the same center at once and tells the colleague", async () => {
    const { status, payload } = await call(ctl.createTransfer, { user: teacherA, body: { studentId: 5, toTeacherId: 11, toSession: "afternoon" } });
    expect(status).toBe(200);
    expect(payload.status).toBe("accepted");
    expect(prisma.student.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { teacherId: 11, session: "afternoon" } }));
    expect(prisma.user.updateMany).not.toHaveBeenCalled(); // same center: parents stay put
    expect(prisma.notification.create).toHaveBeenCalledWith({
      data: { userId: 11, title: "Student transferred to you", message: expect.stringContaining("Ana Cruz") },
    });
  });

  it("only asks when the teacher is at another center: nothing moves until they accept", async () => {
    const { status, payload } = await call(ctl.createTransfer, { user: teacherA, body: { studentId: 5, toTeacherId: 20 } });
    expect(status).toBe(202);
    expect(payload).toMatchObject({ status: "pending", toTeacher: { id: 20, centerName: "South" } });
    expect(prisma.student.updateMany).not.toHaveBeenCalled();
    expect(prisma.attendance.findMany).not.toHaveBeenCalled();
    expect(prisma.notification.create).toHaveBeenCalledWith({
      data: { userId: 20, title: "Student transfer request", message: expect.stringContaining("Ana Cruz") },
    });
    const data = prisma.studentTransfer.create.mock.calls[0][0].data;
    expect(data).toMatchObject({ createdById: 10, fromCenterId: 1, toCenterId: 2 });
    expect(data).not.toHaveProperty("status"); // stays at the default, pending
  });

  it("starts only with the student's own teacher: a colleague, a stranger and a missing student all get 403", async () => {
    for (const user of [{ id: 11, role: "Teacher", centerId: 1 }, { id: 30, role: "Teacher", centerId: 9 }, { id: 40, role: "Parent", centerId: 1 }]) {
      const { error } = await call(ctl.createTransfer, { user, body: { studentId: 5, toSession: "afternoon" } });
      expect(error).toMatchObject({ status: 403 });
    }
    prisma.student.findUnique.mockResolvedValue(null);
    expect((await call(ctl.createTransfer, { user: teacherA, body: { studentId: 99, toSession: "afternoon" } })).error).toMatchObject({ status: 403 });
    expect(prisma.studentTransfer.create).not.toHaveBeenCalled();
    expect(prisma.student.updateMany).not.toHaveBeenCalled();
  });

  it("lets an Admin move anyone anywhere at once, and moves the parents' accounts along", async () => {
    prisma.parentChild.findMany.mockResolvedValue([{ parentId: 50, parent: { centerId: 1 } }, { parentId: 51, parent: { centerId: 2 } }]);
    const { status, payload } = await call(ctl.createTransfer, { user: admin, body: { studentId: 5, toTeacherId: 20 } });
    expect(status).toBe(200);
    expect(payload.status).toBe("accepted");
    expect(prisma.user.updateMany).toHaveBeenCalledWith({ where: { id: { in: [50] } }, data: { centerId: 2 } }); // 51 is already there
  });

  it("refuses bad input before writing anything", async () => {
    const bad = [
      [{ toSession: "afternoon" }, "no studentId"],
      [{ studentId: 5, toSession: "evening" }, "bad session"],
      [{ studentId: 5 }, "nothing to change"],
      [{ studentId: 5, toTeacherId: 10 }, "same teacher, same session"],
      [{ studentId: "x", toSession: "afternoon" }, "non-numeric id"],
    ];
    for (const [body] of bad) {
      expect((await call(ctl.createTransfer, { user: teacherA, body })).error).toMatchObject({ status: 400 });
    }
    expect((await call(ctl.createTransfer, { user: teacherA, body: { studentId: 5, toTeacherId: 77 } })).error).toMatchObject({ status: 400 }); // not an active Teacher
    prisma.user.findFirst.mockResolvedValue({ ...abroad, centerId: null }); // no center
    expect((await call(ctl.createTransfer, { user: teacherA, body: { studentId: 5, toTeacherId: 20 } })).error).toMatchObject({ status: 400 });
    expect(prisma.studentTransfer.create).not.toHaveBeenCalled();
  });

  it("asks an Admin to choose a teacher for a student who has none", async () => {
    prisma.student.findUnique.mockResolvedValue({ ...STUDENT, teacherId: null, teacher: null });
    expect((await call(ctl.createTransfer, { user: admin, body: { studentId: 5, toSession: "afternoon" } })).error).toMatchObject({ status: 400 });
  });

  it("allows only one open request per student", async () => {
    prisma.studentTransfer.findFirst.mockResolvedValue({ id: 3 });
    expect((await call(ctl.createTransfer, { user: teacherA, body: { studentId: 5, toTeacherId: 20 } })).error).toMatchObject({ status: 409 });
    prisma.studentTransfer.findFirst.mockResolvedValue(null);
    prisma.studentTransfer.create.mockRejectedValue(Object.assign(new Error("unique"), { code: "P2002" })); // lost a race
    expect((await call(ctl.createTransfer, { user: teacherA, body: { studentId: 5, toTeacherId: 20 } })).error).toMatchObject({ status: 409 });
  });

  it("passes unexpected database errors on untouched", async () => {
    prisma.studentTransfer.create.mockRejectedValue(new Error("db down"));
    expect((await call(ctl.createTransfer, { user: teacherA, body: { studentId: 5, toTeacherId: 20 } })).error.message).toBe("db down");
  });

  it("judges the student's old records before the move, so history does not change with it", async () => {
    const order = [];
    prisma.attendance.findMany.mockImplementation(async () => { order.push("freeze"); return []; });
    prisma.student.updateMany.mockImplementation(async () => { order.push("move"); return { count: 1 }; });
    await call(ctl.createTransfer, { user: teacherA, body: { studentId: 5, toSession: "afternoon" } });
    expect(order).toEqual(["freeze", "move"]);
    expect(prisma.attendance.findMany.mock.calls[0][0].where).toEqual({ studentId: 5, late: null });
  });
});

describe("answering a pending transfer", () => {
  const receiver = { id: 20, role: "Teacher", centerId: 2 };

  it("accept: the receiving teacher takes the student, the parents follow, the requester is told", async () => {
    prisma.parentChild.findMany.mockResolvedValue([{ parentId: 50, parent: { centerId: 1 } }]);
    const { payload, error } = await call(ctl.acceptTransfer, { user: receiver, params: { id: "7" } });
    expect(error).toBeUndefined();
    expect(prisma.studentTransfer.updateMany).toHaveBeenCalledWith({ where: { id: 7, status: "pending" }, data: expect.objectContaining({ status: "accepted", resolvedById: 20 }) });
    expect(prisma.student.updateMany).toHaveBeenCalledWith({ where: { id: 5, teacherId: 10, session: "morning" }, data: { teacherId: 20, session: "morning" } });
    expect(prisma.user.updateMany).toHaveBeenCalledWith({ where: { id: { in: [50] } }, data: { centerId: 2 } });
    expect(prisma.notification.create).toHaveBeenCalledWith({ data: { userId: 10, title: "Transfer accepted", message: expect.stringContaining("Dina") } });
    expect(payload.id).toBe(7);
  });

  it("accept: refuses, and moves nothing, when a parent's other child stays at the old center", async () => {
    prisma.parentChild.findMany.mockResolvedValue([{ parentId: 50, parent: { centerId: 1 } }]);
    prisma.parentChild.count.mockResolvedValue(1);
    const { error } = await call(ctl.acceptTransfer, { user: receiver, params: { id: "7" } });
    expect(error).toMatchObject({ status: 400 });
    expect(prisma.student.updateMany).not.toHaveBeenCalled();
    expect(prisma.user.updateMany).not.toHaveBeenCalled();
    expect(prisma.parentChild.count.mock.calls[0][0].where).toEqual({
      parentId: { in: [50] }, studentId: { not: 5 }, student: { teacher: { centerId: 1 } },
    });
  });

  it("accept: refuses when the student was moved by someone else since the request", async () => {
    prisma.student.updateMany.mockResolvedValue({ count: 0 });
    expect((await call(ctl.acceptTransfer, { user: receiver, params: { id: "7" } })).error).toMatchObject({ status: 409 });
  });

  it("only the receiving teacher (or an Admin) may accept or decline; only the requester (or an Admin) may cancel", async () => {
    const requester = { id: 10, role: "Teacher", centerId: 1 };
    const stranger = { id: 30, role: "Teacher", centerId: 2 };
    for (const user of [requester, stranger]) {
      expect((await call(ctl.acceptTransfer, { user, params: { id: "7" } })).error).toMatchObject({ status: 403 });
      expect((await call(ctl.declineTransfer, { user, params: { id: "7" } })).error).toMatchObject({ status: 403 });
    }
    for (const user of [receiver, stranger]) {
      expect((await call(ctl.cancelTransfer, { user, params: { id: "7" } })).error).toMatchObject({ status: 403 });
    }
    expect(prisma.studentTransfer.updateMany).not.toHaveBeenCalled();
    expect((await call(ctl.acceptTransfer, { user: admin, params: { id: "7" } })).error).toBeUndefined();
    expect((await call(ctl.cancelTransfer, { user: requester, params: { id: "7" } })).error).toBeUndefined();
  });

  it("a transfer that doesn't exist looks the same as one that isn't yours", async () => {
    prisma.studentTransfer.findUnique.mockResolvedValue(null);
    expect((await call(ctl.acceptTransfer, { user: receiver, params: { id: "99" } })).error).toMatchObject({ status: 403 });
  });

  it("answers once: an already-answered transfer, or a lost race, is a 409 that changes nothing", async () => {
    prisma.studentTransfer.findUnique.mockResolvedValue(transferRow({ status: "accepted" }));
    expect((await call(ctl.acceptTransfer, { user: receiver, params: { id: "7" } })).error).toMatchObject({ status: 409 });
    prisma.studentTransfer.findUnique.mockResolvedValue(transferRow());
    prisma.studentTransfer.updateMany.mockResolvedValue({ count: 0 });
    expect((await call(ctl.acceptTransfer, { user: receiver, params: { id: "7" } })).error).toMatchObject({ status: 409 });
    expect(prisma.student.updateMany).not.toHaveBeenCalled();
  });

  it("decline: the student stays, the requester is told", async () => {
    await call(ctl.declineTransfer, { user: receiver, params: { id: "7" } });
    expect(prisma.studentTransfer.updateMany.mock.calls[0][0].data.status).toBe("declined");
    expect(prisma.student.updateMany).not.toHaveBeenCalled();
    expect(prisma.notification.create).toHaveBeenCalledWith({ data: { userId: 10, title: "Transfer declined", message: expect.any(String) } });
  });

  it("cancel: nothing moves, the receiving teacher is told", async () => {
    await call(ctl.cancelTransfer, { user: { id: 10, role: "Teacher", centerId: 1 }, params: { id: "7" } });
    expect(prisma.studentTransfer.updateMany.mock.calls[0][0].data.status).toBe("cancelled");
    expect(prisma.student.updateMany).not.toHaveBeenCalled();
    expect(prisma.notification.create).toHaveBeenCalledWith({ data: { userId: 20, title: "Transfer cancelled", message: expect.any(String) } });
  });
});

describe("listing", () => {
  it("a Teacher sees what waits for them and what they asked for, never anyone else's", async () => {
    prisma.studentTransfer.findMany.mockResolvedValueOnce([transferRow()]).mockResolvedValueOnce([]);
    const { payload } = await call(ctl.listTransfers, { user: { id: 20, role: "Teacher", centerId: 2 } });
    expect(prisma.studentTransfer.findMany.mock.calls[0][0].where).toEqual({ status: "pending", toTeacherId: 20 });
    expect(prisma.studentTransfer.findMany.mock.calls[1][0].where).toEqual({ status: "pending", fromTeacherId: 20 });
    expect(payload.incoming).toHaveLength(1);
    expect(payload.incoming[0]).toMatchObject({ student: { name: "Ana Cruz" }, toTeacher: { centerName: "South" } });
    expect(Object.keys(payload.incoming[0].fromTeacher).sort()).toEqual(["centerId", "centerName", "id", "name"]);
  });

  it("an Admin sees every pending request", async () => {
    prisma.studentTransfer.findMany.mockResolvedValue([transferRow()]);
    await call(ctl.listTransfers, { user: admin });
    expect(prisma.studentTransfer.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.studentTransfer.findMany.mock.calls[0][0].where).toEqual({ status: "pending" });
  });

  it("lists the teachers a student can move to, without the requester and with only id, name and center", async () => {
    prisma.user.findMany.mockResolvedValue([colleague, abroad]);
    const { payload } = await call(ctl.listTransferTeachers, { user: teacherA });
    expect(prisma.user.findMany.mock.calls[0][0].where).toEqual({ role: "Teacher", isActive: true, centerId: { not: null }, id: { not: 10 } });
    expect(payload).toEqual([
      { id: 11, name: "Cora", centerId: 1, centerName: "North" },
      { id: 20, name: "Dina", centerId: 2, centerName: "South" },
    ]);
  });
});
