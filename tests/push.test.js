import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/config/env.js", () => ({
  env: { vapid: { configured: true, publicKey: "PUB", privateKey: "PRIV", subject: "mailto:ops@example.com" } },
}));
vi.mock("../src/lib/logger.js", () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));
vi.mock("web-push", () => ({
  default: { setVapidDetails: vi.fn(), sendNotification: vi.fn() },
}));

const webpush = (await import("web-push")).default;
const { env } = await import("../src/config/env.js");
const { isAllowedPushEndpoint, sendPush } = await import("../src/lib/push.js");

const SUB = { endpoint: "https://fcm.googleapis.com/fcm/send/abc", p256dh: "P", auth: "A" };

beforeEach(() => {
  vi.clearAllMocks();
  env.vapid.configured = true;
  webpush.sendNotification.mockResolvedValue({});
});

describe("isAllowedPushEndpoint", () => {
  it.each([
    "https://fcm.googleapis.com/fcm/send/abc",
    "https://updates.push.services.mozilla.com/wpush/v2/abc",
    "https://wns2-par02p.notify.windows.com/w/?token=abc",
    "https://web.push.apple.com/abc",
  ])("accepts a real browser push service: %s", (endpoint) => {
    expect(isAllowedPushEndpoint(endpoint)).toBe(true);
  });

  it.each([
    ["plain http", "http://fcm.googleapis.com/fcm/send/abc"],
    ["localhost", "https://localhost/x"],
    ["cloud metadata address", "http://169.254.169.254/latest/meta-data/"],
    ["private network address", "https://10.0.0.5/x"],
    ["an unrelated host", "https://evil.example.com/fcm.googleapis.com"],
    ["a look-alike suffix", "https://evilfcm.googleapis.com/x"],
    ["an allowed name as a subdomain of another host", "https://fcm.googleapis.com.evil.com/x"],
    ["credentials that hide the real host", "https://fcm.googleapis.com@evil.com/x"],
    ["a non-standard port", "https://fcm.googleapis.com:8443/x"],
    ["a non-http scheme", "ftp://fcm.googleapis.com/x"],
    ["garbage", "not a url"],
    ["an over-long value", `https://fcm.googleapis.com/${"a".repeat(2100)}`],
    ["a non-string", 12345],
    ["undefined", undefined],
  ])("rejects %s", (_label, endpoint) => {
    expect(isAllowedPushEndpoint(endpoint)).toBe(false);
  });
});

describe("sendPush", () => {
  it("sends the JSON payload with the subscription keys and returns 'sent'", async () => {
    const result = await sendPush(SUB, { title: "Arrival", body: "Ana arrived." });

    expect(result).toBe("sent");
    expect(webpush.setVapidDetails).toHaveBeenCalledWith("mailto:ops@example.com", "PUB", "PRIV");
    expect(webpush.sendNotification).toHaveBeenCalledWith(
      { endpoint: SUB.endpoint, keys: { p256dh: "P", auth: "A" } },
      JSON.stringify({ title: "Arrival", body: "Ana arrived." }),
      expect.objectContaining({ TTL: 3600 }),
    );
  });

  it("does nothing and returns 'skipped' when VAPID isn't configured", async () => {
    env.vapid.configured = false;

    expect(await sendPush(SUB, { title: "t", body: "b" })).toBe("skipped");
    expect(webpush.sendNotification).not.toHaveBeenCalled();
  });

  it.each([404, 410])("returns 'gone' when the browser says the subscription is gone (%i)", async (statusCode) => {
    webpush.sendNotification.mockRejectedValue(Object.assign(new Error("gone"), { statusCode }));

    expect(await sendPush(SUB, { title: "t", body: "b" })).toBe("gone");
  });

  it("throws other failures so the caller can log them", async () => {
    webpush.sendNotification.mockRejectedValue(Object.assign(new Error("server error"), { statusCode: 500 }));

    await expect(sendPush(SUB, { title: "t", body: "b" })).rejects.toThrow("server error");
  });
});
