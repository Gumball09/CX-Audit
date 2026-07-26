import type { GuideSignal } from "./guideBus";

/**
 * Guided tours ("coach marks") for the dashboard.
 *
 * Guides live here, versioned with the UI they describe, so a step can never
 * reference an element that does not exist in this build. Each step names a
 * `data-guide` anchor; the tour engine finds it, spotlights it, and explains it.
 *
 * Roles are hierarchical — user < admin < super_admin — and apply at two levels:
 *   - `Guide.perms` gates whether the guide is offered at all;
 *   - `GuideStep.perms` gates individual steps, which matters because a page can
 *     be admin-visible while some controls inside it are super_admin-only.
 * Steps above the viewer's rank are removed before the tour starts, so the
 * "Step N of M" counter always reflects what that person will actually see.
 */

/** Sidebar views. Declared here (not in DashboardShell) so guides can name a
 *  destination without the lib importing from components. */
export type View =
  | "calls"
  | "performance"
  | "users"
  | "teams"
  | "patterns"
  | "bulk"
  | "signins"
  | "settings";

export type GuideRole = "user" | "admin" | "super_admin";

/** Rank for the hierarchy. A viewer sees their own tier and everything below. */
const RANK: Record<GuideRole, number> = { user: 0, admin: 1, super_admin: 2 };

export interface GuideStep {
  /** `data-guide` value to spotlight. Omit for a centered, anchorless step. */
  anchor?: string;
  /** Switch to this sidebar view before showing the step. */
  view?: View;
  /** Ask the view to reveal a collapsed section before measuring the anchor. */
  signal?: GuideSignal;
  title: string;
  body: string;
  /** Preferred tooltip side; the engine flips it when there isn't room. */
  placement?: "top" | "bottom" | "left" | "right";
  /** Minimum role for this step. Defaults to the guide's own `perms`. */
  perms?: GuideRole;
  /**
   * Skip silently when the anchor isn't on screen. Use for anything that only
   * exists in a particular state — an empty criteria list, a team with no
   * additional rubrics, the read-only banner, an error message.
   */
  optional?: boolean;
}

export interface Guide {
  id: string;
  name: string;
  description: string;
  /** Minimum role required to be offered this guide. */
  perms: GuideRole;
  steps: GuideStep[];
}

// ---------------------------------------------------------------------------
// Team Rubrics — exhaustive coverage, split into chapters so nobody has to sit
// through 40 steps to learn one field.
// ---------------------------------------------------------------------------

const TEAMS_AND_CREATION: Guide = {
  id: "rubrics-teams",
  name: "Choosing and creating teams",
  description: "The Teams sidebar, what the badges mean, and creating a new team.",
  perms: "admin",
  steps: [
    {
      view: "teams",
      anchor: "nav-teams",
      placement: "right",
      title: "Team Rubrics",
      body:
        "Everything about how a team's calls get scored lives here — the criteria, the thresholds, and how many calls per agent get audited each day.",
    },
    {
      anchor: "teams-panel",
      placement: "right",
      title: "Your teams",
      body: "Every team you can see is listed here. Selecting one loads its rubric in the editor on the right.",
    },
    {
      anchor: "teams-list",
      placement: "right",
      title: "Reading the list",
      body:
        "Each row shows the display name, then the team id and whether you can edit it. Admins can edit only their own team; super-admins can edit any. An 'off' badge means the team is inactive and its queue isn't polled. An 'infra' badge means it has its own buckets and queues rather than the shared defaults.",
    },
    {
      anchor: "teams-new",
      placement: "bottom",
      title: "Creating a team",
      body: "Super-admins can add a team here. It starts with a single placeholder criterion that you then shape.",
      perms: "super_admin",
    },
    {
      anchor: "teams-new-id",
      signal: "open-new-team-form",
      placement: "right",
      title: "Team id",
      body:
        "The slug — letters, digits, dash, underscore. This is the DynamoDB key and the value stored on every user and audit, so it can't be changed afterwards. Pick carefully.",
      perms: "super_admin",
    },
    {
      anchor: "teams-new-name",
      placement: "right",
      title: "Display name",
      body: "What people see in the UI. Unlike the id, this is safe to change later. Leave it blank to reuse the id.",
      perms: "super_admin",
    },
    {
      anchor: "teams-new-create",
      placement: "right",
      title: "Create",
      body:
        "Creates the team and selects it. New teams start with a daily audit cap of 3 — deliberately capped rather than unlimited, so a new team can't run up an open-ended bill. Set its buckets and queues afterwards under Infrastructure.",
      perms: "super_admin",
    },
  ],
};

