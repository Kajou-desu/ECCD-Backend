import { describe, it, expect, beforeAll, afterAll } from "vitest";
import express from "express";
import fs from "node:fs";
import path from "node:path";
import request from "supertest";
import { upload, fileMatchesDeclaredType } from "../src/middleware/upload.js";
import { errorHandler } from "../src/middleware/errorHandler.js";
import { UPLOAD_DIR } from "../src/lib/fileStorage.js";

// Smallest real-looking headers for each type — enough for signature checks.
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32)]);
const PDF = Buffer.from("%PDF-1.4\n%fake but correctly-headed\n");
const HTML = Buffer.from("<html><script>alert(document.cookie)</script></html>");

let before;
beforeAll(() => {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  before = new Set(fs.readdirSync(UPLOAD_DIR));
});
afterAll(() => {
  for (const name of fs.readdirSync(UPLOAD_DIR)) {
    if (!before.has(name)) fs.rmSync(path.join(UPLOAD_DIR, name), { force: true });
  }
});
const newFiles = () => fs.readdirSync(UPLOAD_DIR).filter((name) => !before.has(name));

function buildApp() {
  const app = express();
  app.use((req, _res, next) => {
    req.user = { id: 1, role: "Parent" }; // stands in for requireAuth
    next();
  });
  app.post("/single", upload.single("file"), (req, res) => res.status(201).json({ name: req.file.filename }));
  app.post("/photos", upload.array("photos", 3, { imagesOnly: true }), (req, res) =>
    res.status(201).json({ count: req.files.length })
  );
  // Simulates a controller that rejects AFTER multer already stored the file
  // (e.g. the "not your child" ownership check on /api/submissions).
  app.post("/late-reject", upload.single("file"), (_req, res) => res.status(403).json({ message: "Forbidden" }));
  app.use(errorHandler);
  return app;
}

describe("upload content verification", () => {
  it("accepts a file whose bytes match its declared type", async () => {
    const res = await request(buildApp())
      .post("/single")
      .attach("file", PNG, { filename: "photo.png", contentType: "image/png" });

    expect(res.status).toBe(201);
    expect(res.body.name).toMatch(/\.png$/);
    expect(fs.existsSync(path.join(UPLOAD_DIR, res.body.name))).toBe(true);
  });

  it("rejects HTML disguised as an image, and leaves nothing on disk", async () => {
    const start = newFiles().length;
    const res = await request(buildApp())
      .post("/single")
      .attach("file", HTML, { filename: "evil.png", contentType: "image/png" });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ message: "File content does not match its type" });
    expect(newFiles().length).toBe(start);
  });

  it("rejects a PNG that claims to be a PDF", async () => {
    const res = await request(buildApp())
      .post("/single")
      .attach("file", PNG, { filename: "doc.pdf", contentType: "application/pdf" });
    expect(res.status).toBe(400);
  });

  it("accepts a real PDF", async () => {
    const res = await request(buildApp())
      .post("/single")
      .attach("file", PDF, { filename: "doc.pdf", contentType: "application/pdf" });
    expect(res.status).toBe(201);
  });

  it("still rejects a type that isn't on the whitelist at all", async () => {
    const res = await request(buildApp())
      .post("/single")
      .attach("file", HTML, { filename: "page.html", contentType: "text/html" });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ message: "Unsupported file type" });
  });
});

describe("image-only endpoints", () => {
  it("accept images", async () => {
    const res = await request(buildApp())
      .post("/photos")
      .attach("photos", PNG, { filename: "a.png", contentType: "image/png" })
      .attach("photos", JPEG, { filename: "b.jpg", contentType: "image/jpeg" });
    expect(res.status).toBe(201);
    expect(res.body.count).toBe(2);
  });

  it("reject a document, even a genuine one", async () => {
    const res = await request(buildApp())
      .post("/photos")
      .attach("photos", PDF, { filename: "doc.pdf", contentType: "application/pdf" });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ message: "Unsupported file type" });
  });

  it("discard the valid images too if any file in the batch is rejected", async () => {
    const start = newFiles().length;
    const res = await request(buildApp())
      .post("/photos")
      .attach("photos", PNG, { filename: "ok.png", contentType: "image/png" })
      .attach("photos", HTML, { filename: "bad.png", contentType: "image/png" });

    expect(res.status).toBe(400);
    expect(newFiles().length).toBe(start);
  });
});

describe("orphaned upload cleanup", () => {
  it("deletes the stored file when the request is rejected after upload", async () => {
    const start = newFiles().length;
    const res = await request(buildApp())
      .post("/late-reject")
      .attach("file", PNG, { filename: "photo.png", contentType: "image/png" });

    expect(res.status).toBe(403);
    // 'finish' fires just before the async unlink completes; give it a tick.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(newFiles().length).toBe(start);
  });
});

describe("fileMatchesDeclaredType", () => {
  it("denies a MIME type it has no signature for (default deny)", async () => {
    const file = path.join(UPLOAD_DIR, "vitest-sig-check.bin");
    fs.writeFileSync(file, PNG);
    try {
      expect(await fileMatchesDeclaredType(file, "text/html")).toBe(false);
      expect(await fileMatchesDeclaredType(file, "image/png")).toBe(true);
    } finally {
      fs.rmSync(file, { force: true });
    }
  });

  it("denies an empty file", async () => {
    const file = path.join(UPLOAD_DIR, "vitest-empty.bin");
    fs.writeFileSync(file, "");
    try {
      expect(await fileMatchesDeclaredType(file, "image/png")).toBe(false);
    } finally {
      fs.rmSync(file, { force: true });
    }
  });
});
