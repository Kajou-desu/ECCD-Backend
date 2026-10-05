import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const sendMail = vi.fn();
vi.mock("nodemailer", () => ({ default: { createTransport: () => ({ sendMail }) } }));
vi.mock("../src/lib/logger.js", () => ({ logger: { info: vi.fn(), error: vi.fn() } }));

// Mutable stand-in for config/env.js so each test picks the transport.
const env = {
  emailConfigured: true,
  resend: { apiKey: "re_test_key" },
  smtp: { configured: true, host: "h", port: 587, user: "u", pass: "p", from: '"ECCD SmartTrack" <no-reply@eccdsmarttrack.app>' },
};
vi.mock("../src/config/env.js", () => ({ env }));

const { sendOtpEmail, sendAttendanceEmail } = await import("../src/lib/mailer.js");

describe("mailer", () => {
  beforeEach(() => {
    sendMail.mockReset();
    env.emailConfigured = true;
    env.resend.apiKey = "re_test_key";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
  });
  afterEach(() => vi.unstubAllGlobals());

  it("sends the OTP through Resend's HTTPS API when RESEND_API_KEY is set (no SMTP)", async () => {
    await sendOtpEmail("parent@example.com", "123456");

    expect(sendMail).not.toHaveBeenCalled();
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe("https://api.resend.com/emails");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer re_test_key");
    const body = JSON.parse(init.body);
    expect(body.from).toBe(env.smtp.from);
    expect(body.to).toEqual(["parent@example.com"]);
    expect(body.subject).toBe("ECCD SmartTrack — Password Reset Code");
    expect(body.text).toContain("123456");
  });

  it("throws on a non-2xx response without leaking the API key", async () => {
    fetch.mockResolvedValue({ ok: false, status: 403, text: async () => '{"message":"domain not verified"}' });

    const err = await sendAttendanceEmail("a@example.com", "s", "t").catch((e) => e);
    expect(err.message).toMatch(/403/);
    expect(err.message).toMatch(/domain not verified/);
    expect(err.message).not.toContain("re_test_key");
  });

  it("falls back to SMTP when no Resend key is set", async () => {
    env.resend.apiKey = undefined;
    await sendAttendanceEmail("a@example.com", "Arrived", "Hello");

    expect(fetch).not.toHaveBeenCalled();
    expect(sendMail).toHaveBeenCalledWith({ from: env.smtp.from, to: "a@example.com", subject: "Arrived", text: "Hello" });
  });

  it("sends nothing when no transport is configured (dev logging only)", async () => {
    env.emailConfigured = false;
    await sendOtpEmail("a@example.com", "123456");

    expect(fetch).not.toHaveBeenCalled();
    expect(sendMail).not.toHaveBeenCalled();
  });
});
