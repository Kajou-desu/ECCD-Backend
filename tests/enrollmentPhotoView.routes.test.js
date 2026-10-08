import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";

process.env.JWT_SECRET = "test-secret-at-least-32-characters-long";
process.env.CLIENT_ORIGIN = "http://localhost:5173";

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    $queryRaw: vi.fn(),
    user: { findUnique: vi.fn() },
    student: { findUnique: vi.fn() },
    parentChild: { findUnique: vi.fn() },
  },
}));
vi.mock("../src/services/recognitionClient.js", async (importOriginal) => ({
  ...(await importOriginal()),
  isRecognitionConfigured: vi.fn(() => true),
  countStudentEnrollmentPhotos: vi.fn(),
  fetchStudentEnrollmentPhoto: vi.fn(),
}));

const { prisma } = await import("../src/lib/prisma.js");
const { isRecognitionConfigured, countStudentEnrollmentPhotos, fetchStudentEnrollmentPhoto, RecognitionStaleError } = await import(
  "../src/services/recognitionClient.js"
);
const { signToken } = await import("../src/utils/jwt.js");
const { app } = await import("../src/app.js");

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
const LIST = "/api/students/5/enrollment-photos";

function auth(role = "Teacher", id = 9) {
  const user = { id, email: "t@school.test", role, isActive: true, tokenVersion: 0 };
  prisma.user.findUnique.mockResolvedValue(user);
  return `Bearer ${signToken(user)}`;
}

beforeEach(() => {
  vi.clearAllMocks();
  isRecognitionConfigured.mockReturnValue(true);
  prisma.student.findUnique.mockResolvedValue({ id: 5, teacherId: 9 });
  prisma.parentChild.findUnique.mockResolvedValue(null);
  countStudentEnrollmentPhotos.mockResolvedValue({ studentId: 5, count: 3 });
  fetchStudentEnrollmentPhoto.mockResolvedValue({ buffer: JPEG, contentType: "image/jpeg" });
});

describe("GET /students/:id/enrollment-photos (count)", () => {
  it("401 anonymous; 403 Parent (even one linked to the child); the service is never asked", async () => {
    expect((await request(app).get(LIST)).status).toBe(401);
    prisma.parentChild.findUnique.mockResolvedValue({ parentId: 9, studentId: 5 });
    expect((await request(app).get(LIST).set("Authorization", auth("Parent"))).status).toBe(403);
    expect(countStudentEnrollmentPhotos).not.toHaveBeenCalled();
  });

  it("403 for a Teacher who isn't connected to that student (no IDOR)", async () => {
    prisma.student.findUnique.mockResolvedValue({ id: 5, teacherId: 77 });
    const res = await request(app).get(LIST).set("Authorization", auth("Teacher", 9));
    expect(res.status).toBe(403);
    expect(countStudentEnrollmentPhotos).not.toHaveBeenCalled();
  });

  it("returns only the count, uncached", async () => {
    const res = await request(app).get(LIST).set("Authorization", auth());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ count: 3 });
    expect(res.headers["cache-control"]).toMatch(/no-store/);
  });

  it("503 when recognition isn't configured; 502 generic when the service fails", async () => {
    isRecognitionConfigured.mockReturnValue(false);
    expect((await request(app).get(LIST).set("Authorization", auth())).status).toBe(503);

    isRecognitionConfigured.mockReturnValue(true);
    countStudentEnrollmentPhotos.mockRejectedValue(new Error("connect ECONNREFUSED 10.1.2.3:8001 key=abc"));
    const res = await request(app).get(LIST).set("Authorization", auth());
    expect(res.status).toBe(502);
    expect(JSON.stringify(res.body)).not.toMatch(/10\.1\.2\.3|ECONNREFUSED|abc/);
  });
});

