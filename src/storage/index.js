import path from "node:path";
import { env } from "../config/env.js";
import { createLocalStorage } from "./localDriver.js";
import { createS3Storage } from "./s3Driver.js";

// Where the local driver keeps files (and where pre-bucket uploads already
// live), relative to the process working directory.
export const UPLOAD_DIR = path.resolve("uploads");

// The storage contract every driver implements. Nothing outside src/storage
// knows which one is active, which is what makes providers swappable:
//
//   put(key, filePath, contentType) -> void
//   get(key)    -> { body: Readable, contentLength } | null   (null = no such object)
//   head(key)   -> { size } | null
//   remove(key) -> void                                        (idempotent)
//
// Keys are the generated filenames (e.g. "1758400000000-9f2c4a7e1b3d5c60.jpg")
// — the same value the database already embeds in every stored file URL, so
// changing providers never requires touching database rows.
let instance;

function createConfiguredStorage() {
  if (env.storage.driver === "s3") return createS3Storage(env.storage.s3);
  return createLocalStorage(UPLOAD_DIR);
}

export function getStorage() {
  instance ??= createConfiguredStorage();
  return instance;
}

// Test seam: lets a test inject a driver (or reset to the configured one).
export function setStorageForTests(storage) {
  instance = storage;
}
