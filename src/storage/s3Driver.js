import fs from "node:fs";
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";

const OPERATION_TIMEOUT_MS = 30_000;

// The ONLY place that knows how Neon Object Storage and AWS S3 differ. Both
// speak the S3 protocol; the differences are configuration:
//
//                       Neon Object Storage              AWS S3
//   endpoint            https://br-….storage.….neon.tech  (unset — SDK derives it)
//   forcePathStyle      true                              false
//   credentials         static access key + secret        IAM role (or static keys)
//
// So switching providers means changing environment variables, not code.
export function buildS3ClientConfig({ region, endpoint, forcePathStyle }) {
  return {
    region,
    // Left out entirely for AWS so the SDK builds the regional endpoint itself.
    ...(endpoint ? { endpoint } : {}),
    // Explicit flag wins. Otherwise a custom endpoint (Neon, MinIO, ...) is
    // assumed to need path-style addressing, and real AWS is assumed not to.
    forcePathStyle: forcePathStyle ?? Boolean(endpoint),
    // Recent SDK versions add a checksum to every upload by default, which
    // S3-compatible services (Neon documents this) can reject. "Only when the
    // API requires it" behaves identically on real S3.
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
    maxAttempts: 3,
    // Credentials are deliberately NOT read here: the SDK's default provider
    // chain picks up AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY from the
    // environment (Neon) or an attached IAM role (AWS) — so no secret ever
    // passes through this code.
  };
}

// Aborts a hung request instead of letting it hold an API request open
// forever. The timer is cleared once the call resolves, so it never cuts off
// a large download that is already streaming to the client.
async function withTimeout(run) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OPERATION_TIMEOUT_MS);
  try {
    return await run(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

// "This object doesn't exist" — and only that. A missing BUCKET is also an
// HTTP 404 (NoSuchBucket), but it means misconfiguration, not a missing file:
// it must surface as an error rather than quietly look like an empty bucket.
function isMissing(err) {
  if (err?.name === "NoSuchBucket") return false;
  return (
    err?.name === "NoSuchKey" ||
    err?.name === "NotFound" ||
    err?.$metadata?.httpStatusCode === 404
  );
}

export function createS3Storage(config, client = new S3Client(buildS3ClientConfig(config))) {
  const Bucket = config.bucket;

  return {
    name: "s3",
    client,

    async put(key, filePath, contentType) {
      const { size } = await fs.promises.stat(filePath);
      const body = fs.createReadStream(filePath);
      try {
        await withTimeout((abortSignal) =>
          client.send(
            new PutObjectCommand({
              Bucket,
              Key: key,
              Body: body,
              ContentLength: size,
              ContentType: contentType,
            }),
            { abortSignal }
          )
        );
      } finally {
        body.destroy();
      }
    },

    async get(key) {
      try {
        const response = await withTimeout((abortSignal) =>
          client.send(new GetObjectCommand({ Bucket, Key: key }), { abortSignal })
        );
        return { body: response.Body, contentLength: response.ContentLength };
      } catch (err) {
        if (isMissing(err)) return null;
        throw err;
      }
    },

    async head(key) {
      try {
        const response = await withTimeout((abortSignal) =>
          client.send(new HeadObjectCommand({ Bucket, Key: key }), { abortSignal })
        );
        return { size: response.ContentLength };
      } catch (err) {
        if (isMissing(err)) return null;
        throw err;
      }
    },

    // S3 deletes are idempotent: deleting a missing key succeeds.
    async remove(key) {
      await withTimeout((abortSignal) =>
        client.send(new DeleteObjectCommand({ Bucket, Key: key }), { abortSignal })
      );
    },
  };
}
