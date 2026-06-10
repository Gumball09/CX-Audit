import { Router } from "express";
import { logger } from "../logger.js";
import { isEmail } from "../validation.js";
import { getUserByEmail } from "../db/users.js";
import { signToken, authenticate } from "../services/auth.js";

export const authRouter = Router();

/**
 * POST /api/auth/login  { email }
 *
 * Email-only login against the Users table (matches the existing dashboard
 * flow). Returns a JWT + the user record. Swap in a password/SSO check here
 * when ready — the rest of the stack only depends on the issued token.
 */
authRouter.post("/login", async (req, res) => {
  const { email } = req.body as { email?: string };
  if (!isEmail(email)) return res.status(400).json({ message: "A valid email is required." });

  const user = await getUserByEmail(email);
  if (!user || user.status !== "active") {
    logger.warn(`Login rejected for ${email}`);
    return res.status(401).json({ message: "Email not recognized or inactive." });
  }

  return res.json({ token: signToken(user), user });
});

/** GET /api/auth/me — the currently authenticated user. */
authRouter.get("/me", authenticate, (req, res) => res.json(req.user));
