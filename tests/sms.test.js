import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../src/config/env.js", () => ({
  env: { semaphore: { configured: true, apiKey: "test-key", senderName: "ECCDTrck" } },
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

  it.each(["09171234567", "639171234567", "+639171234567", "0917 123 4567", "0917-123-4567"])(
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
