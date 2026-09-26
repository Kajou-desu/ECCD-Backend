import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/lib/prisma.js", () => ({ prisma: { student: { findUnique: vi.fn() } } }));
vi.mock("../src/services/recognitionClient.js", () => ({
  isRecognitionConfigured: vi.fn(),
  enrollStudentPhotos: vi.fn(),
}));

const { prisma } = await import("../src/lib/prisma.js");
const { isRecognitionConfigured, enrollStudentPhotos } = await import("../src/services/recognitionClient.js");
const { uploadEnrollmentPhotos } = await import("../src/controllers/enrollmentPhotos.controller.js");

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
const jpegFile = (over = {}) => ({ buffer: JPEG, mimetype: "image/jpeg", ...over });
const pngFile = (over = {}) => ({ buffer: PNG, mimetype: "image/png", ...over });

function mockRes() {
  const res = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res;
}
const run = async (over = {}) => {
  const res = mockRes();
  const next = vi.fn();
  await uploadEnrollmentPhotos({ params: { id: "5" }, files: [jpegFile()], ...over }, res, next);
  return { res, next, body: res.json.mock.calls[0]?.[0] };
};

beforeEach(() => {
  vi.clearAllMocks();
  isRecognitionConfigured.mockReturnValue(true);
  prisma.student.findUnique.mockResolvedValue({ id: 5 });
  enrollStudentPhotos.mockResolvedValue({ studentId: 5, photosReceived: 1, enrolled: true });
});

describe("uploadEnrollmentPhotos — gating", () => {
  it("503 when recognition isn't configured, without touching the DB or the service", async () => {
    isRecognitionConfigured.mockReturnValue(false);
    const { res } = await run();
    expect(res.status).toHaveBeenCalledWith(503);
    expect(prisma.student.findUnique).not.toHaveBeenCalled();
    expect(enrollStudentPhotos).not.toHaveBeenCalled();
  });

  it("invalid student id: AppError(400) via next(), before any lookup", async () => {
    // parseId throws synchronously, so this — unlike the other gating cases —
    // is routed to next(err), not res.status(); the routes-level test
    // confirms the errorHandler turns that into an HTTP 400.
    const { next } = await run({ params: { id: "not-a-number" } });
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 400 }));
    expect(prisma.student.findUnique).not.toHaveBeenCalled();
  });

  it("400 when no photos are attached", async () => {
    const { res } = await run({ files: [] });
    expect(res.status).toHaveBeenCalledWith(400);
    expect(enrollStudentPhotos).not.toHaveBeenCalled();
  });

  it("404 when the student doesn't exist, and the service is never called", async () => {
    prisma.student.findUnique.mockResolvedValue(null);
    const { res } = await run();
    expect(res.status).toHaveBeenCalledWith(404);
    expect(enrollStudentPhotos).not.toHaveBeenCalled();
  });

  it("502 with a generic message when the recognition service fails — no internals leak", async () => {
    enrollStudentPhotos.mockRejectedValue(new Error("connect ECONNREFUSED 10.1.2.3:8001 (key=abc)"));
    const { res, body } = await run();
    expect(res.status).toHaveBeenCalledWith(502);
    expect(body).toEqual({ message: "Face recognition service unavailable" });
    expect(JSON.stringify(body)).not.toMatch(/10\.1\.2\.3|ECONNREFUSED|abc/);
  });

  it("passes unexpected errors to next()", async () => {
    const err = new Error("db down");
    prisma.student.findUnique.mockRejectedValue(err);
    const { next } = await run();
    expect(next).toHaveBeenCalledWith(err);
  });
});

describe("uploadEnrollmentPhotos — signature check (never trusts the declared mimetype)", () => {
  it("accepts real JPEG and PNG bytes", async () => {
    const { res, body } = await run({ files: [jpegFile(), pngFile()] });
    expect(res.status).not.toHaveBeenCalledWith(400);
    expect(enrollStudentPhotos).toHaveBeenCalledWith(5, [jpegFile(), pngFile()]);
    expect(body).toEqual({ studentId: 5, photosReceived: 1, enrolled: true });
  });

  it("400 when a file's bytes don't match its declared image/jpeg type", async () => {
    const fake = jpegFile({ buffer: Buffer.from("<html><script>alert(1)</script></html>") });
    const { res } = await run({ files: [fake] });
    expect(res.status).toHaveBeenCalledWith(400);
    expect(enrollStudentPhotos).not.toHaveBeenCalled();
  });

  it("400 for a mimetype outside the JPEG/PNG whitelist, regardless of bytes", async () => {
    const { res } = await run({ files: [jpegFile({ mimetype: "application/pdf", buffer: JPEG })] });
    expect(res.status).toHaveBeenCalledWith(400);
    expect(enrollStudentPhotos).not.toHaveBeenCalled();
  });

  it("rejects the whole batch if any single photo fails the check", async () => {
    const fake = jpegFile({ buffer: Buffer.from("not an image") });
    const { res } = await run({ files: [jpegFile(), fake] });
    expect(res.status).toHaveBeenCalledWith(400);
    expect(enrollStudentPhotos).not.toHaveBeenCalled();
  });
});

describe("uploadEnrollmentPhotos — response", () => {
  it("reports enrolled: false as a normal response, not an error, when no photo had one clear face", async () => {
    enrollStudentPhotos.mockResolvedValue({ studentId: 5, photosReceived: 2, enrolled: false });
    const { res, body } = await run({ files: [jpegFile(), jpegFile()] });
    expect(res.status).not.toHaveBeenCalledWith(400);
    expect(body).toEqual({ studentId: 5, photosReceived: 2, enrolled: false });
  });
});
