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

  it("lets only the configured frontend origin frame the file (PDF preview), other routes stay locked", async () => {
    const file = await request(app).get(urlFor(KEY));
    expect(file.headers["x-frame-options"]).toBeUndefined();
    expect(file.headers["content-security-policy"]).toBe("frame-ancestors http://localhost:5173");

    const health = await request(app).get("/health");
    expect(health.headers["x-frame-options"]).toBe("SAMEORIGIN");
  });

  it("previews inline with a safe filename and sends no Referer", async () => {
    const res = await request(app).get(urlFor(KEY));
    expect(res.headers["content-disposition"]).toBe(`inline; filename="${KEY}"`);
    expect(res.headers["referrer-policy"]).toBe("no-referrer");
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

// ---------------------------------------------------------------------------
// M36 thumbnails and M38 document links, against both storage providers.
// ---------------------------------------------------------------------------
const sharp = (await import("sharp")).default;
const { thumbnailKeyFor } = await import("../src/lib/fileStorage.js");
const { signFileUrl: signUrl, DOCUMENT_URL_TTL_MS } = await import("../src/lib/signedFileUrl.js");

const PHOTO_KEY = "1758400000000-aaaa0000bbbb1111.png";
const DOC_KEY = "1758400000000-dddd0000eeee1111.pdf";
const BAD_IMAGE_KEY = "1758400000000-cccc0000dddd1111.jpg";

const binary = (res, cb) => {
  const chunks = [];
  res.on("data", (c) => chunks.push(c));
  res.on("end", () => cb(null, Buffer.concat(chunks)));
};
const get = (url) => request(app).get(url).buffer(true).parse(binary);

async function putBytes(harness, key, bytes, type) {
  const scratch = path.join(os.tmpdir(), `eccd-thumb-test-${process.pid}-${key}`);
  fs.writeFileSync(scratch, bytes);
  await harness.storage.put(key, scratch, type);
  fs.rmSync(scratch, { force: true });
}

describe.each(["local", "s3"])("thumbnails and document links (%s storage)", (kind) => {
  let harness;
  let original;

  beforeAll(async () => {
    harness = await createHarness(kind);
    setStorageForTests(harness.storage);
    // A real 1600x1200 photo with some detail so it doesn't compress to nothing.
    original = await sharp({
      create: { width: 1600, height: 1200, channels: 3, background: { r: 200, g: 120, b: 60 } },
    })
      .composite([{ input: Buffer.from("<svg width='1600' height='1200'><circle cx='800' cy='600' r='400' fill='navy'/></svg>") }])
      .png()
      .toBuffer();
    await putBytes(harness, PHOTO_KEY, original, "image/png");
    await putBytes(harness, DOC_KEY, CONTENT, "application/pdf");
    await putBytes(harness, BAD_IMAGE_KEY, Buffer.from("this is not an image"), "image/jpeg");
  });
  afterAll(async () => {
    setStorageForTests(undefined);
    await harness.close();
  });

  describe("thumbnails (M36)", () => {
    it("serves a small JPEG for ?v=thumb, much lighter than the original", async () => {
      const res = await get(`${urlFor(PHOTO_KEY)}&v=thumb`);
      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toMatch(/^image\/jpeg/);
      const meta = await sharp(res.body).metadata();
      expect(meta.width).toBe(480);
      expect(meta.height).toBe(360);
      expect(res.body.length).toBeLessThan(original.length / 3);
    });

    it("stores the thumbnail so the next request doesn't resize again", async () => {
      await get(`${urlFor(PHOTO_KEY)}&v=thumb`);
      expect(harness.keys()).toContain(thumbnailKeyFor(PHOTO_KEY));

      const stored = harness.read(thumbnailKeyFor(PHOTO_KEY));
      const again = await get(`${urlFor(PHOTO_KEY)}&v=thumb`);
      expect(again.body.equals(Buffer.from(stored))).toBe(true);
    });

    it("keeps serving the full image when ?v=thumb is absent", async () => {
      const res = await get(urlFor(PHOTO_KEY));
      expect(res.body.equals(original)).toBe(true);
    });

    it("still needs a valid signature — a thumbnail is not a way around it", async () => {
      const res = await request(app).get(`/api/files/${PHOTO_KEY}?v=thumb`);
      expect(res.status).toBe(404);
    });

    it("falls back to the original when the image can't be decoded", async () => {
      const res = await get(`${urlFor(BAD_IMAGE_KEY)}&v=thumb`);
      expect(res.status).toBe(200);
      expect(res.body.toString()).toBe("this is not an image");
    });

    it("deleting a photo deletes its thumbnail too (a copy of the same child's picture)", async () => {
      const key = "1758400000000-9999999988888888.png";
      await putBytes(harness, key, original, "image/png");
      await get(`${urlFor(key)}&v=thumb`);
      expect(harness.keys()).toContain(thumbnailKeyFor(key));

      const { removeStoredFiles } = await import("../src/lib/fileStorage.js");
      await removeStoredFiles(key);

      expect(harness.keys()).not.toContain(key);
      expect(harness.keys()).not.toContain(thumbnailKeyFor(key));
    });

    it("ignores ?v=thumb for a non-image", async () => {
      const res = await get(`${urlFor(DOC_KEY)}&v=thumb`);
      expect(res.status).toBe(200);
      expect(res.body.equals(CONTENT)).toBe(true);
    });
  });

  describe("document links (M38)", () => {
    const docUrl = (key = DOC_KEY) => {
      const { pathname, search } = new URL(
        signUrl(mockReq(), key, DOCUMENT_URL_TTL_MS, { sensitive: true }),
      );
      return `${pathname}${search}`;
    };

    it("serves a document link, with no caching at all", async () => {
      const res = await get(docUrl());
      expect(res.status).toBe(200);
      expect(res.body.equals(CONTENT)).toBe(true);
      expect(res.headers["cache-control"]).toBe("private, no-store");
    });

    it("keeps ordinary files cacheable for 5 minutes", async () => {
      const res = await get(urlFor(PHOTO_KEY));
      expect(res.headers["cache-control"]).toBe("private, max-age=300");
    });

    it("can't be downgraded: removing s=1 breaks the signature", async () => {
      const res = await request(app).get(docUrl().replace("&s=1", ""));
      expect(res.status).toBe(404);
    });

    it("can't be upgraded either: adding s=1 to an ordinary link breaks the signature", async () => {
      const res = await request(app).get(`${urlFor(DOC_KEY)}&s=1`);
      expect(res.status).toBe(404);
    });

    it("stops working once its 5 minutes are up", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        const url = docUrl();
        vi.setSystemTime(Date.now() + DOCUMENT_URL_TTL_MS + 1000);
        const res = await request(app).get(url);
        expect(res.status).toBe(404);
      } finally {
        vi.useRealTimers();
      }
    });

    it("ignores ?v=thumb on a document link — documents are always served whole", async () => {
      const res = await get(`${docUrl(PHOTO_KEY)}&v=thumb`);
      expect(res.body.equals(original)).toBe(true);
    });
  });
});
