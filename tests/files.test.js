import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import request from "supertest";
import { signFileUrl } from "../src/lib/signedFileUrl.js";

process.env.JWT_SECRET = "test-secret-at-least-32-characters-long";
process.env.CLIENT_ORIGIN = "http://localhost:5173";

// app.js transitively imports every controller (via routes/index.js),
// including ones that import the shared Prisma client — mock it so
// importing app.js doesn't require a live database connection here.
vi.mock("../src/lib/prisma.js", () => ({
  prisma: { $queryRaw: vi.fn().mockResolvedValue([1]) },
}));

const UPLOAD_DIR = path.resolve("uploads");
const TEST_FILENAME = "vitest-fixture-abc123.txt";
const TEST_PATH = path.join(UPLOAD_DIR, TEST_FILENAME);

beforeAll(() => {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  fs.writeFileSync(TEST_PATH, "test file contents");
});

afterAll(() => {
  fs.rmSync(TEST_PATH, { force: true });
});

const { app } = await import("../src/app.js");

function mockReq() {
  return { protocol: "http", get: () => "localhost:4000" };
}

describe("GET /api/files/:filename", () => {
  it("serves the file with a valid, freshly-issued signature", async () => {
    const signedUrl = signFileUrl(mockReq(), TEST_FILENAME);
    const { pathname, search } = new URL(signedUrl);
    const res = await request(app).get(`${pathname}${search}`);

    expect(res.status).toBe(200);
    expect(res.text).toBe("test file contents");
  });

  it("rejects a request with no signature at all", async () => {
    const res = await request(app).get(`/api/files/${TEST_FILENAME}`);
    expect(res.status).toBe(404);
  });

  it("rejects an expired signature", async () => {
    const signedUrl = signFileUrl(mockReq(), TEST_FILENAME, -1000);
    const { pathname, search } = new URL(signedUrl);
    const res = await request(app).get(`${pathname}${search}`);
    expect(res.status).toBe(404);
  });

  it("rejects a signature copied onto a different filename", async () => {
    const signedUrl = signFileUrl(mockReq(), TEST_FILENAME);
    const { search } = new URL(signedUrl);
    const res = await request(app).get(`/api/files/some-other-file.txt${search}`);
    expect(res.status).toBe(404);
  });

  it("404s for a path-traversal attempt even with a valid-looking signature", async () => {
    const signedUrl = signFileUrl(mockReq(), "../../../etc/passwd");
    const { pathname, search } = new URL(signedUrl);
    const res = await request(app).get(`${pathname}${search}`);
    expect(res.status).toBe(404);
  });
});
