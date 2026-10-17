import { recordActivity } from "../services/activityLog.service.js";
import { logger } from "../lib/logger.js";

// Records an activity log entry for a request that SUCCEEDED (2xx). Put it on
// the route after the auth and role middleware, so only requests that were
// allowed are ever logged and req.user is set:
//
//   router.delete("/:id", requireRole("Admin"), audit("student.delete", {
//     target: "student",
//     snapshot: (req) => prisma.student.findUnique(...),   // optional, read BEFORE the handler runs
//     describe: (req, body, before) => `Deleted student ${before?.name ?? ""}`,
//   }), deleteStudent);
//
//   describe(req, responseBody, snapshot) -> the sentence stored (never include
//   passwords, tokens or OTP codes). Return a falsy value to skip logging.
//   actor: "detached" when the request deletes the signed-in account itself.
//   actor: "response" for the sign-in route, where nobody is authenticated yet
//   and the signed-in user is in the response.
export function audit(action, { target = null, describe, snapshot, actor = "request" } = {}) {
  return async (req, res, next) => {
    let before;
    if (snapshot) {
      try {
        before = await snapshot(req);
      } catch (err) {
        logger.warn({ err, action }, "Could not read the state before an audited change");
      }
    }

    let responseBody;
    const json = res.json.bind(res);
    res.json = (payload) => {
      responseBody = payload;
      return json(payload);
    };

    res.on("finish", () => {
      if (res.statusCode < 200 || res.statusCode >= 300) return;
      try {
        let who = actor === "response" ? responseBody?.user : req.user;
        // "detached": the account the request acted as no longer exists, so the
        // entry keeps its email/role but can't point at the (deleted) user row.
        if (actor === "detached" && who) who = { ...who, id: null };
        const summary = describe?.(req, responseBody, before);
        if (!who || !summary) return;

        const fromParams = Number.parseInt(req.params?.id, 10);
        const targetId = Number.isInteger(fromParams) ? fromParams : responseBody?.id;
        void recordActivity({ actor: who, action, targetType: target, targetId, summary });
      } catch (err) {
        logger.error({ err, action }, "Could not build an activity log entry");
      }
    });

    next();
  };
}
