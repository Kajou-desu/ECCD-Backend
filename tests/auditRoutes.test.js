import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";

vi.mock("../src/lib/prisma.js", () => ({
  prisma: { user: { findUnique: vi.fn() }, student: { findUnique: vi.fn() } },
}));
vi.mock("../src/services/activityLog.service.js", () => ({ recordActivity: vi.fn() }));

const { prisma } = await import("../src/lib/prisma.js");
const { recordActivity } = await import("../src/services/activityLog.service.js");
const routes = await import("../src/middleware/auditRoutes.js");

// Runs one audit middleware like Express would: before the handler, then the
// handler responds, then the response "finishes".
async function run(mw, { req = {}, status = 200, body, send } = {}) {
  const res = new EventEmitter();
  res.statusCode = status;
  res.json = (payload) => payload;
  const fullReq = { params: {}, body: {}, user: { id: 1, email: "admin@school.test", role: "Admin" }, ...req };
  await mw(fullReq, res, () => {});
  if (body !== undefined) res.json(body);
  res.emit("finish");
  void send;
}

beforeEach(() => vi.clearAllMocks());

describe("audit routes", () => {
  it("login logs the signed-in user from the response, never the token", async () => {
    await run(routes.auditLogin, {
      req: { user: undefined },
      body: { token: "SECRET.JWT", user: { id: 4, email: "t@school.test", role: "Teacher" } },
    });
    const call = recordActivity.mock.calls[0][0];
    expect(call.actor.email).toBe("t@school.test");
    expect(JSON.stringify(call)).not.toContain("SECRET");
  });

  it("an account update lists changed field names but never the password value", async () => {
    await run(routes.auditAccountUpdate, {
      req: { body: { userId: 9, firstName: "Ana", password: "Hunter2!hunter2" } },
      body: { id: 9, email: "ana@school.test" },
    });
    const { summary } = recordActivity.mock.calls[0][0];
    expect(summary).toContain("ana@school.test");
    expect(summary).toContain("firstName");
    expect(summary).toContain("(password reset)");
    expect(summary).not.toContain("Hunter2");
  });

  it("deleting your own account is logged without pointing at the deleted user row", async () => {
    await run(routes.auditOwnAccountDelete, { status: 204 });
    expect(recordActivity.mock.calls[0][0].actor).toMatchObject({ id: null, email: "admin@school.test" });
  });

  it("an attendance import preview is not logged; the real import is", async () => {
    await run(routes.auditAttendanceImport, { body: { dryRun: true, created: 1, updated: 0, unchanged: 0, failed: [] } });
    expect(recordActivity).not.toHaveBeenCalled();
    await run(routes.auditAttendanceImport, { body: { dryRun: false, created: 2, updated: 1, unchanged: 0, failed: [] } });
    expect(recordActivity.mock.calls[0][0].summary).toContain("2 added, 1 updated");
  });

  it("a student delete names the student read before the delete", async () => {
    prisma.student.findUnique.mockResolvedValue({ name: "Ana Cruz" });
    await run(routes.auditStudentDelete, { req: { params: { id: "12" } }, status: 204 });
    expect(recordActivity.mock.calls[0][0]).toMatchObject({
      action: "student.delete",
      targetId: 12,
      summary: "Deleted student Ana Cruz",
    });
  });

  it("skips the entry (instead of logging blanks) when the name could not be read", async () => {
    prisma.student.findUnique.mockResolvedValue(null);
    await run(routes.auditStudentDelete, { req: { params: { id: "12" } }, status: 204 });
    expect(recordActivity).not.toHaveBeenCalled();
  });

  it("an error response is never logged", async () => {
    await run(routes.auditStudentCreate, { status: 400, body: { name: "Ana" } });
    expect(recordActivity).not.toHaveBeenCalled();
  });
});
