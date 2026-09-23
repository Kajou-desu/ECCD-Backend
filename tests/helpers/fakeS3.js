import http from "node:http";

// A minimal S3 server (path-style: /<bucket>/<key>) so the S3 driver can be
// tested through the REAL AWS SDK — request signing, endpoint handling and
// path-style addressing included — without network access or credentials.
// It also records every request so tests can assert on what the SDK sent.
export async function startFakeS3({ bucket = "test-bucket" } = {}) {
  const objects = new Map();
  const requests = [];

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const url = new URL(req.url, "http://fake");
      const [, requestedBucket, ...rest] = url.pathname.split("/");
      const key = decodeURIComponent(rest.join("/"));
      requests.push({ method: req.method, path: url.pathname, headers: req.headers });

      const xml = (status, code) => {
        res.writeHead(status, { "content-type": "application/xml" });
        res.end(`<?xml version="1.0"?><Error><Code>${code}</Code></Error>`);
      };

      if (!String(req.headers.authorization || "").startsWith("AWS4-HMAC-SHA256")) {
        return xml(403, "AccessDenied");
      }
      if (requestedBucket !== bucket) {
        // Like real S3: a HEAD response never has a body, so a missing bucket
        // looks identical to a missing key there.
        if (req.method === "HEAD") {
          res.writeHead(404);
          return res.end();
        }
        return xml(404, "NoSuchBucket");
      }

      if (req.method === "PUT") {
        objects.set(key, {
          body: Buffer.concat(chunks),
          contentType: req.headers["content-type"],
        });
        res.writeHead(200, { etag: '"fake"' });
        return res.end();
      }

      const object = objects.get(key);

      if (req.method === "GET" || req.method === "HEAD") {
        if (!object) {
          if (req.method === "HEAD") {
            res.writeHead(404);
            return res.end();
          }
          return xml(404, "NoSuchKey");
        }
        res.writeHead(200, {
          "content-type": object.contentType || "application/octet-stream",
          "content-length": object.body.length,
        });
        return res.end(req.method === "GET" ? object.body : undefined);
      }

      if (req.method === "DELETE") {
        objects.delete(key);
        res.writeHead(204);
        return res.end();
      }

      return xml(405, "MethodNotAllowed");
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  return {
    bucket,
    endpoint: `http://127.0.0.1:${port}`,
    objects,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

// The SDK's default credential chain reads these, exactly as it reads the
// ones Neon (or a CI job) injects. Fake values: the fake server only checks
// that a SigV4 Authorization header is present.
export function useFakeAwsCredentials() {
  process.env.AWS_ACCESS_KEY_ID = "test-access-key";
  process.env.AWS_SECRET_ACCESS_KEY = "test-secret-key";
}
