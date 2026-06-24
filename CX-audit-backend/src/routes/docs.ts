import { Router, type Request, type Response, type NextFunction } from "express";
import swaggerUi from "swagger-ui-express";
import jwt from "jsonwebtoken";
import { env } from "../env.js";
import { logger } from "../logger.js";
import { getUser } from "../db/users.js";
import { openapiSpec } from "../lib/openapi.js";

/**
 * Swagger UI for the API, served at /api/docs (raw spec at /api/docs/openapi.json).
 *
 * Access: open in non-production; in production it requires a **super_admin**
 * JWT. A browser can't send an Authorization header on navigation, so the token
 * is also accepted via `?token=<JWT>` (or a Bearer header for tooling).
 */
export const docsRouter = Router();

// Swagger UI injects inline scripts/styles; relax the global helmet CSP for
// these routes only (the API itself keeps the strict default).
docsRouter.use((_req: Request, res: Response, next: NextFunction) => {
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' data:"
  );
  next();
});

// Access gate.
docsRouter.use(async (req: Request, res: Response, next: NextFunction) => {
  if (env.NODE_ENV !== "production") return next(); // open in dev/staging

  const header = req.headers.authorization ?? "";
  const bearer = header.startsWith("Bearer ") ? header.slice(7) : null;
  const token = bearer || (typeof req.query.token === "string" ? req.query.token : null);
  if (!token) {
    return res
      .status(401)
      .type("text/plain")
      .send("API docs require a super_admin token. Append ?token=<JWT> to the URL (get one from the dashboard).");
  }
  try {
    const payload = jwt.verify(token, env.JWT_SECRET) as { sub: string };
    const user = await getUser(payload.sub);
    if (!user || user.status !== "active" || user.role !== "super_admin") {
      return res.status(403).type("text/plain").send("API docs are restricted to super_admins.");
    }
    return next();
  } catch (err) {
    logger.debug("Docs auth failed", err);
    return res.status(401).type("text/plain").send("Invalid or expired token.");
  }
});

docsRouter.get("/openapi.json", (_req, res) => res.json(openapiSpec));
docsRouter.use(
  "/",
  swaggerUi.serve,
  swaggerUi.setup(openapiSpec as unknown as Record<string, unknown>, {
    customSiteTitle: "CX Audit API",
    swaggerOptions: { persistAuthorization: true },
  })
);
