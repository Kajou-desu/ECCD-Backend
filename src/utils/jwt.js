import jwt from "jsonwebtoken";

export function signToken(user) {
  // Only ever derive claims from a trusted DB record, never from client input.
  const payload = {
    id: user.id,
    email: user.email,
    role: user.role,
    tokenVersion: user.tokenVersion,
  };
  return jwt.sign(payload, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || "1d",
  });
}

export function verifyToken(token) {
  const decoded = jwt.verify(token, process.env.JWT_SECRET);

  // Defense in depth: even though the signature is verified, don't trust
  // the shape of the payload blindly.
  if (
    typeof decoded.id !== "number" ||
    typeof decoded.tokenVersion !== "number" ||
    typeof decoded.role !== "string"
  ) {
    throw new Error("Malformed token payload");
  }

  return decoded;
}
