import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";

process.env.JWT_SECRET = "test-secret-at-least-32-characters-long";
process.env.CLIENT_ORIGIN = "http://localhost:5173";

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    $queryRaw: vi.fn(),
    user: { findUnique: vi.fn() },
    bleGateway: { findUnique: vi.fn(), update: vi.fn() },
    attendanceSession: { findMany: vi.fn() },
    studentBleDevice: { findMany: vi.fn() },
    student: { findUnique: vi.fn() },
  },
}));

vi.mock("../src/services/attendanceVerification.service.js", () => ({
  recordSignal: vi.fn().mockResolvedValue({ state: "pending" }),
}));

const { prisma } = await import("../src/lib/prisma.js");
const { recordSignal } = await import("../src/services/attendanceVerification.service.js");
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
  prisma.attendanceSession.findMany.mockResolvedValue([]);
  prisma.studentBleDevice.findMany.mockResolvedValue([]);
});

// A tag row as the registry query returns it: the tag, its student, and that student's center.
const tag = (deviceIdentifier, studentId, centerId = null) => ({
  deviceIdentifier,
  studentId,
  student: { teacher: centerId === null ? null : { centerId } },
});

describe("gateway endpoints — authentication", () => {
  it.each([
    ["get", "/api/attendance/gateway/devices"],
    ["post", "/api/attendance/gateway/events"],
  ])("%s %s: 401 with no key, and no data is read", async (method, url) => {
    const res = await request(app)[method](url).send({ events: [] });
    expect(res.status).toBe(401);
    expect(prisma.studentBleDevice.findMany).not.toHaveBeenCalled();
    expect(prisma.attendanceSession.findMany).not.toHaveBeenCalled();
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
    expect(recordSignal).not.toHaveBeenCalled();
  });

  it("POST /events during a session counts only registered tags; heartbeat works", async () => {
    const sessionDate = new Date("2026-09-20T00:00:00.000Z");
    prisma.attendanceSession.findMany.mockResolvedValue([{ id: 3, date: sessionDate, centerId: null }]);
    prisma.studentBleDevice.findMany.mockResolvedValue([tag("D7:40:47:15:14:90", 5)]);

    const res = await request(app)
      .post("/api/attendance/gateway/events")
      .set("X-Device-Key", KEY)
      .send({ events: [
        { deviceIdentifier: "d7:40:47:15:14:90", rssi: -50 }, // lower-case -> normalised
        { deviceIdentifier: "AA:BB:CC:DD:EE:FF", rssi: -40 }, // not registered
      ] });
    expect(res.body).toEqual({ sessionActive: true, accepted: 1 });

    // Only the registered tag reaches verification, as a BLE signal for the
    // student the SERVER's registry maps it to (the gateway never names one).
    expect(recordSignal).toHaveBeenCalledTimes(1);
    expect(recordSignal).toHaveBeenCalledWith({
      sessionId: 3, sessionDate, studentId: 5, kind: "ble", value: -50,
    });

    vi.mocked(recordSignal).mockClear();
    const beat = await request(app).post("/api/attendance/gateway/events").set("X-Device-Key", KEY).send({ events: [] });
    expect(beat.body).toEqual({ sessionActive: true, accepted: 0 });
    expect(recordSignal).not.toHaveBeenCalled(); // a heartbeat records nothing
  });

  describe("sessions are per center", () => {
    const date = new Date("2026-09-20T00:00:00.000Z");
    const post = (events) =>
      request(app).post("/api/attendance/gateway/events").set("X-Device-Key", KEY).send({ events });
    const sightings = [
      { deviceIdentifier: "D7:40:47:15:14:90", rssi: -50 }, // student 5, center 1
      { deviceIdentifier: "C9:FC:CB:E2:0D:33", rssi: -55 }, // student 6, center 2
    ];
    beforeEach(() => {
      prisma.studentBleDevice.findMany.mockResolvedValue([
        tag("D7:40:47:15:14:90", 5, 1),
        tag("C9:FC:CB:E2:0D:33", 6, 2),
      ]);
    });

    it("feeds each tag into the session of ITS student's center", async () => {
      prisma.attendanceSession.findMany.mockResolvedValue([
        { id: 3, date, centerId: 1 },
        { id: 4, date, centerId: 2 },
      ]);
      const res = await post(sightings);
      expect(res.body).toEqual({ sessionActive: true, accepted: 2 });
      const sessionOf = Object.fromEntries(recordSignal.mock.calls.map(([a]) => [a.studentId, a.sessionId]));
      expect(sessionOf).toEqual({ 5: 3, 6: 4 });
    });

    it("ignores a tag whose center has no session running, without affecting the others", async () => {
      prisma.attendanceSession.findMany.mockResolvedValue([{ id: 3, date, centerId: 1 }]);
      const res = await post(sightings);
      expect(res.body).toEqual({ sessionActive: true, accepted: 1 });
      expect(recordSignal).toHaveBeenCalledTimes(1);
      expect(recordSignal.mock.calls[0][0]).toMatchObject({ studentId: 5, sessionId: 3 });
    });

    it("a student with no center only counts for the 'no center' session", async () => {
      prisma.studentBleDevice.findMany.mockResolvedValue([tag("D7:40:47:15:14:90", 5)]); // no teacher/center
      prisma.attendanceSession.findMany.mockResolvedValue([{ id: 3, date, centerId: 1 }]);
      expect((await post(sightings)).body).toEqual({ sessionActive: true, accepted: 0 });
      expect(recordSignal).not.toHaveBeenCalled();
    });

    it("tells the gateway a session is running if ANY center has one", async () => {
      prisma.attendanceSession.findMany.mockResolvedValue([{ id: 4, date, centerId: 2 }]);
      const beat = await post([]);
      expect(beat.body).toEqual({ sessionActive: true, accepted: 0 });
    });
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
    expect(prisma.attendanceSession.findMany).not.toHaveBeenCalled();
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

    // teacherId: 9 matches the Teacher JWT's user id (teacherAuth), so the
    // ownership check (a Teacher may only manage their own connected
    // students) allows this request.
    prisma.student.findUnique.mockResolvedValue({ id: 5, teacherId: 9 });
    const ok = await request(app).get("/api/students/5/ble-devices").set("Authorization", teacherAuth("Teacher"));
    expect(ok.status).toBe(200);
  });
});
