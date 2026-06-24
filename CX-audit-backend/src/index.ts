import express, { type Request, type Response, type NextFunction } from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { randomUUID } from "crypto";
import { env, validateEnv } from "./env.js";
import { logger } from "./logger.js";
import { initSentry, reportError } from "./lib/sentry.js";
import { authenticate } from "./services/auth.js";
import { authRouter } from "./routes/auth.js";
import { usersRouter } from "./routes/users.js";
import { teamsRouter } from "./routes/teams.js";
import { auditsRouter } from "./routes/audits.js";
import { patternsRouter } from "./routes/patterns.js";
import { performanceRouter } from "./routes/performance.js";
import { settingsRouter } from "./routes/settings.js";
import { rubricsRouter } from "./routes/rubrics.js";
import { feedbackRouter } from "./routes/feedback.js";
import { suggestionsRouter } from "./routes/suggestions.js";
import { loginStatsRouter } from "./routes/loginStats.js";
import { docsRouter } from "./routes/docs.js";

validateEnv("api");
initSentry("api");

const app = express();
if (env.TRUST_PROXY) app.set("trust proxy", 1);

app.use(helmet());
app.use(cors({ origin: env.CORS_ORIGIN === "*" ? true : env.CORS_ORIGIN.split(",") }));
app.use(express.json({ limit: "1mb" }));

// Correlation id for tracing a request across logs + error responses.
app.use((req: Request, res: Response, next: NextFunction) => {
  req.id = (req.headers["x-request-id"] as string) || randomUUID();
  res.setHeader("x-request-id", req.id);
  const start = Date.now();
  res.on("finish", () => logger.request(req.method, req.path, res.statusCode, Date.now() - start));
  next();
});

// Rate limiting: a generous global cap, plus a strict cap on auth to blunt
// credential stuffing / abuse.
const globalLimiter = rateLimit({ windowMs: 15 * 60_000, max: 600, standardHeaders: true, legacyHeaders: false });
const authLimiter = rateLimit({ windowMs: 15 * 60_000, max: 20, standardHeaders: true, legacyHeaders: false });
app.use("/api", globalLimiter);

// ---- Public routes ----
app.get("/api/health", (_req, res) =>
  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    s3_configured: !!env.S3_RECORDING_BUCKET,
    sqs_configured: !!env.SQS_TRANSCRIPTION_QUEUE_URL && !!env.SQS_AUDIT_QUEUE_URL,
    openai_configured: !!env.OPENAI_API_KEY,
    sentry_configured: !!env.SENTRY_DSN,
  })
);
app.use("/api/auth", authLimiter, authRouter);

// API docs (Swagger UI). Self-gates: open in dev, super_admin-only in prod.
app.use("/api/docs", docsRouter);

// ---- Authenticated routes ----
app.use("/api/users", authenticate, usersRouter);
app.use("/api/teams", authenticate, teamsRouter);
app.use("/api/audits", authenticate, auditsRouter);
app.use("/api/patterns", authenticate, patternsRouter);
app.use("/api/performance", authenticate, performanceRouter);
app.use("/api/settings", authenticate, settingsRouter);
app.use("/api/rubrics", authenticate, rubricsRouter);
app.use("/api/feedback", authenticate, feedbackRouter);
app.use("/api/suggestions", authenticate, suggestionsRouter);
app.use("/api/login-stats", authenticate, loginStatsRouter);

// 404 + error handlers.
app.use((req: Request, res: Response) =>
  res.status(404).json({ message: `Not found: ${req.method} ${req.path}` })
);
app.use((err: Error, req: Request, res: Response, _next: NextFunction) => {
  logger.error(`Unhandled error on ${req.method} ${req.path} [${req.id}]`, err);
  reportError(err, { where: `api ${req.method} ${req.path}`, extra: { request_id: req.id } });
  // Never leak internals in production; the request id ties the response to logs.
  const body =
    env.NODE_ENV === "production"
      ? { message: "Internal server error", request_id: req.id }
      : { message: "Internal server error", error: err.message, request_id: req.id };
  res.status(500).json(body);
});

const server = app.listen(env.PORT, () => {
  logger.info(`CX Audit API listening at http://localhost:${env.PORT}`);
  logger.info(`Environment: ${env.NODE_ENV}, Log level: ${env.LOG_LEVEL}`);
});

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    logger.info(`${sig} received, shutting down`);
    server.close(() => process.exit(0));
  });
}
