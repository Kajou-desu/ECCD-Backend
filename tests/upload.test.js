import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";

// Give this test file its own temp directory BEFORE the app modules load (they
// read os.tmpdir() at import), so "no temp files left behind" can be asserted
// exactly, even while other test files run in parallel.
const isolatedTmp = fs.mkdtempSync(path.join(os.tmpdir(), "eccd-upload-test-"));
process.env.TMPDIR = isolatedTmp;

const { upload, fileMatchesDeclaredType } = await import("../src/middleware/upload.js");
const { errorHandler } = await import("../src/middleware/errorHandler.js");
const { UPLOAD_TMP_DIR } = await import("../src/lib/fileStorage.js");
const { setStorageForTests } = await import("../src/storage/index.js");
const { createHarness } = await import("./helpers/storageHarness.js");

// Smallest real-looking headers for each type — enough for signature checks.
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32)]);
const PDF = Buffer.from("%PDF-1.4\n%fake but correctly-headed\n");
const HTML = Buffer.from("<html><script>alert(document.cookie)</script></html>");

const tmpLeftovers = () => fs.readdirSync(UPLOAD_TMP_DIR);
const settle = (ms = 80) => new Promise((resolve) => setTimeout(resolve, ms)); // 'finish' precedes async cleanup

afterAll(() => fs.rmSync(isolatedTmp, { recursive: true, force: true }));

function buildApp() {
  const app = express();
  app.use((req, _res, next) => {
    req.user = { id: 1, role: "Parent" }; // stands in for requireAuth
    next();
  });
  app.post("/single", upload.single("file"), (req, res) => res.status(201).json({ key: req.file.filename }));
  app.post("/photos", upload.array("photos", 3, { imagesOnly: true }), (req, res) =>
    res.status(201).json({ count: req.files.length })
  );
  // Simulates a controller that rejects AFTER the upload was accepted and
  // stored (e.g. the "not your child" ownership check on /api/submissions).
  app.post("/late-reject", upload.single("file"), (_req, res) => res.status(403).json({ message: "Forbidden" }));
  app.use(errorHandler);
  return app;
}

