import bcrypt from "bcryptjs";
import { prisma } from "./src/lib/prisma.js";

const EMAIL = "admin@school.com";
const PASSWORD = "ChangeMe123!";

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
    console.log("Log in once, then change this password immediately.");
}

main()
    .catch((err) => {
        console.error("Seed failed:", err);
        process.exitCode = 1;
    })
    .finally(async () => {
        await prisma.$disconnect();
    });