// AppError: use this for any error whose message is SAFE to show the user
// (e.g. "Invalid input", "Not found"). Anything else is treated as internal
// and never exposed, per the "generic errors to client, details server-side
// only" rule.
export class AppError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
    this.expose = true;
  }
}

export function notFoundHandler(_req, res) {
  res.status(404).json({ message: "Not found" });
}

export function errorHandler(err, _req, res, _next) {
  // Full detail (stack, Prisma internals, etc.) goes to server logs only.
  console.error(err);

  if (err.expose) {
    return res.status(err.status || 400).json({ message: err.message });
  }

  if (err.name === "MulterError") {
    return res.status(400).json({ message: "File upload error" });
  }

  // Default: never leak stack traces, Prisma error text, file paths, or
  // framework names to the client.
  res.status(500).json({ message: "Something went wrong" });
}