const RUBRIC_BASICS: Guide = {
  id: "rubrics-basics",
  name: "Rubric basics and thresholds",
  description: "Name, description, score scale, flagging thresholds, and the daily audit cap.",
  perms: "admin",
  steps: [
    {
      view: "teams",
      anchor: "rubric-readonly-banner",
      placement: "bottom",
      title: "Read-only",
      body: "This team isn't yours to edit, so the fields are disabled. Pick your own team to make changes.",
      optional: true,
    },
    {
      anchor: "rubric-name",
      placement: "bottom",
      title: "Rubric name",
      body: "Shown on every audit this rubric scores, and in reports. Make it recognisable — 'CS Quality v2' beats 'Rubric'.",
    },
    {
      anchor: "rubric-description",
      placement: "bottom",
      title: "Description",
      body: "A note for humans about what this rubric is for. It is not sent to the model and doesn't affect scoring.",
    },
    {
      anchor: "rubric-scale-max",
      placement: "bottom",
      title: "Score scale",
      body:
        "The maximum score for each criterion — usually 100. The overall score is the weighted average of the criteria, computed here rather than asked of the model, so it's always consistent with the weights you set.",
    },
    {
      anchor: "rubric-flag-threshold",
      placement: "bottom",
      title: "Flag threshold",
      body: "Any call whose overall score falls below this gets flagged for review.",
    },
    {
      anchor: "rubric-critical-threshold",
      placement: "bottom",
      title: "Critical criterion threshold",
      body:
        "A safety net for the average hiding a disaster: if any single criterion scores below this, the call is flagged even when the overall score looks fine. Individual criteria can override it.",
    },
    {
      anchor: "rubric-daily-cap",
      placement: "top",
      title: "Calls audited per member / day",
      body:
        "The main cost control. Each agent on this team gets at most this many calls audited per day — extras are skipped before transcription, so they cost nothing. 0 means unlimited. The limit is exact: concurrent workers claim slots atomically, so it can't overshoot.",
    },
    {
      anchor: "rubric-system-prompt",
      placement: "top",
      title: "Base instruction for the auditor",
      body:
        "The system prompt sent with every audit for this rubric. Set the tone and standard here — the per-criterion instructions below handle the specifics.",
    },
    {
      anchor: "rubric-save",
      placement: "top",
      title: "Saving",
      body:
        "Nothing is stored until you save. Discard reverts to the last saved version. Workers pick up changes within about a minute, and it only affects calls audited from then on — existing audits aren't rescored.",
      optional: true,
    },
  ],
};

