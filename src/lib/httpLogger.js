import pinoHttp from "pino-http";

// Request logging with the query string removed from what gets logged. File
// URLs carry their HMAC signature in ?exp=&sig=; there is no reason for those
// to sit in log storage. (Header redaction lives on the root logger — see
// logRedaction in ./logger.js.)
export function createHttpLogger(logger) {
  return pinoHttp({
    logger,
    autoLogging: { ignore: (req) => req.url === "/health" },
    serializers: {
      // pino-http passes the already standard-serialized request here.
      req: (serialized) => {
        const { query: _query, ...rest } = serialized;
        return { ...rest, url: String(serialized.url ?? "").split("?")[0] };
      },
    },
  });
}
