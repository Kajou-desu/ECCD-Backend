import { z } from "zod";
import { env } from "../config/env.js";

// Client for the private face-recognition microservice. The service is not
// trusted with the trust decision: it only says "closest enrolled student, this
// far away, this far ahead of the runner-up". Whether that is good enough is
// decided by the backend's own thresholds (env.verification).

const TIMEOUT_MS = 3000;
const MAX_FACES = 20;

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
