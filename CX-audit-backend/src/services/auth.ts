import jwt from "jsonwebtoken";
import type { Request, Response, NextFunction } from "express";
import { env } from "../env.js";
import { logger } from "../logger.js";
import { getUser } from "../db/users.js";
import type { Role, User } from "../types.js";

interface JwtPayload {
  sub: string; // user_id
  role: Role;
}

export function signToken(user: User): string {
  const payload: JwtPayload = { sub: user.user_id, role: user.role };
  return jwt.sign(payload, env.JWT_SECRET, { expiresIn: env.JWT_EXPIRES_IN } as jwt.SignOptions);
}

/**
 * Strip the password hash before a user record is returned to a client.
 * Every response that includes a user MUST pass it through this first.
 */
export function publicUser(user: User): Omit<User, "password_hash"> {
  const { password_hash: _omit, ...rest } = user;
  return rest;
}

// Augment Express request with the authenticated user.
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: User;
      id?: string;
    }
  }
}

/**
 * Verifies the Bearer token and loads the current user from DynamoDB (so role
 * changes / deactivation take effect immediately rather than at token expiry).
 */
export async function authenticate(req: Request, res: Response, next: NextFunction) {
  try {
    const header = req.headers.authorization ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : null;
    if (!token) return res.status(401).json({ message: "Missing bearer token." });

    const payload = jwt.verify(token, env.JWT_SECRET) as JwtPayload;
    const user = await getUser(payload.sub);
    if (!user) return res.status(401).json({ message: "User no longer exists." });
    if (user.status !== "active") return res.status(403).json({ message: "Account is inactive." });

    req.user = user;
    next();
  } catch (err) {
    logger.debug("Authentication failed", err);
    return res.status(401).json({ message: "Invalid or expired token." });
  }
}

/** Guard requiring one of the listed roles. */
export function requireRole(...roles: Role[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return res.status(401).json({ message: "Not authenticated." });
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ message: "Insufficient permissions." });
    }
    next();
  };
}
