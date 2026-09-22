-- CreateTable: student_ble_devices — BLE tags registered to students.
-- deviceIdentifier is globally unique: one tag identifies exactly one student.
CREATE TABLE "student_ble_devices" (
    "id" SERIAL NOT NULL,
    "studentId" INTEGER NOT NULL,
    "deviceIdentifier" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "registeredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "student_ble_devices_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "student_ble_devices_deviceIdentifier_key" ON "student_ble_devices"("deviceIdentifier");

CREATE INDEX "student_ble_devices_studentId_idx" ON "student_ble_devices"("studentId");

ALTER TABLE "student_ble_devices" ADD CONSTRAINT "student_ble_devices_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "students"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable: ble_gateways — ESP32 gateways allowed to post BLE sightings.
-- Only a hash of each gateway's key is stored.
CREATE TABLE "ble_gateways" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "keyHash" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3),

    CONSTRAINT "ble_gateways_pkey" PRIMARY KEY ("id")
);
