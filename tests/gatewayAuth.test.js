import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/lib/prisma.js", () => ({
  prisma: { bleGateway: { findUnique: vi.fn(), update: vi.fn() } },
}));

const { prisma } = await import("../src/lib/prisma.js");
const { requireGateway } = await import("../src/middleware/gatewayAuth.js");
const { generateSecret, hashSecret, formatDeviceKey } = await import("../src/utils/deviceKey.js");

function mockRes() {
  const res = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res;
}
const reqWithKey = (key) => ({ get: (h) => (h.toLowerCase() === "x-device-key" ? key : undefined) });

const secret = generateSecret();
const goodKey = formatDeviceKey(3, secret);
const row = (over = {}) => ({
  id: 3, name: "Front door", keyHash: hashSecret(secret), enabled: true,
  lastSeenAt: new Date(), ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  prisma.bleGateway.update.mockResolvedValue({});
});

describe("requireGateway (default deny)", () => {
  it("401s a missing or malformed key WITHOUT touching the database", async () => {
    for (const key of [undefined, "", "garbage", `3.${"z".repeat(64)}`]) {
      const res = mockRes();
      const next = vi.fn();
      await requireGateway(reqWithKey(key), res, next);
      expect(res.status).toHaveBeenCalledWith(401);
      expect(next).not.toHaveBeenCalled();
    }
    expect(prisma.bleGateway.findUnique).not.toHaveBeenCalled();
  });

  it("accepts the right key, exposes only id+name, and never the key or hash", async () => {
    prisma.bleGateway.findUnique.mockResolvedValue(row());
    const req = reqWithKey(goodKey);
    const next = vi.fn();
    await requireGateway(req, mockRes(), next);
    expect(next).toHaveBeenCalledWith(); // no error
    expect(req.gateway).toEqual({ id: 3, name: "Front door" });
  });

  it.each([
    ["unknown gateway id", null],
    ["disabled gateway", row({ enabled: false })],
    ["wrong secret for a real id", row({ keyHash: hashSecret(generateSecret()) })],
  ])("401s with the SAME message for %s (no way to tell them apart)", async (_label, dbRow) => {
    prisma.bleGateway.findUnique.mockResolvedValue(dbRow);
    const res = mockRes();
    const next = vi.fn();
    await requireGateway(reqWithKey(goodKey), res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ message: "Invalid device key" });
    expect(next).not.toHaveBeenCalled();
  });

  it("records a heartbeat only when the last one is stale (throttled)", async () => {
    prisma.bleGateway.findUnique.mockResolvedValue(row({ lastSeenAt: new Date() }));
    await requireGateway(reqWithKey(goodKey), mockRes(), vi.fn());
    expect(prisma.bleGateway.update).not.toHaveBeenCalled();

    prisma.bleGateway.findUnique.mockResolvedValue(row({ lastSeenAt: new Date(Date.now() - 60_000) }));
    await requireGateway(reqWithKey(goodKey), mockRes(), vi.fn());
    expect(prisma.bleGateway.update).toHaveBeenCalledTimes(1);

    prisma.bleGateway.update.mockClear();
    prisma.bleGateway.findUnique.mockResolvedValue(row({ lastSeenAt: null }));
    await requireGateway(reqWithKey(goodKey), mockRes(), vi.fn());
    expect(prisma.bleGateway.update).toHaveBeenCalledTimes(1);
  });

  it("a failing heartbeat write never fails the request", async () => {
    prisma.bleGateway.findUnique.mockResolvedValue(row({ lastSeenAt: null }));
    prisma.bleGateway.update.mockRejectedValue(new Error("db hiccup"));
    const next = vi.fn();
    await requireGateway(reqWithKey(goodKey), mockRes(), next);
    await Promise.resolve();
    expect(next).toHaveBeenCalledWith();
  });

  it("passes database errors to next() (a 500, not a silent allow)", async () => {
    const err = new Error("db down");
    prisma.bleGateway.findUnique.mockRejectedValue(err);
    const next = vi.fn();
    await requireGateway(reqWithKey(goodKey), mockRes(), next);
    expect(next).toHaveBeenCalledWith(err);
  });
});
