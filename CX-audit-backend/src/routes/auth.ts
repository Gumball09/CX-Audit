import { Router } from "express";
import { logger } from "../logger.js";
import { isEmail, isValidPassword, MIN_PASSWORD_LENGTH } from "../validation.js";
import { getUserByEmail, setUserPassword } from "../db/users.js";
import { signToken, authenticate, publicUser } from "../services/auth.js";
import { hashPassword, verifyPassword } from "../lib/password.js";

export const authRouter = Router();

/**
 * POST /api/auth/login  { email, password? }
 *
 * Self-service first-login model:
 *  - Unknown / inactive email                  -> 401
 *  - Known email with NO password set yet      -> 200 { needs_password_setup: true }
 *      (the client then calls /set-password to choose one)
 *  - Known email WITH a password               -> verify; 200 { token, user } or 401
 */
authRouter.post("/login", async (req, res) => {
  const { email, password } = req.body as { email?: string; password?: string };
  if (!isEmail(email)) return res.status(400).json({ message: "A valid email is required." });

  const user = await getUserByEmail(email);
  if (!user || user.status !== "active") {
    logger.warn(`Login rejected for ${email}`);
    return res.status(401).json({ message: "Email not recognized or inactive." });
  }

  // First login: no password chosen yet. Tell the client to set one.
  if (!user.password_hash) {
    return res.json({ needs_password_setup: true });
  }

  if (!password) return res.status(400).json({ message: "Password is required." });
  const ok = await verifyPassword(password, user.password_hash);
  if (!ok) {
    logger.warn(`Bad password for ${email}`);
    return res.status(401).json({ message: "Incorrect email or password." });
  }

  return res.json({ token: signToken(user), user: publicUser(user) });
});

/**
 * POST /api/auth/set-password  { email, password }
 *
 * Self-service first-login: lets a known, active, password-less user choose
 * their initial password and signs them in. Refuses if a password already
 * exists (a reset must go through an admin, not this open endpoint).
 */
authRouter.post("/set-password", async (req, res) => {
  const { email, password } = req.body as { email?: string; password?: string };
  if (!isEmail(email)) return res.status(400).json({ message: "A valid email is required." });
  if (!isValidPassword(password)) {
    return res.status(400).json({ message: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.` });
  }

  const user = await getUserByEmail(email);
  if (!user || user.status !== "active") {
    return res.status(401).json({ message: "Email not recognized or inactive." });
  }
  if (user.password_hash) {
    return res.status(409).json({ message: "A password is already set. Ask an admin to reset it." });
  }

  const hash = await hashPassword(password);
  const updated = await setUserPassword(user.user_id, hash);
  const fresh = updated ?? { ...user, password_hash: hash };
  logger.info(`Password set (first login) for ${email}`);
  return res.json({ token: signToken(fresh), user: publicUser(fresh) });
});

/** GET /api/auth/me — the currently authenticated user. */
authRouter.get("/me", authenticate, (req, res) => res.json(publicUser(req.user!)));
