import { verifyToken } from "../utils/jwt.js";
import { prisma } from "../lib/prisma.js";

export async function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  const token = header?.startsWith("Bearer ") ? header.slice(7) : null;

  if (!token) {
    return res.status(401).json({ message: "Missing or invalid token" });
  }

  try {
    const decoded = verifyToken(token);

    // Re-check the account on every request instead of trusting the token's
    // claims for its whole lifetime. This makes revocation immediate:
    // - password reset / logout-all bumps tokenVersion -> old tokens rejected
    // - a disabled account (isActive=false) is blocked right away
    // - a role change takes effect on the very next request, not after
    //   the old token happens to expire
    const user = await prisma.user.findUnique({
      where: { id: decoded.id },
      select: { id: true, email: true, role: true, isActive: true, tokenVersion: true },
    });

    if (!user || !user.isActive || user.tokenVersion !== decoded.tokenVersion) {
      return res.status(401).json({ message: "Invalid or expired token" });
    }

    // req.user reflects the CURRENT database state, not stale token claims.
    req.user = { id: user.id, email: user.email, role: user.role };
    next();
  } catch {
    return res.status(401).json({ message: "Invalid or expired token" });
  }
}

export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ message: "Forbidden" });
    }
    next();
  };
}
