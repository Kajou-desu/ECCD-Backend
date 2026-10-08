import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// env.recognition is null in the test environment; provide a configured one.
vi.mock("../src/config/env.js", async (importOriginal) => {
  const mod = await importOriginal();
  return { env: { ...mod.env, recognition: { baseUrl: "http://127.0.0.1:8001", key: "k".repeat(40) } } };
});

const {
  recognizeFrame,
  enrollStudentPhotos,
  countStudentEnrollmentPhotos,
  fetchStudentEnrollmentPhoto,
  listEnrolledStudentIds,
  RecognitionUnavailableError,
  RecognitionStaleError,
} = await import("../src/services/recognitionClient.js");

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

describe("enrollStudentPhotos — response", () => {
  const photo = { buffer: JPEG, mimetype: "image/jpeg", originalname: "a.jpg" };

  it("passes through how many photos were usable and rejected", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ studentId: 5, photosReceived: 3, photosUsable: 1, photosRejected: 2, enrolled: true }),
    );
    const result = await enrollStudentPhotos(5, [photo, photo, photo]);
    expect(result).toEqual({ studentId: 5, photosReceived: 3, photosUsable: 1, photosRejected: 2, enrolled: true });
  });

  it("still accepts the older response without the usable counts", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ studentId: 5, photosReceived: 1, enrolled: true }));
    const result = await enrollStudentPhotos(5, [photo]);
    expect(result.enrolled).toBe(true);
  });
});

describe("enrollment photo set version", () => {
  const VERSION = "0123456789abcdef";
  const imageResponse = () => new Response(JPEG, { status: 200, headers: { "content-type": "image/jpeg" } });

  it("passes the version through when counting", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ studentId: 5, count: 2, version: VERSION }));
    expect(await countStudentEnrollmentPhotos(5)).toEqual({ studentId: 5, count: 2, version: VERSION });
  });

  it("still accepts a service that sends no version", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ studentId: 5, count: 2 }));
    expect((await countStudentEnrollmentPhotos(5)).count).toBe(2);
  });

  it("rejects a malformed version", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ studentId: 5, count: 2, version: "../../etc" }));
    await expect(countStudentEnrollmentPhotos(5)).rejects.toBeInstanceOf(RecognitionUnavailableError);
  });

  it("sends the version with the photo request, URL-encoded, only when given", async () => {
    fetchMock.mockResolvedValue(imageResponse());
    await fetchStudentEnrollmentPhoto(5, 1, VERSION);
    expect(fetchMock.mock.calls[0][0]).toBe(`http://127.0.0.1:8001/enroll/5/photos/1?v=${VERSION}`);
    fetchMock.mockResolvedValue(imageResponse());
    await fetchStudentEnrollmentPhoto(5, 1);
    expect(fetchMock.mock.calls[1][0]).toBe("http://127.0.0.1:8001/enroll/5/photos/1");
  });

  it("turns a 409 into RecognitionStaleError, not an outage", async () => {
    fetchMock.mockResolvedValue(new Response("{}", { status: 409 }));
    await expect(fetchStudentEnrollmentPhoto(5, 0, VERSION)).rejects.toBeInstanceOf(RecognitionStaleError);
  });
});

describe("listEnrolledStudentIds", () => {
  it("returns the ids", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ studentIds: [3, 9] }));
    expect(await listEnrolledStudentIds()).toEqual([3, 9]);
    expect(fetchMock.mock.calls[0][0]).toBe("http://127.0.0.1:8001/enrollments");
    expect(fetchMock.mock.calls[0][1].headers["X-Service-Key"]).toBe("k".repeat(40));
  });

  it("rejects an unexpected shape and a failed request", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ studentIds: ["x"] }));
    await expect(listEnrolledStudentIds()).rejects.toBeInstanceOf(RecognitionUnavailableError);
    fetchMock.mockResolvedValue(new Response("", { status: 500 }));
    await expect(listEnrolledStudentIds()).rejects.toBeInstanceOf(RecognitionUnavailableError);
  });
});