describe("GET /students/:id/enrollment-photos/:index (one photo)", () => {
  it("401 anonymous; 403 Parent; 403 unconnected Teacher", async () => {
    expect((await request(app).get(`${LIST}/0`)).status).toBe(401);
    expect((await request(app).get(`${LIST}/0`).set("Authorization", auth("Parent"))).status).toBe(403);
    prisma.student.findUnique.mockResolvedValue({ id: 5, teacherId: 77 });
    expect((await request(app).get(`${LIST}/0`).set("Authorization", auth())).status).toBe(403);
    expect(fetchStudentEnrollmentPhoto).not.toHaveBeenCalled();
  });

  it("serves the image with no-store, nosniff and the right type; Admin allowed", async () => {
    const res = await request(app).get(`${LIST}/1`).set("Authorization", auth("Admin", 1));
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("image/jpeg");
    expect(res.headers["cache-control"]).toMatch(/no-store/);
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(fetchStudentEnrollmentPhoto).toHaveBeenCalledWith(5, 1, undefined);
  });

  it.each(["-1", "abc", "1.5", "20", "100", "../0"])("400 for a bad index %s, before the service is called", async (bad) => {
    const res = await request(app).get(`${LIST}/${encodeURIComponent(bad)}`).set("Authorization", auth());
    expect([400, 404]).toContain(res.status);
    expect(fetchStudentEnrollmentPhoto).not.toHaveBeenCalled();
  });

  it("404 when the photo doesn't exist", async () => {
    fetchStudentEnrollmentPhoto.mockResolvedValue(null);
    expect((await request(app).get(`${LIST}/2`).set("Authorization", auth())).status).toBe(404);
  });

  it("502 (not served) when the bytes don't match the declared image type", async () => {
    fetchStudentEnrollmentPhoto.mockResolvedValue({ buffer: Buffer.from("<script>x</script>"), contentType: "image/jpeg" });
    const res = await request(app).get(`${LIST}/0`).set("Authorization", auth());
    expect(res.status).toBe(502);
    expect(res.text).not.toContain("<script>");
  });

  it("502 generic when the service is down", async () => {
    fetchStudentEnrollmentPhoto.mockRejectedValue(new Error("boom 10.1.2.3"));
    const res = await request(app).get(`${LIST}/0`).set("Authorization", auth());
    expect(res.status).toBe(502);
    expect(JSON.stringify(res.body)).not.toMatch(/boom|10\.1\.2\.3/);
  });
});

describe("enrollment photo set version", () => {
  const V = "0123456789abcdef";

  it("the count includes the version when the service sends one", async () => {
    countStudentEnrollmentPhotos.mockResolvedValue({ studentId: 5, count: 3, version: V });
    const res = await request(app).get(LIST).set("Authorization", auth());
    expect(res.body).toEqual({ count: 3, version: V });
  });

  it("the count stays {count} for a service without versions", async () => {
    const res = await request(app).get(LIST).set("Authorization", auth());
    expect(res.body).toEqual({ count: 3 });
  });

  it("a photo request passes ?v= to the service", async () => {
    const res = await request(app).get(`${LIST}/1?v=${V}`).set("Authorization", auth());
    expect(res.status).toBe(200);
    expect(fetchStudentEnrollmentPhoto).toHaveBeenCalledWith(5, 1, V);
  });

  it("a stale set is a 409 so the client lists again", async () => {
    fetchStudentEnrollmentPhoto.mockRejectedValue(new RecognitionStaleError("changed"));
    const res = await request(app).get(`${LIST}/1?v=${V}`).set("Authorization", auth());
    expect(res.status).toBe(409);
  });

  it.each(["abc", "../../x", "0123456789ABCDEF", `${V}${V}`])("rejects the malformed version %s with a 400", async (bad) => {
    const res = await request(app).get(`${LIST}/1?v=${encodeURIComponent(bad)}`).set("Authorization", auth());
    expect(res.status).toBe(400);
    expect(fetchStudentEnrollmentPhoto).not.toHaveBeenCalled();
  });

  it("still enforces ownership before anything is asked of the service", async () => {
    prisma.student.findUnique.mockResolvedValue({ id: 5, teacherId: 77 });
    const res = await request(app).get(`${LIST}/1?v=${V}`).set("Authorization", auth("Teacher", 9));
    expect(res.status).toBe(403);
    expect(fetchStudentEnrollmentPhoto).not.toHaveBeenCalled();
  });
});
