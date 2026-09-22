import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    student: { findUnique: vi.fn() },
    studentBleDevice: {
      findMany: vi.fn(), findUnique: vi.fn(), count: vi.fn(), create: vi.fn(),
      updateMany: vi.fn(), deleteMany: vi.fn(),
    },
  },
}));

const { prisma } = await import("../src/lib/prisma.js");
const { listBleDevices, addBleDevice, setBleDeviceEnabled, removeBleDevice, MAX_DEVICES_PER_STUDENT } =
  await import("../src/controllers/bleDevices.controller.js");

function mockRes() {
  const res = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  res.end = vi.fn().mockReturnValue(res);
  return res;
}
const device = (over = {}) => ({
  id: 1, studentId: 5, deviceIdentifier: "D7:40:47:15:14:90", enabled: true,
  registeredAt: new Date("2026-09-20T00:00:00Z"), ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  prisma.student.findUnique.mockResolvedValue({ id: 5 });
});

describe("addBleDevice", () => {
  it("normalises the MAC and registers it against the URL's student", async () => {
    prisma.studentBleDevice.count.mockResolvedValue(0);
    prisma.studentBleDevice.create.mockResolvedValue(device());
    const res = mockRes();
    await addBleDevice({ params: { id: "5" }, body: { deviceIdentifier: "d7-40-47-15-14-90", studentId: 999 } }, res, vi.fn());

    expect(prisma.studentBleDevice.create).toHaveBeenCalledWith({
      data: { studentId: 5, deviceIdentifier: "D7:40:47:15:14:90" }, // body studentId ignored
    });
    expect(res.status).toHaveBeenCalledWith(201);
  });

  it.each([undefined, "", "not-a-mac", 123, "D7:40:47:15:14:90; DROP TABLE"])("400s on bad identifier %j", async (bad) => {
    const next = vi.fn();
    await addBleDevice({ params: { id: "5" }, body: { deviceIdentifier: bad } }, mockRes(), next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 400 }));
    expect(prisma.studentBleDevice.create).not.toHaveBeenCalled();
  });

  it("404s for an unknown student", async () => {
    prisma.student.findUnique.mockResolvedValue(null);
    const next = vi.fn();
    await addBleDevice({ params: { id: "5" }, body: { deviceIdentifier: "D7:40:47:15:14:90" } }, mockRes(), next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 404 }));
  });

  it("409s when the student already has the maximum number of devices", async () => {
    prisma.studentBleDevice.count.mockResolvedValue(MAX_DEVICES_PER_STUDENT);
    const next = vi.fn();
    await addBleDevice({ params: { id: "5" }, body: { deviceIdentifier: "D7:40:47:15:14:90" } }, mockRes(), next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 409 }));
    expect(prisma.studentBleDevice.create).not.toHaveBeenCalled();
  });

  it("409s on a duplicate tag WITHOUT revealing which student owns it", async () => {
    prisma.studentBleDevice.count.mockResolvedValue(0);
    prisma.studentBleDevice.create.mockRejectedValue(Object.assign(new Error("Unique on studentId 77"), { code: "P2002" }));
    const next = vi.fn();
    await addBleDevice({ params: { id: "5" }, body: { deviceIdentifier: "D7:40:47:15:14:90" } }, mockRes(), next);
    const err = next.mock.calls[0][0];
    expect(err.status).toBe(409);
    expect(err.message).toBe("This device is already registered");
    expect(err.message).not.toMatch(/77/);
  });
});

describe("listBleDevices", () => {
  it("lists only the URL student's devices", async () => {
    prisma.studentBleDevice.findMany.mockResolvedValue([device()]);
    const res = mockRes();
    await listBleDevices({ params: { id: "5" } }, res, vi.fn());
    expect(prisma.studentBleDevice.findMany.mock.calls[0][0].where).toEqual({ studentId: 5 });
    expect(res.json.mock.calls[0][0]).toHaveLength(1);
  });

  it("rejects a non-numeric id", async () => {
    const next = vi.fn();
    await listBleDevices({ params: { id: "5; --" } }, mockRes(), next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 400 }));
  });
});

describe("setBleDeviceEnabled / removeBleDevice — scoped to the URL student (no IDOR)", () => {
  it("only updates a device that belongs to that student", async () => {
    prisma.studentBleDevice.updateMany.mockResolvedValue({ count: 1 });
    prisma.studentBleDevice.findUnique.mockResolvedValue(device({ enabled: false }));
    const res = mockRes();
    await setBleDeviceEnabled({ params: { id: "5", deviceId: "1" }, body: { enabled: false } }, res, vi.fn());
    expect(prisma.studentBleDevice.updateMany.mock.calls[0][0].where).toEqual({ id: 1, studentId: 5 });
    expect(res.json.mock.calls[0][0].enabled).toBe(false);
  });

  it("404s when the device belongs to a different student", async () => {
    prisma.studentBleDevice.updateMany.mockResolvedValue({ count: 0 });
    const next = vi.fn();
    await setBleDeviceEnabled({ params: { id: "6", deviceId: "1" }, body: { enabled: true } }, mockRes(), next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 404 }));
  });

  it.each([undefined, "true", 1, null])("400s when enabled is %j (must be a real boolean)", async (bad) => {
    const next = vi.fn();
    await setBleDeviceEnabled({ params: { id: "5", deviceId: "1" }, body: { enabled: bad } }, mockRes(), next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 400 }));
  });

  it("delete is scoped the same way and 404s otherwise", async () => {
    prisma.studentBleDevice.deleteMany.mockResolvedValue({ count: 0 });
    const next = vi.fn();
    await removeBleDevice({ params: { id: "6", deviceId: "1" } }, mockRes(), next);
    expect(prisma.studentBleDevice.deleteMany.mock.calls[0][0].where).toEqual({ id: 1, studentId: 6 });
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 404 }));

    prisma.studentBleDevice.deleteMany.mockResolvedValue({ count: 1 });
    const res = mockRes();
    await removeBleDevice({ params: { id: "5", deviceId: "1" } }, res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(204);
  });
});
