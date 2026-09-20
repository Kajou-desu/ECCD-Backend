import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";

process.env.JWT_SECRET = "test-secret-at-least-32-characters-long";
process.env.CLIENT_ORIGIN = "http://localhost:5173";

vi.mock("../src/lib/prisma.js", () => ({
  prisma: { $queryRaw: vi.fn(), user: { findUnique: vi.fn() }, student: { findMany: vi.fn() } },
}));
vi.mock("../src/lib/activeSession.js", () => ({ findActiveSession: vi.fn() }));
vi.mock("../src/services/attendanceVerification.service.js", () => ({ recordSignal: vi.fn() }));
vi.mock("../src/services/recognitionClient.js", () => ({
  isRecognitionConfigured: vi.fn(() => true),
  recognizeFrame: vi.fn(),
}));

const { prisma } = await import("../src/lib/prisma.js");
const { findActiveSession } = await import("../src/lib/activeSession.js");
const { recognizeFrame } = await import("../src/services/recognitionClient.js");
const { signToken } = await import("../src/utils/jwt.js");
const { app } = await import("../src/app.js");

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64)]);
const URL = "/api/attendance/session/frame";

function auth(role = "Teacher") {
  const user = { id: 9, email: "t@school.test", role, isActive: true, tokenVersion: 0 };
  prisma.user.findUnique.mockResolvedValue(user);
  return `Bearer ${signToken(user)}`;
}

beforeEach(() => {
  vi.clearAllMocks();
  findActiveSession.mockResolvedValue({ id: 3, date: new Date() });
  recognizeFrame.mockResolvedValue({ width: 640, height: 480, faces: [] });
});

describe("POST /attendance/session/frame", () => {
  it("401 without a token; 403 for a Parent; neither reaches recognition", async () => {
    const anon = await request(app).post(URL).attach("frame", JPEG, { filename: "f.jpg", contentType: "image/jpeg" });
    expect(anon.status).toBe(401);
    const parent = await request(app).post(URL).set("Authorization", auth("Parent"))
      .attach("frame", JPEG, { filename: "f.jpg", contentType: "image/jpeg" });
    expect(parent.status).toBe(403);
    expect(recognizeFrame).not.toHaveBeenCalled();
  });

  it("accepts a real JPEG upload from a teacher (also under /api/v1)", async () => {
    for (const prefix of ["/api", "/api/v1"]) {
      const res = await request(app).post(`${prefix}/attendance/session/frame`).set("Authorization", auth())
        .attach("frame", JPEG, { filename: "f.jpg", contentType: "image/jpeg" });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ width: 640, height: 480, faces: [], verified: [] });
    }
    expect(recognizeFrame.mock.calls[0][0].equals(JPEG)).toBe(true); // exact bytes forwarded
  });

  it("rejects an oversized frame (>200 KB) before any recognition", async () => {
    const big = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(210 * 1024)]);
    const res = await request(app).post(URL).set("Authorization", auth())
      .attach("frame", big, { filename: "f.jpg", contentType: "image/jpeg" });
    expect(res.status).toBe(400);
    expect(recognizeFrame).not.toHaveBeenCalled();
  });

  it("rejects a non-JPEG declared type, and HTML disguised as image/jpeg", async () => {
    const png = await request(app).post(URL).set("Authorization", auth())
      .attach("frame", Buffer.from([0x89, 0x50, 0x4e, 0x47]), { filename: "f.png", contentType: "image/png" });
    expect(png.status).toBe(400);
    const fake = await request(app).post(URL).set("Authorization", auth())
      .attach("frame", Buffer.from("<html><script>alert(1)</script></html>"), { filename: "f.jpg", contentType: "image/jpeg" });
    expect(fake.status).toBe(400);
    expect(recognizeFrame).not.toHaveBeenCalled();
  });

  it("rejects extra form fields and a second file", async () => {
    const withField = await request(app).post(URL).set("Authorization", auth())
      .field("studentId", "5").attach("frame", JPEG, { filename: "f.jpg", contentType: "image/jpeg" });
    expect(withField.status).toBe(400);
    const twoFiles = await request(app).post(URL).set("Authorization", auth())
      .attach("frame", JPEG, { filename: "a.jpg", contentType: "image/jpeg" })
      .attach("frame", JPEG, { filename: "b.jpg", contentType: "image/jpeg" });
    expect(twoFiles.status).toBe(400);
  });

  it("streaming at ~1.4 frames/s is not throttled by the general API limit", async () => {
    const a = auth();
    let last;
    for (let i = 0; i < 320; i += 1) {
      last = await request(app).post(URL).set("Authorization", a)
        .attach("frame", JPEG, { filename: "f.jpg", contentType: "image/jpeg" });
    }
    expect(last.status).toBe(200);
  }, 60_000);
});
