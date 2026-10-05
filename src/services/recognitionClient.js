import { z } from "zod";
import { env } from "../config/env.js";

// Client for the private face-recognition microservice. The service is not
// trusted with the trust decision: it only says "closest enrolled student, this
// far away, this far ahead of the runner-up". Whether that is good enough is
// decided by the backend's own thresholds (env.verification).

const TIMEOUT_MS = 3000;
const ENROLL_TIMEOUT_MS = 15_000; // several full-size photos, not one downscaled frame
const MAX_FACES = 20;
const MAX_PHOTO_BYTES = 10 * 1024 * 1024; // matches the service's MAX_ENROLL_IMAGE_BYTES

const photoCountSchema = z.object({
  studentId: z.number().int().positive(),
  count: z.number().int().min(0).max(20), // service caps a student's folder at 20 images
});

const enrollResponseSchema = z.object({
  studentId: z.number().int().positive(),
  photosReceived: z.number().int().min(0),
  // How many of those photos held exactly one face and are now stored. Older
  // service builds do not send these, so they are optional.
  photosUsable: z.number().int().min(0).optional(),
  photosRejected: z.number().int().min(0).optional(),
  enrolled: z.boolean(),
});

// Validated on the way IN: a misbehaving or compromised service must not be able
// to inject arbitrary shapes or huge arrays into the pipeline.
const responseSchema = z.object({
  width: z.number().int().positive().max(10_000),
  height: z.number().int().positive().max(10_000),
  faces: z
    .array(
      z.object({
        box: z.tuple([z.number().int(), z.number().int(), z.number().int(), z.number().int()]),
        studentId: z.number().int().positive().nullable(),
        distance: z.number().finite().min(0).max(2).nullable(),
        margin: z.number().finite().min(-2).max(2).nullable(),
      }),
    )
    .max(MAX_FACES),
});

export function isRecognitionConfigured() {
  return env.recognition !== null;
}

export class RecognitionUnavailableError extends Error {}

// The service understood the request and refused it (HTTP 422: no photo held
// exactly one face). Not an outage, so callers answer 422, not 502.
export class RecognitionRejectedError extends Error {}

