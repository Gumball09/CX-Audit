import type { Criterion } from "./types.js";

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

/** Validate a rubric's criteria array: non-empty, well-formed, weights sum to 100. */
export function validateCriteria(criteria: unknown): ValidationResult {
  const errors: string[] = [];

  if (!Array.isArray(criteria) || criteria.length === 0) {
    return { valid: false, errors: ["At least one criterion is required."] };
  }

  let sum = 0;
  (criteria as Criterion[]).forEach((c, i) => {
    if (!c || typeof c.name !== "string" || !c.name.trim()) {
      errors.push(`Criterion ${i}: name is required.`);
    }
    if (typeof c.weight !== "number" || c.weight < 0 || c.weight > 100) {
      errors.push(`Criterion ${i}: weight must be a number between 0 and 100.`);
    } else {
      sum += c.weight;
    }
    if (typeof c.description !== "string" || !c.description.trim()) {
      errors.push(`Criterion ${i}: description is required.`);
    }
  });

  if (sum !== 100) errors.push(`Criterion weights must sum to 100 (got ${sum}).`);

  return { valid: errors.length === 0, errors };
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export function isEmail(value: unknown): value is string {
  return typeof value === "string" && EMAIL_RE.test(value);
}
