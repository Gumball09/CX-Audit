import bcrypt from "bcryptjs";

// Cost factor for bcrypt. 10 is a sensible default for an internal tool: strong
// enough against offline attacks, cheap enough not to stall logins.
const SALT_ROUNDS = 10;

/** Hash a plaintext password for storage. */
export function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, SALT_ROUNDS);
}

/** Verify a plaintext password against a stored bcrypt hash. */
export function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}
