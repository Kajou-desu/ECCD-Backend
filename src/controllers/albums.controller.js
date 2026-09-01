import { prisma } from "../lib/prisma.js";

export async function getAlbums(_req, res, next) {
  try {
    const albums = await prisma.album.findMany({
      include: { photos: true },
      orderBy: { createdAt: "desc" },
    });
    res.json(albums);
  } catch (err) {
    next(err);
  }
}
