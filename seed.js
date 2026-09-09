import bcrypt from "bcryptjs";
import crypto from "node:crypto";
import { prisma } from "./src/lib/prisma.js";

const EMAIL = "admin@school.com";
const PASSWORD = process.env.ADMIN_SEED_PASSWORD || crypto.randomBytes(16).toString("hex");

async function main() {
    const existing = await prisma.user.findUnique({ where: { email: EMAIL } });
    if (existing) {
        console.log(`User ${EMAIL} already exists — nothing to do.`);
        return;
    }

    const passwordHash = await bcrypt.hash(PASSWORD, 10);
    await prisma.user.create({
        data: {
            email: EMAIL,
            passwordHash,
            name: "Admin",
            role: "Admin",
        },
    });

    console.log(`Seeded ${EMAIL} / ${PASSWORD}`);
    console.log("SAVE THIS PASSWORD — it will not be shown again. Log in once, then change it immediately.");
}

main()
    .catch((err) => {
        console.error("Seed failed:", err);
        process.exitCode = 1;
    })
    .finally(async () => {
        await prisma.$disconnect();
    });