// `frame` is a Buffer holding a JPEG. Resolves to { width, height, faces }.
// Every failure mode (not configured, network, timeout, non-2xx, bad shape)
// becomes one RecognitionUnavailableError; the caller logs it and answers with
// a generic message.
export async function recognizeFrame(frame) {
  if (!env.recognition) throw new RecognitionUnavailableError("Recognition service is not configured");

  const form = new FormData();
  form.append("frame", new Blob([frame], { type: "image/jpeg" }), "frame.jpg");

  let response;
  try {
    response = await fetch(`${env.recognition.baseUrl}/recognize`, {
      method: "POST",
      headers: { "X-Service-Key": env.recognition.key },
      body: form,
      redirect: "error", // never follow a redirect with the key attached
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (cause) {
    throw new RecognitionUnavailableError(`Recognition request failed: ${cause?.name ?? "error"}`);
  }

  if (!response.ok) {
    throw new RecognitionUnavailableError(`Recognition service returned ${response.status}`);
  }

  let body;
  try {
    body = await response.json();
  } catch {
    throw new RecognitionUnavailableError("Recognition service returned invalid JSON");
  }
  const parsed = responseSchema.safeParse(body);
  if (!parsed.success) throw new RecognitionUnavailableError("Recognition service returned an unexpected shape");
  return parsed.data;
}

// `files` are multer memory-storage entries ({ buffer, mimetype }), already
// validated by the caller (JPEG/PNG signature, size, count). This REPLACES the
// student's whole enrollment photo set on the recognition service — it is not
// additive. Resolves to { studentId, photosReceived, enrolled }.
export async function enrollStudentPhotos(studentId, files) {
  if (!env.recognition) throw new RecognitionUnavailableError("Recognition service is not configured");

  const form = new FormData();
  for (const [index, file] of files.entries()) {
    const ext = file.mimetype === "image/png" ? "png" : "jpg";
    form.append("photos", new Blob([file.buffer], { type: file.mimetype }), `photo-${index}.${ext}`);
  }

  let response;
  try {
    response = await fetch(`${env.recognition.baseUrl}/enroll/${studentId}`, {
      method: "POST",
      headers: { "X-Service-Key": env.recognition.key },
      body: form,
      redirect: "error",
      signal: AbortSignal.timeout(ENROLL_TIMEOUT_MS),
    });
  } catch (cause) {
    throw new RecognitionUnavailableError(`Enrollment request failed: ${cause?.name ?? "error"}`);
  }

  if (response.status === 422) throw new RecognitionRejectedError("No usable face in the enrollment photos");
  if (!response.ok) {
    throw new RecognitionUnavailableError(`Recognition service returned ${response.status}`);
  }

  let body;
  try {
    body = await response.json();
  } catch {
    throw new RecognitionUnavailableError("Recognition service returned invalid JSON");
  }
  const parsed = enrollResponseSchema.safeParse(body);
  if (!parsed.success) throw new RecognitionUnavailableError("Recognition service returned an unexpected shape");
  return parsed.data;
}

// Erases a student's face photos and encoding from the recognition service.
// Idempotent on the service side. Same failure contract as the calls above.
export async function removeStudentEnrollment(studentId) {
  if (!env.recognition) throw new RecognitionUnavailableError("Recognition service is not configured");

  let response;
  try {
    response = await fetch(`${env.recognition.baseUrl}/enroll/${Number(studentId)}`, {
      method: "DELETE",
      headers: { "X-Service-Key": env.recognition.key },
      redirect: "error",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (cause) {
    throw new RecognitionUnavailableError(`Enrollment removal failed: ${cause?.name ?? "error"}`);
  }
  if (!response.ok) {
    throw new RecognitionUnavailableError(`Recognition service returned ${response.status}`);
  }
}

// How many enrollment photos the service holds for this student (no image data).
export async function countStudentEnrollmentPhotos(studentId) {
  if (!env.recognition) throw new RecognitionUnavailableError("Recognition service is not configured");

  let response;
  try {
    response = await fetch(`${env.recognition.baseUrl}/enroll/${Number(studentId)}/photos`, {
      headers: { "X-Service-Key": env.recognition.key },
      redirect: "error",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (cause) {
    throw new RecognitionUnavailableError(`Photo count request failed: ${cause?.name ?? "error"}`);
  }
  if (!response.ok) throw new RecognitionUnavailableError(`Recognition service returned ${response.status}`);

  let body;
  try {
    body = await response.json();
  } catch {
    throw new RecognitionUnavailableError("Recognition service returned invalid JSON");
  }
  const parsed = photoCountSchema.safeParse(body);
  if (!parsed.success) throw new RecognitionUnavailableError("Recognition service returned an unexpected shape");
  return parsed.data;
}

// One stored enrollment photo by position. Resolves to { buffer, contentType },
// or null if that photo no longer exists. The caller must still check the bytes.
export async function fetchStudentEnrollmentPhoto(studentId, index) {
  if (!env.recognition) throw new RecognitionUnavailableError("Recognition service is not configured");

  let response;
  try {
    response = await fetch(
      `${env.recognition.baseUrl}/enroll/${Number(studentId)}/photos/${Number(index)}`,
      {
        headers: { "X-Service-Key": env.recognition.key },
        redirect: "error",
        signal: AbortSignal.timeout(ENROLL_TIMEOUT_MS),
      },
    );
  } catch (cause) {
    throw new RecognitionUnavailableError(`Photo request failed: ${cause?.name ?? "error"}`);
  }
  if (response.status === 404) return null;
  if (!response.ok) throw new RecognitionUnavailableError(`Recognition service returned ${response.status}`);

  const contentType = response.headers.get("content-type")?.split(";")[0].trim();
  if (contentType !== "image/jpeg" && contentType !== "image/png") {
    throw new RecognitionUnavailableError("Recognition service returned an unexpected content type");
  }
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_PHOTO_BYTES) {
    throw new RecognitionUnavailableError("Recognition service returned an oversized photo");
  }
  let buffer;
  try {
    buffer = Buffer.from(await response.arrayBuffer());
  } catch {
    throw new RecognitionUnavailableError("Recognition service photo could not be read");
  }
  if (buffer.length > MAX_PHOTO_BYTES) {
    throw new RecognitionUnavailableError("Recognition service returned an oversized photo");
  }
  return { buffer, contentType };
}
