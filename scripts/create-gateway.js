// Registers an ESP32 BLE gateway and prints its key ONCE.
//   npm run gateway:create -- "Front door"
// Only a SHA-256 hash of the key is stored, so a lost key cannot be recovered —
// disable the gateway (enabled = false) and create a new one instead.
import "dotenv/config";
import { prisma } from "../src/lib/prisma.js";
import { generateSecret, hashSecret, formatDeviceKey } from "../src/utils/deviceKey.js";

const name = process.argv.slice(2).join(" ").trim();

async function main() {
  if (!name || name.length > 100) {
    console.error('Usage: npm run gateway:create -- "<gateway name, max 100 chars>"');
    process.exitCode = 1;
    return;
  }

  const secret = generateSecret();
  const gateway = await prisma.bleGateway.create({ data: { name, keyHash: hashSecret(secret) } });

  console.log(`Created gateway #${gateway.id} "${gateway.name}".`);
  console.log(`DEVICE_KEY: ${formatDeviceKey(gateway.id, secret)}`);
  console.log("SAVE THIS KEY — it will not be shown again. Put it in the firmware's secrets.h; never commit it.");
}

main()
  .catch((err) => {
    console.error("Failed to create gateway:", err.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
