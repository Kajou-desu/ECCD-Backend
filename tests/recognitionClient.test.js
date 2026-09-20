import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// env.recognition is null in the test environment; provide a configured one.
vi.mock("../src/config/env.js", async (importOriginal) => {
  const mod = await importOriginal();
  return { env: { ...mod.env, recognition: { baseUrl: "http://127.0.0.1:8001", key: "k".repeat(40) } } };
});

const { recognizeFrame, RecognitionUnavailableError } = await import("../src/services/recognitionClient.js");

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const okBody = {
  width: 640, height: 480,
  faces: [{ box: [10, 200, 120, 90], studentId: 4, distance: 0.38, margin: 0.12 }],
};
const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), { status });

let fetchMock;
beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe("recognizeFrame — request", () => {
  it("POSTs the frame to /recognize with the service key, no redirects, and a timeout", async () => {
    fetchMock.mockResolvedValue(jsonResponse(okBody));
    await recognizeFrame(JPEG);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://127.0.0.1:8001/recognize");
    expect(init.method).toBe("POST");
    expect(init.headers["X-Service-Key"]).toBe("k".repeat(40));
    expect(init.redirect).toBe("error"); // never follow a redirect with the key attached
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.body.get("frame")).toBeInstanceOf(Blob);
    expect(init.body.get("frame").type).toBe("image/jpeg");
  });
});

describe("recognizeFrame — every failure becomes one RecognitionUnavailableError", () => {
  it("network failure", async () => {
    fetchMock.mockRejectedValue(Object.assign(new Error("connect ECONNREFUSED 10.0.0.5:8001"), { name: "TypeError" }));
    const err = await recognizeFrame(JPEG).catch((e) => e);
    expect(err).toBeInstanceOf(RecognitionUnavailableError);
    expect(err.message).not.toMatch(/10\.0\.0\.5/); // no internal addresses in the message
  });

  it("timeout", async () => {
    fetchMock.mockRejectedValue(Object.assign(new Error("aborted"), { name: "TimeoutError" }));
    await expect(recognizeFrame(JPEG)).rejects.toBeInstanceOf(RecognitionUnavailableError);
  });

  it.each([401, 413, 500, 503])("HTTP %i from the service", async (status) => {
    fetchMock.mockResolvedValue(jsonResponse({ detail: "x" }, status));
    await expect(recognizeFrame(JPEG)).rejects.toBeInstanceOf(RecognitionUnavailableError);
  });

  it("non-JSON body", async () => {
    fetchMock.mockResolvedValue(new Response("<html>oops</html>", { status: 200 }));
    await expect(recognizeFrame(JPEG)).rejects.toBeInstanceOf(RecognitionUnavailableError);
  });
});

describe("recognizeFrame — the response is validated, not trusted", () => {
  const bad = {
    "missing faces": { width: 640, height: 480 },
    "faces not an array": { width: 640, height: 480, faces: "x" },
    "too many faces": { width: 640, height: 480, faces: Array.from({ length: 21 }, () => okBody.faces[0]) },
    "studentId as string": { ...okBody, faces: [{ ...okBody.faces[0], studentId: "4" }] },
    "negative studentId": { ...okBody, faces: [{ ...okBody.faces[0], studentId: -1 }] },
    "fractional studentId": { ...okBody, faces: [{ ...okBody.faces[0], studentId: 1.5 }] },
    "NaN-ish distance (string)": { ...okBody, faces: [{ ...okBody.faces[0], distance: "0.1" }] },
    "absurd distance": { ...okBody, faces: [{ ...okBody.faces[0], distance: 99 }] },
    "box of wrong length": { ...okBody, faces: [{ ...okBody.faces[0], box: [1, 2, 3] }] },
    "zero-size frame": { ...okBody, width: 0 },
  };
  it.each(Object.entries(bad))("rejects: %s", async (_label, body) => {
    fetchMock.mockResolvedValue(jsonResponse(body));
    await expect(recognizeFrame(JPEG)).rejects.toBeInstanceOf(RecognitionUnavailableError);
  });

  it("accepts null studentId/distance/margin (an unknown face) and returns clean data", async () => {
    const body = { ...okBody, faces: [{ box: [1, 2, 3, 4], studentId: null, distance: null, margin: null, extra: "dropped" }] };
    fetchMock.mockResolvedValue(jsonResponse(body));
    const out = await recognizeFrame(JPEG);
    expect(out.faces[0]).toEqual({ box: [1, 2, 3, 4], studentId: null, distance: null, margin: null });
  });
});