// Every behavior below must hold no matter which provider is configured.
describe.each(["local", "s3"])("upload pipeline (%s storage)", (kind) => {
  let harness;
  beforeAll(async () => {
    harness = await createHarness(kind);
    setStorageForTests(harness.storage);
  });
  afterAll(async () => {
    setStorageForTests(undefined);
    await harness.close();
  });
  beforeEach(() => harness.reset());

  it("stores a valid file under its generated key and leaves no temp file behind", async () => {
    const res = await request(buildApp())
      .post("/single")
      .attach("file", PNG, { filename: "photo.png", contentType: "image/png" });

    expect(res.status).toBe(201);
    expect(res.body.key).toMatch(/^\d+-[0-9a-f]{16}\.png$/);
    expect(harness.keys()).toEqual([res.body.key]);
    expect(harness.read(res.body.key).equals(PNG)).toBe(true);
    expect(tmpLeftovers()).toEqual([]);
  });

  it("rejects HTML disguised as an image — nothing is stored, nothing left in temp", async () => {
    const res = await request(buildApp())
      .post("/single")
      .attach("file", HTML, { filename: "evil.png", contentType: "image/png" });
    await settle();

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ message: "File content does not match its type" });
    expect(harness.keys()).toEqual([]);
    expect(tmpLeftovers()).toEqual([]);
  });

  it("rejects a PNG that claims to be a PDF", async () => {
    const res = await request(buildApp())
      .post("/single")
      .attach("file", PNG, { filename: "doc.pdf", contentType: "application/pdf" });
    expect(res.status).toBe(400);
    expect(harness.keys()).toEqual([]);
  });

  it("accepts a real PDF", async () => {
    const res = await request(buildApp())
      .post("/single")
      .attach("file", PDF, { filename: "doc.pdf", contentType: "application/pdf" });
    expect(res.status).toBe(201);
    expect(res.body.key).toMatch(/\.pdf$/);
  });

  it("rejects a type that isn't on the whitelist at all", async () => {
    const res = await request(buildApp())
      .post("/single")
      .attach("file", HTML, { filename: "page.html", contentType: "text/html" });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ message: "Unsupported file type" });
    expect(harness.keys()).toEqual([]);
  });

  it("image-only endpoints accept images", async () => {
    const res = await request(buildApp())
      .post("/photos")
      .attach("photos", PNG, { filename: "a.png", contentType: "image/png" })
      .attach("photos", JPEG, { filename: "b.jpg", contentType: "image/jpeg" });
    expect(res.status).toBe(201);
    expect(harness.keys()).toHaveLength(2);
  });

  it("image-only endpoints reject a genuine document", async () => {
    const res = await request(buildApp())
      .post("/photos")
      .attach("photos", PDF, { filename: "doc.pdf", contentType: "application/pdf" });
    expect(res.status).toBe(400);
    expect(harness.keys()).toEqual([]);
  });

  it("stores NOTHING from a batch if any file in it is rejected", async () => {
    const res = await request(buildApp())
      .post("/photos")
      .attach("photos", PNG, { filename: "ok.png", contentType: "image/png" })
      .attach("photos", HTML, { filename: "bad.png", contentType: "image/png" });
    await settle();

    expect(res.status).toBe(400);
    expect(harness.keys()).toEqual([]);
    expect(tmpLeftovers()).toEqual([]);
  });

  it("deletes the stored object when the request is rejected after the upload was stored", async () => {
    const res = await request(buildApp())
      .post("/late-reject")
      .attach("file", PNG, { filename: "photo.png", contentType: "image/png" });
    await settle();

    expect(res.status).toBe(403);
    expect(harness.keys()).toEqual([]);
    expect(tmpLeftovers()).toEqual([]);
  });

  it("answers with a generic 500 — and cleans up — when storage itself fails", async () => {
    setStorageForTests({
      ...harness.storage,
      put: async () => {
        throw new Error("bucket exploded: secret-internal-detail");
      },
    });
    try {
      const res = await request(buildApp())
        .post("/single")
        .attach("file", PNG, { filename: "photo.png", contentType: "image/png" });
      await settle();

      expect(res.status).toBe(500);
      expect(res.body).toEqual({ message: "Something went wrong" });
      expect(JSON.stringify(res.body)).not.toContain("secret-internal-detail");
      expect(tmpLeftovers()).toEqual([]);
    } finally {
      setStorageForTests(harness.storage);
    }
  });

  it("removes files already stored if a later file in the same request fails to store", async () => {
    let calls = 0;
    setStorageForTests({
      ...harness.storage,
      put: async (...args) => {
        calls += 1;
        if (calls === 2) throw new Error("second put failed");
        return harness.storage.put(...args);
      },
    });
    try {
      const res = await request(buildApp())
        .post("/photos")
        .attach("photos", PNG, { filename: "1.png", contentType: "image/png" })
        .attach("photos", JPEG, { filename: "2.jpg", contentType: "image/jpeg" });
      await settle();

      expect(res.status).toBe(500);
      expect(harness.keys()).toEqual([]); // the first one did not stay behind
      expect(tmpLeftovers()).toEqual([]);
    } finally {
      setStorageForTests(harness.storage);
    }
  });
});

describe("fileMatchesDeclaredType", () => {
  const scratch = path.join(isolatedTmp, "sig-check.bin");

  it("denies a MIME type it has no signature for (default deny)", async () => {
    fs.writeFileSync(scratch, PNG);
    expect(await fileMatchesDeclaredType(scratch, "text/html")).toBe(false);
    expect(await fileMatchesDeclaredType(scratch, "image/png")).toBe(true);
  });

  it("denies an empty file", async () => {
    fs.writeFileSync(scratch, "");
    expect(await fileMatchesDeclaredType(scratch, "image/png")).toBe(false);
  });
});
