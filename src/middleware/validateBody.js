// Generic request validation middleware backed by Zod schemas.
//
// Scope note: this project's existing controllers already validate input
// via src/utils/validate.js (manual, regex-based checks) — the audit itself
// calls that pattern out as a strength (strict, centralized, type-checked).
// Rather than rewrite that working validation, this middleware is applied
// to routes as they're touched going forward, starting with auth (below).
// Migrating the remaining controllers is optional follow-up work, not a
// bug fix — see the audit report for the recommended pattern.
export function validateBody(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      return res.status(400).json({
        message: "Invalid input",
        errors: result.error.flatten().fieldErrors,
      });
    }
    req.body = result.data;
    next();
  };
}
