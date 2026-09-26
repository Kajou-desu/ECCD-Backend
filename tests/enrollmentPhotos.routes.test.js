import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";

process.env.JWT_SECRET = "test-secret-at-least-32-characters-long";
process.env.CLIENT_ORIGIN = "http://localhost:5173";

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    $queryRaw: vi.fn(),
    user: { findUnique: vi.fn() },
    student: { findUnique: vi.fn() },
  },
}));
vi.mock("../src/services/recognitionClient.js", () => ({
  isRecognitionConfigured: vi.fn(() => true),
  enrollStudentPhotos: vi.fn(),
}));

const { prisma } = await import("../src/lib/prisma.js");
const { enrollStudentPhotos } = await import("../src/services/recognitionClient.js");
const { signToken } = await import("../src/utils/jwt.js");
const { app } = await import("../src/app.js");

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
const URL = "/api/students/5/enrollment-photos";

function auth(role = "Teacher") {
  const user = { id: 9, email: "t@school.test", role, isActive: true, tokenVersion: 0 };
  prisma.user.findUnique.mockResolvedValue(user);
  return `Bearer ${signToken(user)}`;
}

beforeEach(() => {
  vi.clearAllMocks();
  prisma.student.findUnique.mockResolvedValue({ id: 5 });
  enrollStudentPhotos.mockResolvedValue({ studentId: 5, photosReceived: 1, enrolled: true });
});

describe("POST /students/:id/enrollment-photos", () => {
  it("401 without a token; 403 for a Parent; neither reaches the recognition service", async () => {
    const anon = await request(app).post(URL).attach("photos", JPEG, { filename: "a.jpg", contentType: "image/jpeg" });
    expect(anon.status).toBe(401);
    const parent = await request(app).post(URL).set("Authorization", auth("Parent"))
      .attach("photos", JPEG, { filename: "a.jpg", contentType: "image/jpeg" });
    expect(parent.status).toBe(403);
    expect(enrollStudentPhotos).not.toHaveBeenCalled();
  });

  it("accepts an upload from a Teacher (also under /api/v1)", async () => {
    for (const prefix of ["/api", "/api/v1"]) {
      const res = await request(app).post(`${prefix}/students/5/enrollment-photos`).set("Authorization", auth())
        .attach("photos", JPEG, { filename: "a.jpg", contentType: "image/jpeg" });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ studentId: 5, photosReceived: 1, enrolled: true });
    }
  });

  it("accepts an Admin too", async () => {
    const res = await request(app).post(URL).set("Authorization", auth("Admin"))
      .attach("photos", JPEG, { filename: "a.jpg", contentType: "image/jpeg" });
    expect(res.status).toBe(200);
  });

  it("404 when the student doesn't exist", async () => {
    prisma.student.findUnique.mockResolvedValue(null);
    const res = await request(app).post(URL).set("Authorization", auth())
      .attach("photos", JPEG, { filename: "a.jpg", contentType: "image/jpeg" });
    expect(res.status).toBe(404);
    expect(enrollStudentPhotos).not.toHaveBeenCalled();
  });

  it("accepts up to 8 photos and forwards exact bytes", async () => {
    let req = request(app).post(URL).set("Authorization", auth());
    for (let i = 0; i < 8; i += 1) {
      req = req.attach("photos", JPEG, { filename: `p${i}.jpg`, contentType: "image/jpeg" });
    }
    const res = await req;
    expect(res.status).toBe(200);
    expect(enrollStudentPhotos.mock.calls[0][1]).toHaveLength(8);
    expect(enrollStudentPhotos.mock.calls[0][1][0].buffer.equals(JPEG)).toBe(true);
  });

  it("rejects a 9th photo (multer's file-count limit -> 400, service never called)", async () => {
    let req = request(app).post(URL).set("Authorization", auth());
    for (let i = 0; i < 9; i += 1) {
      req = req.attach("photos", JPEG, { filename: `p${i}.jpg`, contentType: "image/jpeg" });
    }
    const res = await req;
    expect(res.status).toBe(400);
    expect(enrollStudentPhotos).not.toHaveBeenCalled();
  });

  it("rejects a declared type outside JPEG/PNG at the multer layer", async () => {
    const res = await request(app).post(URL).set("Authorization", auth())
      .attach("photos", Buffer.from("%PDF-1.4"), { filename: "a.pdf", contentType: "application/pdf" });
    expect(res.status).toBe(400);
    expect(enrollStudentPhotos).not.toHaveBeenCalled();
  });

  it("rejects bytes that don't match the declared image/jpeg type (HTML disguised as a photo)", async () => {
    const res = await request(app).post(URL).set("Authorization", auth())
      .attach("photos", Buffer.from("<html><script>alert(1)</script></html>"), {
        filename: "a.jpg",
        contentType: "image/jpeg",
      });
    expect(res.status).toBe(400);
    expect(enrollStudentPhotos).not.toHaveBeenCalled();
  });

  it("rejects an oversized photo (>10MB)", async () => {
    const big = Buffer.concat([JPEG, Buffer.alloc(11 * 1024 * 1024)]);
    const res = await request(app).post(URL).set("Authorization", auth())
      .attach("photos", big, { filename: "a.jpg", contentType: "image/jpeg" });
    expect(res.status).toBe(400);
    expect(enrollStudentPhotos).not.toHaveBeenCalled();
  });

  it("400 when no photos are attached", async () => {
    const res = await request(app).post(URL).set("Authorization", auth()).field("note", "oops");
    expect(res.status).toBe(400);
    expect(enrollStudentPhotos).not.toHaveBeenCalled();
  });

  it("reports enrolled: false without erroring when the service found no usable face", async () => {
    enrollStudentPhotos.mockResolvedValue({ studentId: 5, photosReceived: 1, enrolled: false });
    const res = await request(app).post(URL).set("Authorization", auth())
      .attach("photos", JPEG, { filename: "a.jpg", contentType: "image/jpeg" });
    expect(res.status).toBe(200);
    expect(res.body.enrolled).toBe(false);
  });

  it("502 with a generic message when the recognition service is unreachable", async () => {
    enrollStudentPhotos.mockRejectedValue(new Error("connect ECONNREFUSED 10.1.2.3:8001"));
    const res = await request(app).post(URL).set("Authorization", auth())
      .attach("photos", JPEG, { filename: "a.jpg", contentType: "image/jpeg" });
    expect(res.status).toBe(502);
    expect(res.body).toEqual({ message: "Face recognition service unavailable" });
  });
});
