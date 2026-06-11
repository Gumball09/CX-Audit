/**
 * Seeds baseline data: the four team rubrics + an initial super_admin and a
 * couple of sample agents (so the agent_id -> team mapping resolves during a
 * demo). Safe to re-run — it overwrites these specific records.
 *
 *   npm run seed
 *
 * Change SUPER_ADMIN_EMAIL below (or via env) before running in a real env.
 */
import { putTeam } from "../src/db/teams.js";
import { putUser, newUserId, getUserByEmail } from "../src/db/users.js";
import { getPattern, putPattern } from "../src/db/patterns.js";
import { BUILTIN_PATTERN_SOURCE } from "../src/lib/filename.js";
import { hashPassword } from "../src/lib/password.js";
import type { RecordingPattern, TeamRubric, User } from "../src/types.js";

const BUILTIN_PATTERN_ID = "PAT-builtin";

const SUPER_ADMIN_EMAIL = process.env.SEED_SUPER_ADMIN_EMAIL ?? "shubh.mehrotra@scaler.com";
// Default password given to the seeded bootstrap accounts so you can log in
// immediately. Override via env; change it after first login. Accounts created
// later through the dashboard start password-less (self-service first-login).
const SEED_PASSWORD = process.env.SEED_PASSWORD ?? "Scaler@123";
const now = () => new Date().toISOString();

const rubrics: TeamRubric[] = [
  {
    team_id: "CS",
    name: "CS Standard Rubric",
    description: "Customer support quality baseline.",
    flag_threshold: 70,
    critical_criterion_threshold: 60,
    criteria: [
      { name: "Greeting", weight: 15, description: "Did the agent use the standard brand greeting and disclosure within 10 seconds?" },
      { name: "Empathy", weight: 25, description: "Did the agent acknowledge the customer's emotional state without interrupting?" },
      { name: "Resolution", weight: 30, description: "Was the customer's issue resolved on this call?" },
      { name: "Escalation Handling", weight: 15, description: "If escalation was warranted, was it offered and executed smoothly?" },
      { name: "Closing", weight: 15, description: "Did the agent confirm next steps and close professionally?" },
    ],
    system_prompt:
      "You are a senior CX quality auditor. Score the transcript against each criterion 0-100. Be strict but fair and cite specific transcript moments.",
    updated_at: now(),
    updated_by: null,
  },
  {
    team_id: "Escalations",
    name: "Escalations Rubric",
    description: "Prioritizes ownership and de-escalation over handle time.",
    flag_threshold: 70,
    critical_criterion_threshold: 60,
    criteria: [
      { name: "De-escalation", weight: 35, description: "Did the agent measurably reduce customer frustration during the call?" },
      { name: "Ownership", weight: 30, description: "Did the agent take full ownership rather than deflecting?" },
      { name: "SLA Adherence", weight: 15, description: "Was the escalation handled within SLA targets?" },
      { name: "Follow-up Commitment", weight: 20, description: "Was a specific, time-bound follow-up commitment made?" },
    ],
    system_prompt:
      "You are auditing an escalations call. Prioritize ownership and de-escalation. Quote the transcript to justify scores.",
    updated_at: now(),
    updated_by: null,
  },
  {
    team_id: "RM",
    name: "Relationship Manager Rubric",
    description: "Sales/relationship call quality.",
    flag_threshold: 70,
    critical_criterion_threshold: 60,
    criteria: [
      { name: "Discovery", weight: 30, description: "Did the agent uncover the customer's goals and context?" },
      { name: "Value Articulation", weight: 40, description: "Did the agent clearly connect the offering to the customer's needs?" },
      { name: "Objection Handling", weight: 30, description: "Were objections addressed honestly and effectively?" },
    ],
    system_prompt: "You are a sales quality auditor. Score the transcript 0-100 per criterion and justify with quotes.",
    updated_at: now(),
    updated_by: null,
  },
  {
    team_id: "OORP",
    name: "OORP Rubric",
    description: "Out-of-recovery-process call quality.",
    flag_threshold: 70,
    critical_criterion_threshold: 60,
    criteria: [
      { name: "Compliance", weight: 40, description: "Did the agent follow the required recovery script and disclosures?" },
      { name: "Clarity", weight: 30, description: "Were next steps and obligations explained clearly?" },
      { name: "Tone", weight: 30, description: "Was the agent firm yet respectful throughout?" },
    ],
    system_prompt: "You are auditing an OORP recovery call. Emphasize compliance and clarity. Cite the transcript.",
    updated_at: now(),
    updated_by: null,
  },
];

// Sample agents so agent_id -> team resolves in a demo. The first matches the
// example recording key in the spec (agent 495367).
const sampleAgents: Array<Pick<User, "name" | "email" | "team" | "agent_id">> = [
  { name: "Priya Menon", email: "priya@scaler.com", team: "CS", agent_id: "495367" },
  { name: "Rohit Sharma", email: "rohit@scaler.com", team: "RM", agent_id: "382910" },
  { name: "Karan Mehta", email: "karan@scaler.com", team: "Escalations", agent_id: "417823" },
];

async function seedUser(u: Partial<User> & { email: string; name: string; role: User["role"] }) {
  const existing = await getUserByEmail(u.email);
  // Preserve a password the account already has; otherwise seed the default so
  // bootstrap accounts can log in right away.
  const password_hash = existing?.password_hash ?? (await hashPassword(SEED_PASSWORD));
  const user: User = {
    user_id: existing?.user_id ?? newUserId(),
    email: u.email.toLowerCase(),
    name: u.name,
    role: u.role,
    team: u.team ?? null,
    agent_id: u.agent_id ?? null,
    status: "active",
    password_hash,
    created_at: existing?.created_at ?? now(),
    created_by: existing?.created_by ?? null,
    updated_at: now(),
  };
  await putUser(user);
  console.log(`✓ user ${user.email} (${user.role}${user.team ? ", " + user.team : ""})`);
}

async function seedBuiltinPattern() {
  const existing = await getPattern(BUILTIN_PATTERN_ID);
  const pattern: RecordingPattern = {
    pattern_id: BUILTIN_PATTERN_ID,
    label: "Scaler dialer (built-in)",
    regex: BUILTIN_PATTERN_SOURCE,
    flags: "i",
    priority: 1, // the default — tried first
    active: true,
    match_count: existing?.match_count ?? 0, // preserve usage across re-seeds
    is_builtin: true,
    created_by: existing?.created_by ?? null,
    created_at: existing?.created_at ?? now(),
    updated_at: now(),
  };
  await putPattern(pattern);
  console.log(`✓ recording pattern ${pattern.label}`);
}

async function main() {
  for (const r of rubrics) {
    await putTeam(r);
    console.log(`✓ rubric ${r.team_id}`);
  }
  await seedBuiltinPattern();
  await seedUser({ email: SUPER_ADMIN_EMAIL, name: "Platform Owner", role: "super_admin" });
  for (const a of sampleAgents) await seedUser({ ...a, role: "user" });
  console.log(`\nSeeded accounts have password: ${SEED_PASSWORD}  (change it after first login)`);
  console.log("Seed complete.");
}

main().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
