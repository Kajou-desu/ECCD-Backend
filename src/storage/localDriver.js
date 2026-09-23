import fs from "node:fs";
import path from "node:path";

// Stores objects as plain files in one directory. Used for local development,
// tests, and as the default until a bucket is configured. Not suitable for
// more than one server instance: each instance would only see its own files.
export function createLocalStorage(dir) {
  const root = path.resolve(dir);

  // Keys are validated before they get here (see storageKeyFrom); this is the
  // second, independent guard that the resolved path can't leave the directory.
  function pathFor(key) {
    const full = path.join(root, key);
    return full.startsWith(root + path.sep) ? full : null;
  }

  return {
    name: "local",
    dir: root,

    async put(key, filePath) {
      const target = pathFor(key);
      if (!target) throw new Error("Invalid storage key");
      await fs.promises.mkdir(root, { recursive: true });
      await fs.promises.copyFile(filePath, target);
    },

    async get(key) {
      const target = pathFor(key);
      if (!target) return null;
      try {
        const stats = await fs.promises.stat(target);
        if (!stats.isFile()) return null;
        return { body: fs.createReadStream(target), contentLength: stats.size };
      } catch (err) {
        if (err.code === "ENOENT") return null;
        throw err;
      }
    },

    async head(key) {
      const target = pathFor(key);
      if (!target) return null;
      try {
        const stats = await fs.promises.stat(target);
        return stats.isFile() ? { size: stats.size } : null;
      } catch (err) {
        if (err.code === "ENOENT") return null;
        throw err;
      }
    },

    async remove(key) {
      const target = pathFor(key);
      if (!target) return;
      try {
        await fs.promises.unlink(target);
      } catch (err) {
        if (err.code !== "ENOENT") throw err;
      }
    },
  };
}
