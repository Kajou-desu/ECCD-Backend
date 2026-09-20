import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";

process.env.JWT_SECRET = "test-secret-at-least-32-characters-long";
process.env.CLIENT_ORIGIN = "http://localhost:5173";

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    $queryRaw: vi.fn(),
    user: { findUnique: vi.fn() },
    bleGateway: { findUnique: vi.fn(), update: vi.fn() },
    attendanceSession: { findFirst: vi.fn() },
    studentBleDevice: { findMany: vi.fn() },
    student: { findUnique: vi.fn() },
  },
}));

const { prisma } = await import("../src/lib/prisma.js");
const { signToken } = await import("../src/utils/jwt.js");
const { generateSecret, hashSecret, formatDeviceKey } = await import("../src/utils/deviceKey.js");
const { app } = await import("../src/app.js");

const secret = generateSecret();
const KEY = formatDeviceKey(1, secret);
const gatewayRow = { id: 1, name: "Front door", keyHash: hashSecret(secret), enabled: true, lastSeenAt: new Date() };

function teacherAuth(role = "Teacher") {
  const user = { id: 9, email: "t@school.test", role, isActive: true, tokenVersion: 0 };
  prisma.user.findUnique.mockResolvedValue(user);
  return `Bearer ${signToken(user)}`;
}

beforeEach(() => {
  vi.clearAllMocks();
  prisma.bleGateway.findUnique.mockResolvedValue(gatewayRow);
  prisma.bleGateway.update.mockResolvedValue({});
  prisma.attendanceSession.findFirst.mockResolvedValue(null);
  prisma.studentBleDevice.findMany.mockResolvedValue([]);
});

describe("gateway endpoints — authentication", () => {
  it.each([
    ["get", "/api/attendance/gateway/devices"],
    ["post", "/api/attendance/gateway/events"],
  ])("%s %s: 401 with no key, and no data is read", async (method, url) => {
    const res = await request(app)[method](url).send({ events: [] });
    expect(res.status).toBe(401);
    expect(prisma.studentBleDevice.findMany).not.toHaveBeenCalled();
    expect(prisma.attendanceSession.findFirst).not.toHaveBeenCalled();
  });

  it("401 with a wrong secret", async () => {
    const bad = formatDeviceKey(1, generateSecret());
    const res = await request(app).get("/api/attendance/gateway/devices").set("X-Device-Key", bad);
    expect(res.status).toBe(401);
  });

  it("a TEACHER's JWT is not a gateway credential", async () => {
    const res = await request(app)
      .get("/api/attendance/gateway/devices")
      .set("Authorization", teacherAuth("Admin"));
    expect(res.status).toBe(401);
  });

  it("a gateway key is not a user credential: it can't reach teacher endpoints", async () => {
    for (const [method, url] of [
      ["get", "/api/attendance/session/current"],
      ["post", "/api/attendance/session/start"],
      ["get", "/api/students/1/ble-devices"],
      ["get", "/api/attendance?date=2026-09-20"],
    ]) {
      const res = await request(app)[method](url).set("X-Device-Key", KEY);
      expect(res.status).toBe(401);
    }
  });
});

describe("gateway endpoints — behaviour", () => {
  it("GET /devices returns only MAC strings (no student data)", async () => {
    prisma.studentBleDevice.findMany.mockResolvedValue([
      { deviceIdentifier: "D7:40:47:15:14:90" },
      { deviceIdentifier: "C9:FC:CB:E2:0D:33" },
    ]);
    const res = await request(app).get("/api/attendance/gateway/devices").set("X-Device-Key", KEY);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ devices: ["D7:40:47:15:14:90", "C9:FC:CB:E2:0D:33"] });
    const where = prisma.studentBleDevice.findMany.mock.calls[0][0].where;
    expect(where).toEqual({ enabled: true, student: { status: "active" } });
  });

  it("POST /events with no active session is accepted but ignored", async () => {
    const res = await request(app)
      .post("/api/attendance/gateway/events")
      .set("X-Device-Key", KEY)
      .send({ events: [{ deviceIdentifier: "D7:40:47:15:14:90", rssi: -50 }] });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ sessionActive: false, accepted: 0 });
    expect(prisma.studentBleDevice.findMany).not.toHaveBeenCalled();
  });

  it("POST /events during a session counts only registered tags; heartbeat works", async () => {
    prisma.attendanceSession.findFirst.mockResolvedValue({ id: 3, date: new Date() });
    prisma.studentBleDevice.findMany.mockResolvedValue([{ deviceIdentifier: "D7:40:47:15:14:90", studentId: 5 }]);

    const res = await request(app)
      .post("/api/attendance/gateway/events")
      .set("X-Device-Key", KEY)
      .send({ events: [
        { deviceIdentifier: "d7:40:47:15:14:90", rssi: -50 }, // lower-case -> normalised
        { deviceIdentifier: "AA:BB:CC:DD:EE:FF", rssi: -40 }, // not registered
      ] });
    expect(res.body).toEqual({ sessionActive: true, accepted: 1 });

    const beat = await request(app).post("/api/attendance/gateway/events").set("X-Device-Key", KEY).send({ events: [] });
    expect(beat.body).toEqual({ sessionActive: true, accepted: 0 });
  });

  it.each([
    ["no body", {}],
    ["events not an array", { events: "x" }],
    ["bad MAC", { events: [{ deviceIdentifier: "nope", rssi: -50 }] }],
    ["rssi out of range", { events: [{ deviceIdentifier: "D7:40:47:15:14:90", rssi: 30 }] }],
    ["rssi not an integer", { events: [{ deviceIdentifier: "D7:40:47:15:14:90", rssi: -50.5 }] }],
    ["rssi as string", { events: [{ deviceIdentifier: "D7:40:47:15:14:90", rssi: "-50" }] }],
    ["too many events", { events: Array.from({ length: 51 }, () => ({ deviceIdentifier: "D7:40:47:15:14:90", rssi: -50 })) }],
  ])("400s on invalid payload: %s", async (_l, body) => {
    const res = await request(app).post("/api/attendance/gateway/events").set("X-Device-Key", KEY).send(body);
    expect(res.status).toBe(400);
    expect(prisma.attendanceSession.findFirst).not.toHaveBeenCalled();
  });
});

describe("student BLE registry routes — access control", () => {
  it("401 without a token; 403 for Parent; allowed for Teacher", async () => {
    expect((await request(app).get("/api/students/5/ble-devices")).status).toBe(401);

    const parent = teacherAuth("Parent");
    for (const [method, url] of [
      ["get", "/api/students/5/ble-devices"],
      ["post", "/api/students/5/ble-devices"],
      ["patch", "/api/students/5/ble-devices/1"],
      ["delete", "/api/students/5/ble-devices/1"],
    ]) {
      expect((await request(app)[method](url).set("Authorization", parent)).status).toBe(403);
    }

    prisma.student.findUnique.mockResolvedValue({ id: 5 });
    const ok = await request(app).get("/api/students/5/ble-devices").set("Authorization", teacherAuth("Teacher"));
    expect(ok.status).toBe(200);
  });
});