const SCORING_CRITERIA: Guide = {
  id: "rubrics-criteria",
  name: "Scoring criteria and weights",
  description: "How criteria are scored, how weights become percentages, and per-criterion overrides.",
  perms: "admin",
  steps: [
    {
      view: "teams",
      anchor: "criteria-section",
      placement: "top",
      title: "Scoring criteria",
      body: "The actual checklist. Every call is scored against each criterion, with a short explanation citing the transcript.",
    },
    {
      anchor: "criteria-note",
      placement: "bottom",
      title: "Weights are relative",
      body:
        "You don't need weights to total 100. They're normalised automatically, so 1/2/1 and 25/50/25 score identically. Adjust one without rebalancing the rest.",
    },
    {
      anchor: "criterion-card",
      placement: "top",
      title: "A criterion",
      body: "Each card is one thing the auditor checks. Add as many as you need — but every extra criterion is more tokens on every call.",
      optional: true,
    },
    {
      anchor: "criterion-name",
      placement: "bottom",
      title: "Criterion name",
      body: "Appears in the score breakdown on each audit. Short and specific: 'Greeting', 'Resolution', 'Empathy'.",
      optional: true,
    },
    {
      anchor: "criterion-weight",
      placement: "left",
      title: "Weight",
      body: "How much this criterion counts relative to the others. The percentage underneath updates live as you type.",
      optional: true,
    },
    {
      anchor: "criterion-description",
      placement: "top",
      title: "Instruction for the model",
      body:
        "This is the prompt text for this criterion, so write it as an instruction rather than a label — 'Did the agent confirm the customer's issue before proposing a fix?' scores far more reliably than 'Confirmation'.",
      optional: true,
    },
    {
      anchor: "criterion-guidance",
      placement: "top",
      title: "Optional guidance",
      body:
        "Extra context or examples appended to the instruction. Useful for edge cases the model keeps getting wrong — worked examples of a pass and a fail are the fastest fix.",
      optional: true,
    },
    {
      anchor: "criterion-critical",
      placement: "top",
      title: "Critical override",
      body:
        "Per-criterion version of the rubric's critical threshold. It must be strictly below the weight — a criterion can earn at most its weight, so a threshold at or above it would flag every call, including perfect ones. Leave blank to use the rubric default. Saving is blocked until any invalid override is fixed.",
      optional: true,
    },
    {
      anchor: "criteria-add",
      placement: "top",
      title: "Add a criterion",
      body: "Appends an empty criterion. Give it a name, a weight and an instruction before saving.",
      optional: true,
    },
  ],
};

const EXTRA_RUBRICS: Guide = {
  id: "rubrics-extras",
  name: "Additional rubrics and suggestions",
  description: "Scoring calls against more than one rubric, and improving rubrics from reviewer feedback.",
  perms: "admin",
  steps: [
    {
      view: "teams",
      anchor: "additional-rubrics",
      placement: "top",
      title: "Additional rubrics",
      body:
        "Beyond the primary rubric above, a team can have extra ones. Every call is scored against the primary plus each active rubric here, and a call is flagged if any of them flags it. Good for narrow compliance checks you don't want diluted into an average.",
    },
    {
      anchor: "additional-rubrics-row",
      placement: "top",
      title: "A rubric row",
      body: "Shows the name and how many criteria it has. The chevron expands it, the switch turns it on or off, and the bin deletes it.",
      optional: true,
    },
    {
      anchor: "additional-rubric-active",
      placement: "left",
      title: "Active toggle",
      body:
        "Only active rubrics are scored. Switching one off stops it applying to new calls without deleting it or losing its criteria — the safe way to pause a rubric you're still tuning.",
      optional: true,
    },
    {
      anchor: "additional-rubric-fields",
      signal: "expand-first-rubric",
      placement: "top",
      title: "Editing a rubric",
      body:
        "An expanded rubric has its own name, flag and critical thresholds, criteria and system prompt — the same shape as the primary rubric. 'Save rubric' saves this one independently of the editor above.",
      optional: true,
    },
    {
      anchor: "additional-rubrics-new-name",
      placement: "top",
      title: "Adding a rubric",
      body:
        "Name it and hit Add. It starts with one placeholder criterion and arrives active, so it begins scoring new calls as soon as it exists — switch it off first if you want to write it before it counts.",
    },
    {
      anchor: "suggestions-panel",
      placement: "top",
      title: "Improvement suggestions",
      body:
        "Closes the loop: when reviewers correct the AI's scores, this analyses where the AI and the humans disagree and proposes concrete rubric changes.",
    },
    {
      anchor: "suggestions-select",
      signal: "expand-suggestions",
      placement: "top",
      title: "Which rubric to analyse",
      body: "Pick the primary rubric or any additional one. Each is analysed against the feedback recorded on this team's audits.",
    },
    {
      anchor: "suggestions-generate",
      placement: "left",
      title: "Generate",
      body:
        "Sends the reviewer feedback to the model and asks for patterns rather than one-off corrections. It needs feedback to work with — collect corrections on some calls first, or you'll get nothing useful back.",
    },
    {
      anchor: "suggestion-card",
      placement: "top",
      title: "A suggestion",
      body:
        "Shows a summary of the disagreement pattern, proposed per-criterion changes with rationale, and the full revised system prompt. 'Apply prompt' drops it into the editor above — you still have to press Save Changes to persist it. 'Dismiss' keeps it on record without applying.",
      optional: true,
    },
  ],
};

