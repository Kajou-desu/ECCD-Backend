import { prisma } from "../lib/prisma.js";

export async function getDashboardStats(_req, res, next) {
  try {
    const today = new Date();
    const todayDate = new Date(Date.UTC(today.getFullYear(), today.getMonth(), today.getDate()));

    const [totalStudents, presentToday, absentToday, totalMaterials] = await Promise.all([
      prisma.student.count(),
      prisma.attendance.count({ where: { date: todayDate, status: "present" } }),
      prisma.attendance.count({ where: { date: todayDate, status: "absent" } }),
      prisma.material.count(),
    ]);

    res.json({ totalStudents, presentToday, absentToday, totalMaterials });
  } catch (err) {
    next(err);
  }
}

export async function getDailyTheme(_req, res, next) {
  try {
    const today = new Date();
    const todayDate = new Date(Date.UTC(today.getFullYear(), today.getMonth(), today.getDate()));

    const theme = await prisma.dailyTheme.findUnique({ where: { date: todayDate } });
    res.json(theme ?? { date: todayDate, theme: null });
  } catch (err) {
    next(err);
  }
}
