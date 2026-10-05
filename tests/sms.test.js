import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../src/config/env.js", () => ({
  env: {
    semaphore: { configured: true, apiKey: "test-key", senderName: "ECCDTrck" },
    smsProvider: "semaphore",
    textbee: { configured: true, apiKey: "tb-key", baseUrl: "https://api.textbee.dev/api/v1", deviceId: null },
  },
}));
vi.mock("../src/lib/logger.js", () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

const { env } = await import("../src/config/env.js");
const { logger } = await import("../src/lib/logger.js");
const { sendSms } = await import("../src/lib/sms.js");

function okResponse() {
  return { ok: true, status: 200, text: async () => "" };
}

beforeEach(() => {
  env.semaphore.configured = true;
  env.semaphore.apiKey = "test-key";
  env.semaphore.senderName = "ECCDTrck";
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(okResponse()));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("sendSms", () => {
  it("skips (and logs) instead of sending when Semaphore isn't configured", async () => {
    env.semaphore.configured = false;

    await sendSms("09171234567", "hello");

    expect(fetch).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalled();
  });

  it.each(["9171234567", "09171234567", "639171234567", "+639171234567", "0917 123 4567", "0917-123-4567"])(
    "accepts a valid PH mobile number in various formats: %s",
    async (input) => {
      await sendSms(input, "hello");
      expect(fetch).toHaveBeenCalledTimes(1);
    }
  );

  it.each(["12345", "091712345", "639171234567890", "notanumber"])(
    "rejects a number that isn't a PH mobile number: %s",
    async (input) => {
      await expect(sendSms(input, "hello")).rejects.toThrow();
      expect(fetch).not.toHaveBeenCalled();
    }
  );

  it("posts apikey, number, message and sender name as form data", async () => {
    await sendSms("0917 123 4567", "Ana Cruz arrived at school at 8:30 AM.");

    const [url, options] = fetch.mock.calls[0];
    expect(url).toBe("https://api.semaphore.co/api/v4/messages");
    expect(options.method).toBe("POST");
    const body = new URLSearchParams(options.body);
    expect(body.get("apikey")).toBe("test-key");
    expect(body.get("number")).toBe("09171234567"); // spaces stripped
    expect(body.get("message")).toBe("Ana Cruz arrived at school at 8:30 AM.");
    expect(body.get("sendername")).toBe("ECCDTrck");
  });

  it("restores the leading 0 for a stored bare 10-digit number", async () => {
    await sendSms("9171234567", "hello");

    expect(new URLSearchParams(fetch.mock.calls[0][1].body).get("number")).toBe("09171234567");
  });

  it("omits sendername when none is configured", async () => {
    env.semaphore.senderName = null;

    await sendSms("09171234567", "hello");

    const body = new URLSearchParams(fetch.mock.calls[0][1].body);
    expect(body.has("sendername")).toBe(false);
  });

  it("throws (and logs server-side detail) when Semaphore responds with an error", async () => {
    fetch.mockResolvedValue({ ok: false, status: 401, text: async () => "Invalid API key" });

    await expect(sendSms("09171234567", "hello")).rejects.toThrow();
    expect(logger.error).toHaveBeenCalled();
  });
});

describe("sendSms retries", () => {
  const throttled = (retryAfter) => ({
    ok: false,
    status: 429,
    headers: new Headers(retryAfter === undefined ? {} : { "retry-after": String(retryAfter) }),
    text: async () => "Too many requests",
  });

  it("retries a 429 (honoring Retry-After) and succeeds once Semaphore accepts it", async () => {
    fetch.mockResolvedValueOnce(throttled(0)).mockResolvedValueOnce(okResponse());

    await expect(sendSms("09171234567", "hello")).resolves.toBeUndefined();

    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("retries a 503 too", async () => {
    fetch
      .mockResolvedValueOnce({ ok: false, status: 503, headers: new Headers({ "retry-after": "0" }), text: async () => "" })
      .mockResolvedValueOnce(okResponse());

    await sendSms("09171234567", "hello");

    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("gives up after 2 retries (3 calls total) and throws", async () => {
    fetch.mockResolvedValue(throttled(0));

    await expect(sendSms("09171234567", "hello")).rejects.toThrow("429");

    expect(fetch).toHaveBeenCalledTimes(3);
    expect(logger.error).toHaveBeenCalled();
  });

  it.each([400, 401, 500, 502])("does NOT retry a %i (could double-send or can never succeed)", async (status) => {
    fetch.mockResolvedValue({ ok: false, status, headers: new Headers(), text: async () => "" });

    await expect(sendSms("09171234567", "hello")).rejects.toThrow();

    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("falls back to a 2s backoff when there is no Retry-After header", async () => {
    vi.useFakeTimers();
    try {
      fetch.mockResolvedValueOnce(throttled()).mockResolvedValueOnce(okResponse());

      const pending = sendSms("09171234567", "hello");
      await vi.advanceTimersByTimeAsync(1999);
      expect(fetch).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      await pending;

      expect(fetch).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("caps an oversized Retry-After at 10s", async () => {
    vi.useFakeTimers();
    try {
      fetch.mockResolvedValueOnce(throttled(3600)).mockResolvedValueOnce(okResponse());

      const pending = sendSms("09171234567", "hello");
      await vi.advanceTimersByTimeAsync(10_000);
      await pending;

      expect(fetch).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("sendSms with SMS_PROVIDER=textbee", () => {
  beforeEach(() => {
    env.smsProvider = "textbee";
    env.textbee.configured = true;
    env.textbee.apiKey = "tb-key";
    env.textbee.baseUrl = "https://api.textbee.dev/api/v1";
    env.textbee.deviceId = null;
  });

  afterEach(() => {
    env.smsProvider = "semaphore";
  });

  it("never calls Semaphore", async () => {
    await sendSms("09171234567", "hello");

    expect(fetch.mock.calls[0][0]).not.toContain("semaphore.co");
  });

  it("skips (and logs) instead of sending when TextBee isn't configured", async () => {
    env.textbee.configured = false;

    await sendSms("09171234567", "hello");

    expect(fetch).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalled();
  });

  it("posts JSON to /gateway/send-sms with the key in the x-api-key header only", async () => {
    await sendSms("0917 123 4567", "Ana Cruz arrived at school at 8:30 AM.");

    const [url, options] = fetch.mock.calls[0];
    expect(url).toBe("https://api.textbee.dev/api/v1/gateway/send-sms");
    expect(options.method).toBe("POST");
    expect(options.headers["x-api-key"]).toBe("tb-key");
    expect(options.body).not.toContain("tb-key");
    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(options.body)).toEqual({
      recipients: ["+639171234567"],
      message: "Ana Cruz arrived at school at 8:30 AM.",
    });
  });

  it.each(["9171234567", "09171234567", "639171234567", "+639171234567", "0917-123-4567"])(
    "converts %s to international format",
    async (input) => {
      await sendSms(input, "hello");
      expect(JSON.parse(fetch.mock.calls[0][1].body).recipients).toEqual(["+639171234567"]);
    }
  );

  it.each(["12345", "091712345", "639171234567890", "notanumber"])(
    "rejects a number that isn't a PH mobile number: %s",
    async (input) => {
      await expect(sendSms(input, "hello")).rejects.toThrow();
      expect(fetch).not.toHaveBeenCalled();
    }
  );

  it("includes deviceId only when configured", async () => {
    env.textbee.deviceId = "dev-123";

    await sendSms("09171234567", "hello");

    expect(JSON.parse(fetch.mock.calls[0][1].body).deviceId).toBe("dev-123");
  });

  it("honors a self-hosted base URL", async () => {
    env.textbee.baseUrl = "https://sms.example.org/api/v1";

    await sendSms("09171234567", "hello");

    expect(fetch.mock.calls[0][0]).toBe("https://sms.example.org/api/v1/gateway/send-sms");
  });

  it.each([401, 429, 500, 503])(
    "throws on %i, logs detail server-side, and does NOT retry (could double-send)",
    async (status) => {
      fetch.mockResolvedValue({ ok: false, status, text: async () => "provider detail" });

      await expect(sendSms("09171234567", "hello")).rejects.toThrow(String(status));

      expect(fetch).toHaveBeenCalledTimes(1);
      expect(logger.error).toHaveBeenCalled();
    }
  );

  it("does not leak the provider response body in the thrown error", async () => {
    fetch.mockResolvedValue({ ok: false, status: 400, text: async () => "secret account detail" });

    await expect(sendSms("09171234567", "hello")).rejects.not.toThrow("secret account detail");
  });
});
