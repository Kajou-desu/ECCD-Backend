import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createLocalStorage } from "../src/storage/localDriver.js";

let dir;
let src;
let storage;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "eccd-local-driver-"));
  src = path.join(dir, "..", `eccd-src-${process.pid}.bin`);
  fs.writeFileSync(src, "hello world");
  storage = createLocalStorage(path.join(dir, "objects"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(src, { force: true });
});

const readAll = async (stream) => {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks).toString();
};

describe("local storage driver", () => {
  it("round-trips an object and creates its directory on first use", async () => {
    await storage.put("a.pdf", src, "application/pdf");

    expect(await storage.head("a.pdf")).toEqual({ size: 11 });
    const object = await storage.get("a.pdf");
    expect(object.contentLength).toBe(11);
    expect(await readAll(object.body)).toBe("hello world");
  });

  it("returns null for missing objects", async () => {
    expect(await storage.get("nope.pdf")).toBeNull();
    expect(await storage.head("nope.pdf")).toBeNull();
  });

  it("remove is idempotent", async () => {
    await storage.put("a.pdf", src);
    await storage.remove("a.pdf");
    await expect(storage.remove("a.pdf")).resolves.toBeUndefined();
    expect(await storage.head("a.pdf")).toBeNull();
  });

  it("cannot read, write or delete outside its directory, even given a hostile key", async () => {
    const outside = path.join(dir, "secret.txt");
    fs.writeFileSync(outside, "top secret");

    expect(await storage.get("../secret.txt")).toBeNull();
    expect(await storage.head("../secret.txt")).toBeNull();
    await expect(storage.put("../escaped.txt", src)).rejects.toThrow();
    await storage.remove("../secret.txt");

    expect(fs.readFileSync(outside, "utf8")).toBe("top secret");
    expect(fs.existsSync(path.join(dir, "escaped.txt"))).toBe(false);
  });
});
