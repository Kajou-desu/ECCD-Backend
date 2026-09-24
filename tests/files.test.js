import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { signFileUrl } from "../src/lib/signedFileUrl.js";
import { setStorageForTests } from "../src/storage/index.js";
import { createHarness } from "./helpers/storageHarness.js";

process.env.JWT_SECRET = "test-secret-at-least-32-characters-long";
process.env.CLIENT_ORIGIN = "http://localhost:5173";

// app.js transitively imports every controller (via routes/index.js),
// including ones that import the shared Prisma client — mock it so
// importing app.js doesn't require a live database connection here.
vi.mock("../src/lib/prisma.js", () => ({
  prisma: { $queryRaw: vi.fn().mockResolvedValue([1]) },
}));

const { app } = await import("../src/app.js");

const KEY = "1758400000000-0123456789abcdef.pdf";
const CONTENT = Buffer.from("%PDF-1.4 test file contents");

function mockReq() {
  return { protocol: "http", get: () => "localhost:4000" };
}
const urlFor = (key) => {
  const { pathname, search } = new URL(signFileUrl(mockReq(), key));
  return `${pathname}${search}`;
};

// The same serving behavior must hold whichever provider holds the bytes.
describe.each(["local", "s3"])("GET /api/files/:filename (%s storage)", (kind) => {
  let harness;
  beforeAll(async () => {
    harness = await createHarness(kind);
    setStorageForTests(harness.storage);

    const scratch = path.join(os.tmpdir(), `eccd-files-test-${process.pid}-${kind}.bin`);
    fs.writeFileSync(scratch, CONTENT);
    await harness.storage.put(KEY, scratch, "application/pdf");
    fs.rmSync(scratch, { force: true });
  });
  afterAll(async () => {
    setStorageForTests(undefined);
    await harness.close();
  });

  it("serves the file with a valid, freshly-issued signature", async () => {
    const res = await request(app).get(urlFor(KEY)).buffer(true).parse((r, cb) => {
      const chunks = [];
      r.on("data", (c) => chunks.push(c));
      r.on("end", () => cb(null, Buffer.concat(chunks)));
    });

    expect(res.status).toBe(200);
    expect(res.body.equals(CONTENT)).toBe(true);
    expect(res.headers["content-type"]).toMatch(/^application\/pdf/);
    expect(res.headers["content-length"]).toBe(String(CONTENT.length));
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("allows the cross-origin frontend to embed the file, while other routes stay same-origin", async () => {
    const file = await request(app).get(urlFor(KEY));
    expect(file.headers["cross-origin-resource-policy"]).toBe("cross-origin");

    const health = await request(app).get("/health");
    expect(health.headers["cross-origin-resource-policy"]).toBe("same-origin");
  });

  it("marks served files private so shared caches/CDNs don't store them", async () => {
    const res = await request(app).get(urlFor(KEY));
    expect(res.headers["cache-control"]).toMatch(/\bprivate\b/);
    expect(res.headers["cache-control"]).not.toMatch(/\bpublic\b/);
  });

  it("rejects a request with no signature", async () => {
    const res = await request(app).get(`/api/files/${KEY}`);
    expect(res.status).toBe(404);
  });

  it("rejects a tampered signature without ever asking storage for the object", async () => {
    let storageReads = 0;
    const real = harness.storage;
    setStorageForTests({ ...real, get: async (...a) => { storageReads += 1; return real.get(...a); } });
    try {
      const res = await request(app).get(urlFor(KEY).replace(/sig=(.)/, (_m, c) => `sig=${c === "0" ? "1" : "0"}`));
      expect(res.status).toBe(404);
      expect(storageReads).toBe(0);
    } finally {
      setStorageForTests(real);
    }
  });

  it("rejects a signature issued for a different file", async () => {
    const res = await request(app).get(urlFor("1758400000000-aaaaaaaaaaaaaaaa.pdf").replace(/^\/api\/files\/[^?]+/, `/api/files/${KEY}`));
    expect(res.status).toBe(404);
  });

  it("rejects an expired signature", async () => {
    const url = new URL(signFileUrl(mockReq(), KEY));
    url.searchParams.set("exp", String(Date.now() - 1000));
    const res = await request(app).get(`${url.pathname}${url.search}`);
    expect(res.status).toBe(404);
  });

  it("answers 404 (same as any other failure) for a validly-signed key that doesn't exist", async () => {
    const res = await request(app).get(urlFor("1758400000000-ffffffffffffffff.pdf"));
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ message: "Not found" });
  });

  it("cannot be used to reach anything outside the storage namespace", async () => {
    for (const evil of ["..%2F..%2Fetc%2Fpasswd", "%2e%2e%2fsecret.pdf", ".env"]) {
      const res = await request(app).get(`/api/files/${evil}?exp=${Date.now() + 60000}&sig=abc`);
      expect(res.status).toBe(404);
    }
  });

  it("returns a generic 500 (no internals) when the storage backend fails", async () => {
    const real = harness.storage;
    setStorageForTests({ ...real, get: async () => { throw new Error("secret-bucket-detail"); } });
    try {
      const res = await request(app).get(urlFor(KEY));
      expect(res.status).toBe(500);
      expect(JSON.stringify(res.body)).not.toContain("secret-bucket-detail");
    } finally {
      setStorageForTests(real);
    }
  });
});
