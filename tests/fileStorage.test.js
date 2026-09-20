import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { UPLOAD_DIR, resolveStoredPath, removeStoredFiles, removeUploadedFiles } from "../src/lib/fileStorage.js";

const made = [];
function makeFile(name) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  const full = path.join(UPLOAD_DIR, name);
  fs.writeFileSync(full, "x");
  made.push(full);
  return full;
}
afterEach(() => {
  while (made.length) fs.rmSync(made.pop(), { force: true });
});

describe("resolveStoredPath", () => {
  it("maps a bare filename into the uploads directory", () => {
    expect(resolveStoredPath("abc.png")).toBe(path.join(UPLOAD_DIR, "abc.png"));
  });

  it("maps a full stored URL (with or without a signature query) to its file", () => {
    expect(resolveStoredPath("https://api.example.com/api/files/abc.png")).toBe(
      path.join(UPLOAD_DIR, "abc.png")
    );
    expect(resolveStoredPath("https://api.example.com/api/files/abc.png?exp=1&sig=z")).toBe(
      path.join(UPLOAD_DIR, "abc.png")
    );
  });

  it("can never resolve outside the uploads directory", () => {
    for (const evil of ["../../etc/passwd", "/etc/passwd", "..", ".", "a/../../../etc/passwd"]) {
      const resolved = resolveStoredPath(evil);
      expect(resolved === null || resolved.startsWith(UPLOAD_DIR + path.sep)).toBe(true);
    }
    expect(resolveStoredPath("..")).toBeNull();
  });

  it("returns null for empty / non-string values", () => {
    for (const v of [null, undefined, "", 42, {}]) expect(resolveStoredPath(v)).toBeNull();
  });
});

describe("removeStoredFiles", () => {
  it("deletes the file, accepting a mix of values and nested arrays", async () => {
    const a = makeFile("vitest-rm-a.png");
    const b = makeFile("vitest-rm-b.pdf");

    await removeStoredFiles("http://h/api/files/vitest-rm-a.png", ["vitest-rm-b.pdf", null]);

    expect(fs.existsSync(a)).toBe(false);
    expect(fs.existsSync(b)).toBe(false);
  });

  it("does not throw for a file that's already gone or a null value", async () => {
    await expect(removeStoredFiles("does-not-exist.png", null, undefined)).resolves.toBeUndefined();
  });

  it("does not delete anything outside the uploads directory", async () => {
    const outside = path.resolve("vitest-outside-marker.txt");
    fs.writeFileSync(outside, "keep me");
    made.push(outside);

    await removeStoredFiles("../vitest-outside-marker.txt");

    expect(fs.existsSync(outside)).toBe(true); // basename maps it into uploads/, where it doesn't exist
  });
});

describe("removeUploadedFiles", () => {
  it("removes req.file and req.files by their on-disk path", async () => {
    const one = makeFile("vitest-up-1.png");
    const two = makeFile("vitest-up-2.png");

    await removeUploadedFiles({ file: { path: one }, files: [{ path: two }] });

    expect(fs.existsSync(one)).toBe(false);
    expect(fs.existsSync(two)).toBe(false);
  });

  it("is a no-op when the request has no uploads", async () => {
    await expect(removeUploadedFiles({})).resolves.toBeUndefined();
  });
});