const TEAM_INFRA: Guide = {
  id: "rubrics-infra",
  name: "Per-team infrastructure",
  description: "Giving a team its own buckets, queues and worker tuning.",
  perms: "super_admin",
  steps: [
    {
      view: "teams",
      anchor: "infra-panel",
      placement: "top",
      title: "Per-team infrastructure",
      body:
        "By default every team shares the global buckets and queues. Set these to onboard a team with its own. Any field left blank falls back to the global default, so you can override just one thing.",
      perms: "super_admin",
    },
    {
      anchor: "infra-recording_bucket",
      placement: "top",
      title: "Recording bucket",
      body: "Where this team's raw call recordings are read from. Read-only access is enough.",
      perms: "super_admin",
    },
    {
      anchor: "infra-output_bucket",
      placement: "top",
      title: "Output bucket",
      body: "Where transcripts and audit documents are written. Needs read and write.",
      perms: "super_admin",
    },
    {
      anchor: "infra-transcription_queue_url",
      placement: "top",
      title: "Transcription queue",
      body:
        "The team's own transcription queue. Workers poll every active team's queue alongside the shared one, and the queue a message arrives on is authoritative for which team owns the call.",
      perms: "super_admin",
    },
    {
      anchor: "infra-audit_queue_url",
      placement: "top",
      title: "Audit queue",
      body: "Where stage one hands finished transcripts to stage two for scoring.",
      perms: "super_admin",
    },
    {
      anchor: "infra-batch_size",
      placement: "top",
      title: "Batch size",
      body: "How many messages a worker pulls per long-poll, 1 to 10.",
      perms: "super_admin",
    },
    {
      anchor: "infra-wait_time_seconds",
      placement: "top",
      title: "Wait time",
      body: "Long-poll duration in seconds, up to 20. Higher means fewer empty receives and lower cost.",
      perms: "super_admin",
    },
    {
      anchor: "infra-max_receive_count",
      placement: "top",
      title: "Max receive count",
      body:
        "How many failed deliveries before a message goes to the dead-letter queue. This must match the queue's actual redrive policy — the app uses it to decide when a failure is the last attempt and worth alerting on.",
      perms: "super_admin",
    },
    {
      anchor: "infra-worker_concurrency",
      placement: "top",
      title: "Worker concurrency",
      body:
        "How many messages one worker processes at once. Raising it increases throughput and the load on whatever the workers call — check your provider's rate limit before pushing it up.",
      perms: "super_admin",
    },
    {
      anchor: "infra-active",
      placement: "top",
      title: "Team active",
      body: "Uncheck to stop workers polling this team's queue, without deleting the team or its rubric.",
      perms: "super_admin",
    },
  ],
};

export const GUIDES: Guide[] = [
  TEAMS_AND_CREATION,
  RUBRIC_BASICS,
  SCORING_CRITERIA,
  EXTRA_RUBRICS,
  TEAM_INFRA,
];

/** Guides offered to a role, cheapest tier first. */
export function guidesFor(role: GuideRole): Guide[] {
  return GUIDES.filter((g) => RANK[role] >= RANK[g.perms]);
}

/**
 * The steps a given role actually sees. Filtering up front (rather than skipping
 * at runtime) keeps the step counter honest — an admin running a guide that has
 * super-admin steps sees "Step 2 of 4", not "Step 2 of 7" with gaps.
 */
export function stepsFor(guide: Guide, role: GuideRole): GuideStep[] {
  return guide.steps.filter((s) => RANK[role] >= RANK[s.perms ?? guide.perms]);
}

/** Every anchor a guide references, for the dev-time anchor check. */
export function anchorsIn(guide: Guide): string[] {
  return guide.steps.map((s) => s.anchor).filter((a): a is string => !!a);
}
