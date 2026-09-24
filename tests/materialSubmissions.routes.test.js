import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";

process.env.JWT_SECRET = "test-secret-at-least-32-characters-long";
process.env.CLIENT_ORIGIN = "http://localhost:5173";

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    $queryRaw: vi.fn(),
    user: { findUnique: vi.fn() },
    material: { findUnique: vi.fn() },
  },
}));

const { prisma } = await import("../src/lib/prisma.js");
const { signToken } = await import("../src/utils/jwt.js");
const { app } = await import("../src/app.js");

// requireAuth re-reads the user from the DB on every request, so the mocked
// user record IS the identity/role under test.
function loginAs(role, id = 1) {
  const user = { id, email: `u${id}@school.test`, role, isActive: true, tokenVersion: 0 };
  prisma.user.findUnique.mockResolvedValue(user);
  return `Bearer ${signToken(user)}`;
}

const SUBMITTED_AT = new Date("2026-09-24T00:15:00.000Z");
const MATERIAL = {
  id: 7,
  title: "Number Tracing",
  category: "Math",
  submissions: [
    {
      id: 11,
      studentId: 3,
      fileName: "kenneth.pdf",
      fileUrl: "http://localhost:4000/api/files/1758400000000-0123456789abcdef.pdf",
      submittedAt: SUBMITTED_AT,
      student: { name: "Kenneth Alvarez" },
    },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/materials/:id/submissions — access control (default deny)", () => {
  it("401 without a token, and never queries materials", async () => {
    const res = await request(app).get("/api/materials/7/submissions");
    expect(res.status).toBe(401);
    expect(prisma.material.findUnique).not.toHaveBeenCalled();
  });

  it.each(["Parent", "Guardian", "Student", "SomethingElse"])(
    "403 for role %s — one family must never see every child's work",
    async (role) => {
      const res = await request(app)
        .get("/api/materials/7/submissions")
        .set("Authorization", loginAs(role));
      expect(res.status).toBe(403);
      expect(prisma.material.findUnique).not.toHaveBeenCalled();
    },
  );
});

describe("GET /api/materials/:id/submissions — behaviour", () => {
  it.each(["Teacher", "Admin"])("%s gets the material and its submissions (also under /api/v1)", async (role) => {
    prisma.material.findUnique.mockResolvedValue(MATERIAL);
    const auth = loginAs(role);

    for (const prefix of ["/api", "/api/v1"]) {
      const res = await request(app).get(`${prefix}/materials/7/submissions`).set("Authorization", auth);

      expect(res.status).toBe(200);
      expect(res.body.material).toEqual({ id: 7, title: "Number Tracing", category: "Math" });
      expect(res.body.submissions).toHaveLength(1);
      expect(res.body.submissions[0]).toMatchObject({
        id: 11,
        studentId: 3,
        studentName: "Kenneth Alvarez",
        fileName: "kenneth.pdf",
        submittedAt: SUBMITTED_AT.toISOString(),
      });
    }
  });

  it("returns a freshly signed, expiring file URL rather than the stored value", async () => {
    prisma.material.findUnique.mockResolvedValue(MATERIAL);

    const res = await request(app)
      .get("/api/materials/7/submissions")
      .set("Authorization", loginAs("Teacher"));

    const url = new URL(res.body.submissions[0].fileUrl);
    expect(url.pathname).toBe("/api/files/1758400000000-0123456789abcdef.pdf");
    expect(url.searchParams.get("exp")).toBeTruthy();
    expect(url.searchParams.get("sig")).toBeTruthy();
  });

  it("does not leak the nested student object or any other student field", async () => {
    prisma.material.findUnique.mockResolvedValue(MATERIAL);

    const res = await request(app)
      .get("/api/materials/7/submissions")
      .set("Authorization", loginAs("Teacher"));

    expect(res.body.submissions[0]).not.toHaveProperty("student");
    expect(Object.keys(res.body.submissions[0]).sort()).toEqual(
      ["fileName", "fileUrl", "id", "studentId", "studentName", "submittedAt"],
    );
  });

  it("asks the database for only the fields it returns, newest submission first", async () => {
    prisma.material.findUnique.mockResolvedValue(MATERIAL);

    await request(app).get("/api/materials/7/submissions").set("Authorization", loginAs("Teacher"));

    expect(prisma.material.findUnique).toHaveBeenCalledWith({
      where: { id: 7 },
      select: {
        id: true,
        title: true,
        category: true,
        submissions: {
          orderBy: { submittedAt: "desc" },
          select: {
            id: true,
            studentId: true,
            fileName: true,
            fileUrl: true,
            submittedAt: true,
            student: { select: { name: true } },
          },
        },
      },
    });
  });

  it("returns an empty list (not an error) for a material nobody has submitted to", async () => {
    prisma.material.findUnique.mockResolvedValue({ ...MATERIAL, submissions: [] });

    const res = await request(app)
      .get("/api/materials/7/submissions")
      .set("Authorization", loginAs("Teacher"));

    expect(res.status).toBe(200);
    expect(res.body.submissions).toEqual([]);
  });

  it("404 for an unknown material", async () => {
    prisma.material.findUnique.mockResolvedValue(null);

    const res = await request(app)
      .get("/api/materials/999/submissions")
      .set("Authorization", loginAs("Teacher"));

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ message: "Material not found" });
  });

  it.each(["abc", "0", "-3", "1.5"])("400 for a non-positive-integer id (%s), without querying", async (badId) => {
    const res = await request(app)
      .get(`/api/materials/${badId}/submissions`)
      .set("Authorization", loginAs("Teacher"));

    expect(res.status).toBe(400);
    expect(prisma.material.findUnique).not.toHaveBeenCalled();
  });

  it("returns a generic 500 with no internals when the database fails", async () => {
    prisma.material.findUnique.mockRejectedValue(new Error("connect ECONNREFUSED 10.0.0.5:5432 prisma"));

    const res = await request(app)
      .get("/api/materials/7/submissions")
      .set("Authorization", loginAs("Teacher"));

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ message: "Something went wrong" });
  });
});
