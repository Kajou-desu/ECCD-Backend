import { describe, it, expect, afterEach, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { storageKeyFrom, removeStoredFiles, removeUploadedFiles } from "../src/lib/fileStorage.js";
import { setStorageForTests } from "../src/storage/index.js";
import { createLocalStorage } from "../src/storage/localDriver.js";

describe("storageKeyFrom", () => {
  it("accepts a bare generated filename", () => {
    expect(storageKeyFrom("1758400000000-9f2c4a7e1b3d5c60.jpg")).toBe("1758400000000-9f2c4a7e1b3d5c60.jpg");
  });

  it("extracts the key from a full stored URL, with or without a signature query", () => {
    expect(storageKeyFrom("https://api.example.com/api/files/abc.png")).toBe("abc.png");
    expect(storageKeyFrom("https://api.example.com/api/files/abc.png?exp=1&sig=z")).toBe("abc.png");
  });

  it("reduces any path to its final segment, so a key can never address a directory", () => {
    expect(storageKeyFrom("../../etc/passwd")).toBe("passwd");
    expect(storageKeyFrom("a/b/c.png")).toBe("c.png");
    expect(storageKeyFrom("/abs/path/x.png")).toBe("x.png");
  });

  it("rejects dot names, hidden files, odd characters and non-strings", () => {
    for (const bad of ["..", ".", ".env", "a b.png", "a;rm.png", "é.png", "", null, undefined, 42, {}]) {
      expect(storageKeyFrom(bad)).toBeNull();
    }
    expect(storageKeyFrom("x".repeat(300) + ".png")).toBeNull();
  });
});

describe("removing stored objects", () => {
  let dir;
  let storage;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "eccd-storage-test-"));
    storage = createLocalStorage(dir);
    setStorageForTests(storage);
  });
  afterEach(() => {
    setStorageForTests(undefined);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const seed = (name) => fs.writeFileSync(path.join(dir, name), "x");
  const exists = (name) => fs.existsSync(path.join(dir, name));

  it("removeStoredFiles deletes by key, accepting URLs, arrays, and junk values", async () => {
    seed("a.png");
    seed("b.pdf");

    await removeStoredFiles("http://h/api/files/a.png", ["b.pdf", null, undefined]);

    expect(exists("a.png")).toBe(false);
    expect(exists("b.pdf")).toBe(false);
  });

  it("does not throw for objects that are already gone", async () => {
    await expect(removeStoredFiles("nope.png", null)).resolves.toBeUndefined();
  });

  it("never touches anything but the storage directory", async () => {
    const outside = path.join(path.dirname(dir), "eccd-outside-marker.txt");
    fs.writeFileSync(outside, "keep me");
    try {
      await removeStoredFiles("../eccd-outside-marker.txt");
      expect(fs.existsSync(outside)).toBe(true);
    } finally {
      fs.rmSync(outside, { force: true });
    }
  });

  it("does not throw when the storage backend itself fails (the DB change already succeeded)", async () => {
    setStorageForTests({ remove: async () => { throw new Error("bucket unreachable"); } });
    await expect(removeStoredFiles("a.png")).resolves.toBeUndefined();
  });

  it("removeUploadedFiles removes temp files, and stored objects only for files that were stored", async () => {
    const tmpFile = path.join(dir, "tmp-upload.bin");
    fs.writeFileSync(tmpFile, "t");
    seed("stored.png");
    seed("unrelated.png"); // same directory here, but not part of this request

    await removeUploadedFiles({
      files: [
        { path: tmpFile, filename: "never-stored.png" }, // still only a temp file
        { path: path.join(dir, "gone.tmp"), filename: "stored.png", stored: true },
      ],
    });

    expect(fs.existsSync(tmpFile)).toBe(false);
    expect(exists("stored.png")).toBe(false);
    expect(exists("unrelated.png")).toBe(true);
  });

  it("removeUploadedFiles is a no-op when the request has no uploads", async () => {
    await expect(removeUploadedFiles({})).resolves.toBeUndefined();
  });
});
