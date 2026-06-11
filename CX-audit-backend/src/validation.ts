import type { Criterion } from "./types.js";

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * Validate a rubric's criteria array (flexible rubric — weights need NOT sum to
 * 100). Rules: non-empty; each criterion has a name and a description; any
 * supplied weight / critical_threshold is a sane number. Weights are *relative*
 * and normalized at scoring time (see `normalizeWeights`), so admins can use
 * 1/2/3, 10/20/70, or leave them off entirely for equal weighting.
 */
export function validateCriteria(criteria: unknown): ValidationResult {
  const errors: string[] = [];

  if (!Array.isArray(criteria) || criteria.length === 0) {
    return { valid: false, errors: ["At least one criterion is required."] };
  }

  (criteria as Criterion[]).forEach((c, i) => {
    if (!c || typeof c.name !== "string" || !c.name.trim()) {
      errors.push(`Criterion ${i}: name is required.`);
    }
    if (typeof c.description !== "string" || !c.description.trim()) {
      errors.push(`Criterion ${i}: description is required.`);
    }
    if (c?.weight !== undefined && (typeof c.weight !== "number" || c.weight < 0 || !Number.isFinite(c.weight))) {
      errors.push(`Criterion ${i}: weight, if set, must be a non-negative number.`);
    }
    if (
      c?.critical_threshold !== undefined &&
      (typeof c.critical_threshold !== "number" || c.critical_threshold < 0 || !Number.isFinite(c.critical_threshold))
    ) {
      errors.push(`Criterion ${i}: critical_threshold, if set, must be a non-negative number.`);
    }
  });

  // A degenerate all-zero weighting can't be normalized; equal-weight it instead
  // (handled in normalizeWeights), so this is a warning-level concern, not fatal.
  return { valid: errors.length === 0, errors };
}

/**
 * Turn a rubric's relative weights into fractions that sum to 1. Criteria with
 * no weight (or all-zero weights) fall back to equal weighting. Used by the
 * auditor so the overall score is a correct weighted average regardless of how
 * the admin entered the weights.
 */
export function normalizeWeights(criteria: Criterion[]): number[] {
  if (criteria.length === 0) return [];
  const raw = criteria.map((c) => (typeof c.weight === "number" && c.weight > 0 ? c.weight : 0));
  const total = raw.reduce((s, w) => s + w, 0);
  if (total <= 0) return criteria.map(() => 1 / criteria.length); // equal weighting
  return raw.map((w) => w / total);
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export function isEmail(value: unknown): value is string {
  return typeof value === "string" && EMAIL_RE.test(value);
}

/** Minimum password length for the self-service set-password flow. */
export const MIN_PASSWORD_LENGTH = 8;

/** A login password must be a string of at least MIN_PASSWORD_LENGTH chars. */
export function isValidPassword(value: unknown): value is string {
  return typeof value === "string" && value.length >= MIN_PASSWORD_LENGTH;
}
