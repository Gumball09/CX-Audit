/**
 * OpenAPI 3.0 specification for the CX Audit API, served at /api/docs.
 *
 * This is hand-maintained (the routes use manual validation, so there's no
 * schema to auto-derive from) — when you add or change an endpoint, update the
 * matching entry here. Kept as one module so it behaves identically under tsx
 * (dev) and the compiled dist build (prod), with no file-glob scanning.
 */

const bearer = [{ bearerAuth: [] as string[] }];
const PUBLIC: { [k: string]: string[] }[] = []; // security: [] → no auth required

// Common error responses, referenced from operations.
const errorResponses = {
  BadRequest: { description: "Invalid request", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
  Unauthorized: { description: "Missing/invalid token", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
  Forbidden: { description: "Out of scope / insufficient role", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
  NotFound: { description: "Not found", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
};

const json = (ref: string) => ({ "application/json": { schema: { $ref: `#/components/schemas/${ref}` } } });
const jsonArray = (ref: string) => ({ "application/json": { schema: { type: "array", items: { $ref: `#/components/schemas/${ref}` } } } });

export const openapiSpec = {
  openapi: "3.0.3",
  info: {
    title: "CX Audit API",
    version: "1.0.0",
    description:
      "Internal API for the CX Audit platform (call transcription + rubric-based AI auditing).\n\n" +
      "**Auth:** obtain a JWT via `POST /auth/login`, then click **Authorize** and paste it. " +
      "Most endpoints require a Bearer token; role requirements are noted per operation.",
  },
  servers: [
    { url: "https://api.audit-copilot.scaler.com/api", description: "Production" },
    { url: "http://localhost:4000/api", description: "Local" },
  ],
  security: bearer,
  tags: [
    { name: "Auth", description: "Login and current user" },
    { name: "Audits", description: "Call audits: list, view, reprocess, bulk-run" },
    { name: "Performance", description: "Score trends and call-outcome counts" },
    { name: "Login Stats", description: "Sign-in activity (super_admin)" },
    { name: "Users", description: "User management (admin+)" },
    { name: "Teams", description: "Teams and their primary rubric" },
    { name: "Rubrics", description: "Additional per-team rubrics" },
    { name: "Feedback", description: "Reviewer corrections of AI audits" },
    { name: "Suggestions", description: "AI rubric-improvement suggestions" },
    { name: "Patterns", description: "Recording-filename patterns (super_admin)" },
    { name: "Settings", description: "Platform model settings" },
    { name: "System", description: "Health" },
  ],
  components: {
    securitySchemes: {
      bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
    },
    responses: errorResponses,
    schemas: {
      Error: {
        type: "object",
        properties: {
          message: { type: "string" },
          errors: { type: "array", items: { type: "string" } },
          request_id: { type: "string" },
        },
        required: ["message"],
      },
      Ok: { type: "object", properties: { ok: { type: "boolean", example: true } } },
      Role: { type: "string", enum: ["super_admin", "admin", "user"] },
      Criterion: {
        type: "object",
        properties: {
          name: { type: "string" },
          weight: { type: "number", description: "Relative weight (normalized across criteria)" },
          description: { type: "string" },
          guidance: { type: "string", nullable: true },
          critical_threshold: { type: "number", nullable: true },
        },
        required: ["name", "weight", "description"],
      },
      CriterionScore: {
        type: "object",
        properties: {
          name: { type: "string" },
          score: { type: "number" },
          explanation: { type: "string" },
        },
      },
      RubricResult: {
        type: "object",
        properties: {
          rubric_id: { type: "string", example: "primary" },
          rubric_name: { type: "string" },
          score: { type: "number" },
          flagged: { type: "boolean" },
          flag_reason: { type: "string" },
          criteria_scores: { type: "array", items: { $ref: "#/components/schemas/CriterionScore" } },
        },
      },
      User: {
        type: "object",
        properties: {
          user_id: { type: "string", example: "USR-ab12cd34" },
          email: { type: "string", format: "email" },
          name: { type: "string" },
          role: { $ref: "#/components/schemas/Role" },
          team: { type: "string", nullable: true },
          agent_id: { type: "string", nullable: true, description: "Dialer agent id; null for non-agents" },
          status: { type: "string", enum: ["active", "inactive"] },
          created_at: { type: "string", format: "date-time" },
          updated_at: { type: "string", format: "date-time" },
        },
      },
      NewUser: {
        type: "object",
        required: ["email", "name", "role"],
        properties: {
          email: { type: "string", format: "email" },
          name: { type: "string" },
          role: { $ref: "#/components/schemas/Role" },
          team: { type: "string", nullable: true },
          agent_id: { type: "string", nullable: true },
        },
      },
      TeamRubric: {
        type: "object",
        properties: {
          team_id: { type: "string", example: "CS" },
          name: { type: "string" },
          description: { type: "string" },
          criteria: { type: "array", items: { $ref: "#/components/schemas/Criterion" } },
          system_prompt: { type: "string" },
          scale_max: { type: "number", example: 100 },
          flag_threshold: { type: "number", example: 70 },
          critical_criterion_threshold: { type: "number", example: 60 },
          active: { type: "boolean" },
          infra: { type: "object", nullable: true, description: "Optional per-team infra overrides (buckets/queues)" },
        },
      },
      Rubric: {
        allOf: [
          { $ref: "#/components/schemas/TeamRubric" },
          { type: "object", properties: { rubric_id: { type: "string" } } },
        ],
      },
      AuditRecord: {
        type: "object",
        properties: {
          audit_id: { type: "string" },
          recording_key: { type: "string" },
          recording_url: { type: "string" },
          agent_id: { type: "string" },
          session_id: { type: "string" },
          campaign: { type: "string" },
          customer_number: { type: "string" },
          call_datetime: { type: "string", format: "date-time" },
          team: { type: "string", nullable: true },
          status: {
            type: "string",
            enum: ["queued", "transcribing", "transcribed", "auditing", "audited", "skipped", "failed"],
          },
          score: { type: "number", nullable: true },
          flagged: { type: "boolean", nullable: true },
          flag_reason: { type: "string", nullable: true },
          criteria_scores: { type: "array", items: { $ref: "#/components/schemas/CriterionScore" } },
          rubric_results: { type: "array", items: { $ref: "#/components/schemas/RubricResult" } },
          duration_sec: { type: "number", nullable: true },
          error: { type: "string", nullable: true },
          created_at: { type: "string", format: "date-time" },
          updated_at: { type: "string", format: "date-time" },
        },
      },
      AuditPage: {
        type: "object",
        properties: {
          items: { type: "array", items: { $ref: "#/components/schemas/AuditRecord" } },
          nextCursor: { type: "string", nullable: true, description: "Opaque cursor; pass back as ?cursor= for the next page" },
        },
      },
      Feedback: {
        type: "object",
        properties: {
          feedback_id: { type: "string" },
          audit_id: { type: "string" },
          team: { type: "string" },
          rubric_id: { type: "string" },
          rubric_name: { type: "string" },
          reviewer_email: { type: "string" },
          disposition: { type: "string", enum: ["agree", "disagree", "partial"] },
          ai_score: { type: "number" },
          ai_flagged: { type: "boolean" },
          human_score: { type: "number", nullable: true },
          human_flagged: { type: "boolean", nullable: true },
          comment: { type: "string" },
          created_at: { type: "string", format: "date-time" },
        },
      },
      NewFeedback: {
        type: "object",
        required: ["audit_id", "disposition"],
        properties: {
          audit_id: { type: "string" },
          rubric_id: { type: "string", default: "primary" },
          disposition: { type: "string", enum: ["agree", "disagree", "partial"] },
          human_score: { type: "number" },
          human_flagged: { type: "boolean" },
          comment: { type: "string", description: "Required unless disposition is 'agree'" },
        },
      },
      RubricSuggestion: {
        type: "object",
        properties: {
          suggestion_id: { type: "string" },
          team: { type: "string" },
          rubric_id: { type: "string" },
          rubric_name: { type: "string" },
          status: { type: "string", enum: ["open", "applied", "dismissed"] },
          summary: { type: "string" },
          suggested_system_prompt: { type: "string" },
          criteria_changes: { type: "array", items: { type: "object" } },
          based_on_feedback_count: { type: "number" },
          created_at: { type: "string", format: "date-time" },
        },
      },
      RecordingPattern: {
        type: "object",
        properties: {
          pattern_id: { type: "string" },
          label: { type: "string" },
          regex: { type: "string", description: "Must contain a named group (?<agent_id>...)" },
          flags: { type: "string", example: "i" },
          priority: { type: "number" },
          active: { type: "boolean" },
          match_count: { type: "number" },
          is_builtin: { type: "boolean" },
        },
      },
      PerformancePoint: {
        type: "object",
        properties: {
          period: { type: "string", example: "2026-06" },
          call_count: { type: "number" },
          avg_score: { type: "number" },
          flagged_count: { type: "number" },
        },
      },
      PerformanceResponse: {
        type: "object",
        properties: {
          scope: { type: "object", nullable: true, properties: { type: { type: "string" }, id: { type: "string" } } },
          granularity: { type: "string", enum: ["day", "month", "year"] },
          series: { type: "array", items: { $ref: "#/components/schemas/PerformancePoint" } },
          summary: { type: "object" },
        },
      },
      StatusCountsResponse: {
        type: "object",
        properties: {
          scope: { type: "object", properties: { type: { type: "string" }, id: { type: "string" } } },
          counts: {
            type: "object",
            additionalProperties: { type: "number" },
            example: { audited: 983, skipped: 619, failed: 0 },
          },
        },
      },
      LoginStatPoint: {
        type: "object",
        properties: {
          period: { type: "string" },
          login_count: { type: "number" },
          unique_count: { type: "number" },
        },
      },
      BulkRunResult: {
        type: "object",
        properties: {
          dryRun: { type: "boolean" },
          total: { type: "number" },
          valid: { type: "number" },
          queued: { type: "number" },
          invalid: { type: "number" },
          by_team: { type: "object", additionalProperties: { type: "number" } },
          errors: { type: "array", items: { type: "object", properties: { key: { type: "string" }, reason: { type: "string" } } } },
          sample: { type: "array", items: { type: "string" } },
          truncated: { type: "boolean" },
        },
      },
      PlatformSettings: {
        type: "object",
        properties: {
          setting_id: { type: "string" },
          transcription_model: { type: "string" },
          audit_model: { type: "string" },
        },
      },
    },
  },
  paths: {
    // ---- System ----
    "/health": {
      get: {
        tags: ["System"], summary: "Health check", security: PUBLIC,
        responses: { "200": { description: "OK", content: { "application/json": { schema: { type: "object" } } } } },
      },
    },

    // ---- Auth ----
    "/auth/login": {
      post: {
        tags: ["Auth"], summary: "Log in (or learn that first-login password setup is needed)", security: PUBLIC,
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["email"], properties: { email: { type: "string", format: "email" }, password: { type: "string" } } } } } },
        responses: {
          "200": { description: "Token + user, or { needs_password_setup: true }", content: { "application/json": { schema: { type: "object" } } } },
          "400": { $ref: "#/components/responses/BadRequest" }, "401": { $ref: "#/components/responses/Unauthorized" },
        },
      },
    },
    "/auth/set-password": {
      post: {
        tags: ["Auth"], summary: "Set the initial password on first login", security: PUBLIC,
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["email", "password"], properties: { email: { type: "string", format: "email" }, password: { type: "string", minLength: 8 } } } } } },
        responses: { "200": { description: "Token + user", content: { "application/json": { schema: { type: "object" } } } }, "400": { $ref: "#/components/responses/BadRequest" }, "401": { $ref: "#/components/responses/Unauthorized" }, "409": { description: "Password already set" } },
      },
    },
    "/auth/me": {
      get: { tags: ["Auth"], summary: "Current authenticated user", responses: { "200": { description: "User", content: json("User") }, "401": { $ref: "#/components/responses/Unauthorized" } } },
    },

    // ---- Audits ----
    "/audits": {
      get: {
        tags: ["Audits"], summary: "List audits visible to the caller (paginated)",
        description: "super_admin = all; admin = own team; user = own calls. Use nextCursor to page.",
        parameters: [
          { name: "team", in: "query", schema: { type: "string" }, description: "super_admin only" },
          { name: "flagged", in: "query", schema: { type: "boolean" } },
          { name: "status", in: "query", schema: { type: "string", enum: ["queued", "transcribing", "transcribed", "auditing", "audited", "skipped", "failed"] } },
          { name: "from", in: "query", schema: { type: "string", format: "date-time" } },
          { name: "to", in: "query", schema: { type: "string", format: "date-time" } },
          { name: "limit", in: "query", schema: { type: "integer", default: 200, maximum: 1000 } },
          { name: "cursor", in: "query", schema: { type: "string" } },
        ],
        responses: { "200": { description: "Page of audits", content: json("AuditPage") }, "401": { $ref: "#/components/responses/Unauthorized" } },
      },
    },
    "/audits/{id}": {
      get: { tags: ["Audits"], summary: "Get a single audit", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], responses: { "200": { description: "Audit", content: json("AuditRecord") }, "403": { $ref: "#/components/responses/Forbidden" }, "404": { $ref: "#/components/responses/NotFound" } } },
    },
    "/audits/{id}/transcript": {
      get: { tags: ["Audits"], summary: "Get an audit's transcript text", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], responses: { "200": { description: "Transcript", content: { "application/json": { schema: { type: "object", properties: { audit_id: { type: "string" }, transcript: { type: "string" } } } } } }, "404": { $ref: "#/components/responses/NotFound" } } },
    },
    "/audits/reprocess": {
      post: {
        tags: ["Audits"], summary: "Re-ingest one recording (admin+)",
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["recording_key"], properties: { recording_key: { type: "string" } } } } } },
        responses: { "200": { description: "Queued", content: json("Ok") }, "400": { $ref: "#/components/responses/BadRequest" }, "403": { $ref: "#/components/responses/Forbidden" } },
      },
    },
    "/audits/bulk-reprocess": {
      post: {
        tags: ["Audits"], summary: "Bulk-ingest recordings by prefix or key list (super_admin)",
        description: "Provide recording_keys[] OR prefix. Pass dryRun:true to preview counts without enqueuing. Capped at 2000/run. Re-runs update rows (no duplicates) but re-incur OpenAI cost.",
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", properties: { recording_keys: { type: "array", items: { type: "string" } }, prefix: { type: "string", example: "Scaler/14_06_2026/" }, dryRun: { type: "boolean" } } } } } },
        responses: { "200": { description: "Run/preview result", content: json("BulkRunResult") }, "400": { $ref: "#/components/responses/BadRequest" }, "403": { $ref: "#/components/responses/Forbidden" } },
      },
    },
    "/audits/{id}/reaudit": {
      post: { tags: ["Audits"], summary: "Re-run only the audit stage for a transcribed call (admin+)", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], responses: { "200": { description: "Queued", content: json("Ok") }, "400": { $ref: "#/components/responses/BadRequest" }, "404": { $ref: "#/components/responses/NotFound" } } },
    },

    // ---- Performance ----
    "/performance/me": {
      get: { tags: ["Performance"], summary: "The caller's own performance series", parameters: [{ name: "granularity", in: "query", schema: { type: "string", enum: ["day", "month", "year"], default: "month" } }], responses: { "200": { description: "Series", content: json("PerformanceResponse") } } },
    },
    "/performance": {
      get: {
        tags: ["Performance"], summary: "Performance series for an agent or team (RBAC-enforced)",
        parameters: [
          { name: "scope", in: "query", required: true, schema: { type: "string", enum: ["agent", "team"] } },
          { name: "id", in: "query", required: true, schema: { type: "string" } },
          { name: "granularity", in: "query", schema: { type: "string", enum: ["day", "month", "year"] } },
          { name: "from", in: "query", schema: { type: "string" } }, { name: "to", in: "query", schema: { type: "string" } },
        ],
        responses: { "200": { description: "Series", content: json("PerformanceResponse") }, "400": { $ref: "#/components/responses/BadRequest" }, "403": { $ref: "#/components/responses/Forbidden" } },
      },
    },
    "/performance/status-counts": {
      get: {
        tags: ["Performance"], summary: "Call-outcome counts (audited/skipped/failed/…) for a scope",
        parameters: [
          { name: "scope", in: "query", required: true, schema: { type: "string", enum: ["agent", "team"] } },
          { name: "id", in: "query", required: true, schema: { type: "string" } },
          { name: "from", in: "query", schema: { type: "string" } }, { name: "to", in: "query", schema: { type: "string" } },
        ],
        responses: { "200": { description: "Counts by status", content: json("StatusCountsResponse") }, "400": { $ref: "#/components/responses/BadRequest" }, "403": { $ref: "#/components/responses/Forbidden" } },
      },
    },

    // ---- Login Stats (super_admin) ----
    "/login-stats": {
      get: { tags: ["Login Stats"], summary: "Sign-in series for a role scope (super_admin)", parameters: [{ name: "scope", in: "query", schema: { type: "string", enum: ["all", "super_admin", "admin", "user"], default: "all" } }, { name: "granularity", in: "query", schema: { type: "string", enum: ["day", "month"] } }, { name: "from", in: "query", schema: { type: "string" } }, { name: "to", in: "query", schema: { type: "string" } }], responses: { "200": { description: "Series", content: { "application/json": { schema: { type: "object" } } } }, "403": { $ref: "#/components/responses/Forbidden" } } },
    },
    "/login-stats/breakdown": {
      get: { tags: ["Login Stats"], summary: "Sign-ins split by role (super_admin)", parameters: [{ name: "granularity", in: "query", schema: { type: "string", enum: ["day", "month"] } }], responses: { "200": { description: "Per-role series", content: { "application/json": { schema: { type: "object" } } } }, "403": { $ref: "#/components/responses/Forbidden" } } },
    },
    "/login-stats/teams": {
      get: { tags: ["Login Stats"], summary: "Per-team sign-ins + active-team count (super_admin)", parameters: [{ name: "granularity", in: "query", schema: { type: "string", enum: ["day", "month"] } }], responses: { "200": { description: "Per-team activity", content: { "application/json": { schema: { type: "object" } } } }, "403": { $ref: "#/components/responses/Forbidden" } } },
    },

    // ---- Users ----
    "/users": {
      get: { tags: ["Users"], summary: "List users (admin+; admins see own team)", responses: { "200": { description: "Users", content: jsonArray("User") }, "403": { $ref: "#/components/responses/Forbidden" } } },
      post: { tags: ["Users"], summary: "Create a user (admin+)", requestBody: { required: true, content: json("NewUser") }, responses: { "201": { description: "Created", content: json("User") }, "400": { $ref: "#/components/responses/BadRequest" }, "403": { $ref: "#/components/responses/Forbidden" }, "409": { description: "Email exists" } } },
    },
    "/users/{id}": {
      patch: { tags: ["Users"], summary: "Update a user (admin+; role/team are super_admin only)", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], requestBody: { content: { "application/json": { schema: { type: "object", properties: { name: { type: "string" }, role: { $ref: "#/components/schemas/Role" }, team: { type: "string" }, agent_id: { type: "string" }, status: { type: "string", enum: ["active", "inactive"] } } } } } }, responses: { "200": { description: "Updated", content: json("User") }, "403": { $ref: "#/components/responses/Forbidden" }, "404": { $ref: "#/components/responses/NotFound" } } },
      delete: { tags: ["Users"], summary: "Delete a user (admin+; protects last super_admin)", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], responses: { "200": { description: "Deleted", content: json("Ok") }, "400": { $ref: "#/components/responses/BadRequest" }, "403": { $ref: "#/components/responses/Forbidden" }, "404": { $ref: "#/components/responses/NotFound" } } },
    },

    // ---- Teams ----
    "/teams": {
      get: { tags: ["Teams"], summary: "List teams (any authenticated user)", responses: { "200": { description: "Teams", content: jsonArray("TeamRubric") } } },
      post: { tags: ["Teams"], summary: "Create a team (super_admin)", requestBody: { required: true, content: json("TeamRubric") }, responses: { "201": { description: "Created", content: json("TeamRubric") }, "400": { $ref: "#/components/responses/BadRequest" }, "409": { description: "Team exists" } } },
    },
    "/teams/{id}": {
      get: { tags: ["Teams"], summary: "Get a team", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], responses: { "200": { description: "Team", content: json("TeamRubric") }, "404": { $ref: "#/components/responses/NotFound" } } },
      patch: { tags: ["Teams"], summary: "Edit a team (admin own team; infra/active super_admin only)", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], requestBody: { content: json("TeamRubric") }, responses: { "200": { description: "Updated", content: json("TeamRubric") }, "403": { $ref: "#/components/responses/Forbidden" }, "404": { $ref: "#/components/responses/NotFound" } } },
    },

    // ---- Rubrics ----
    "/rubrics": {
      get: { tags: ["Rubrics"], summary: "List a team's additional rubrics (admin+)", parameters: [{ name: "team", in: "query", required: true, schema: { type: "string" } }], responses: { "200": { description: "Rubrics", content: jsonArray("Rubric") }, "400": { $ref: "#/components/responses/BadRequest" }, "403": { $ref: "#/components/responses/Forbidden" } } },
      post: { tags: ["Rubrics"], summary: "Add an additional rubric (admin+)", requestBody: { required: true, content: json("Rubric") }, responses: { "201": { description: "Created", content: json("Rubric") }, "400": { $ref: "#/components/responses/BadRequest" }, "403": { $ref: "#/components/responses/Forbidden" } } },
    },
    "/rubrics/{id}": {
      patch: { tags: ["Rubrics"], summary: "Edit an additional rubric (admin+)", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], requestBody: { content: json("Rubric") }, responses: { "200": { description: "Updated", content: json("Rubric") }, "404": { $ref: "#/components/responses/NotFound" } } },
      delete: { tags: ["Rubrics"], summary: "Delete an additional rubric (admin+)", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], responses: { "200": { description: "Deleted", content: json("Ok") }, "404": { $ref: "#/components/responses/NotFound" } } },
    },

    // ---- Feedback ----
    "/feedback": {
      get: { tags: ["Feedback"], summary: "List feedback by audit or team (admin+)", parameters: [{ name: "audit", in: "query", schema: { type: "string" } }, { name: "team", in: "query", schema: { type: "string" } }], responses: { "200": { description: "Feedback", content: jsonArray("Feedback") }, "400": { $ref: "#/components/responses/BadRequest" }, "403": { $ref: "#/components/responses/Forbidden" } } },
      post: { tags: ["Feedback"], summary: "Record a reviewer correction (admin+)", requestBody: { required: true, content: json("NewFeedback") }, responses: { "201": { description: "Created", content: json("Feedback") }, "400": { $ref: "#/components/responses/BadRequest" }, "403": { $ref: "#/components/responses/Forbidden" } } },
    },
    "/feedback/{id}": {
      delete: { tags: ["Feedback"], summary: "Delete feedback (author or super_admin)", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], responses: { "200": { description: "Deleted", content: json("Ok") }, "403": { $ref: "#/components/responses/Forbidden" }, "404": { $ref: "#/components/responses/NotFound" } } },
    },

    // ---- Suggestions ----
    "/suggestions": {
      get: { tags: ["Suggestions"], summary: "List rubric-improvement suggestions for a team (admin+)", parameters: [{ name: "team", in: "query", required: true, schema: { type: "string" } }], responses: { "200": { description: "Suggestions", content: jsonArray("RubricSuggestion") }, "400": { $ref: "#/components/responses/BadRequest" } } },
    },
    "/suggestions/generate": {
      post: { tags: ["Suggestions"], summary: "Generate a suggestion from a team's feedback (admin+)", requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["team"], properties: { team: { type: "string" }, rubric_id: { type: "string", default: "primary" } } } } } }, responses: { "201": { description: "Created", content: json("RubricSuggestion") }, "400": { $ref: "#/components/responses/BadRequest" }, "404": { $ref: "#/components/responses/NotFound" } } },
    },
    "/suggestions/{id}": {
      patch: { tags: ["Suggestions"], summary: "Set suggestion status (admin+)", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], requestBody: { required: true, content: { "application/json": { schema: { type: "object", properties: { status: { type: "string", enum: ["open", "applied", "dismissed"] } } } } } }, responses: { "200": { description: "Updated", content: json("RubricSuggestion") }, "400": { $ref: "#/components/responses/BadRequest" } } },
      delete: { tags: ["Suggestions"], summary: "Delete a suggestion (admin+)", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], responses: { "200": { description: "Deleted", content: json("Ok") }, "404": { $ref: "#/components/responses/NotFound" } } },
    },

    // ---- Patterns (super_admin) ----
    "/patterns": {
      get: { tags: ["Patterns"], summary: "List recording patterns (super_admin)", responses: { "200": { description: "Patterns", content: jsonArray("RecordingPattern") }, "403": { $ref: "#/components/responses/Forbidden" } } },
      post: { tags: ["Patterns"], summary: "Create a pattern (super_admin)", requestBody: { required: true, content: json("RecordingPattern") }, responses: { "201": { description: "Created", content: json("RecordingPattern") }, "400": { $ref: "#/components/responses/BadRequest" } } },
    },
    "/patterns/test": {
      post: { tags: ["Patterns"], summary: "Dry-run a pattern against a sample key (super_admin)", requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["regex", "sample"], properties: { regex: { type: "string" }, flags: { type: "string" }, sample: { type: "string" } } } } } }, responses: { "200": { description: "Match result", content: { "application/json": { schema: { type: "object", properties: { matched: { type: "boolean" }, groups: { type: "object", nullable: true } } } } } }, "400": { $ref: "#/components/responses/BadRequest" } } },
    },
    "/patterns/{id}": {
      patch: { tags: ["Patterns"], summary: "Edit a pattern (super_admin)", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], requestBody: { content: json("RecordingPattern") }, responses: { "200": { description: "Updated", content: json("RecordingPattern") }, "404": { $ref: "#/components/responses/NotFound" } } },
      delete: { tags: ["Patterns"], summary: "Delete a pattern (super_admin; built-in protected)", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], responses: { "200": { description: "Deleted", content: json("Ok") }, "400": { $ref: "#/components/responses/BadRequest" }, "404": { $ref: "#/components/responses/NotFound" } } },
    },

    // ---- Settings ----
    "/settings": {
      get: { tags: ["Settings"], summary: "Current platform model settings (admin+)", responses: { "200": { description: "Settings", content: json("PlatformSettings") } } },
      patch: { tags: ["Settings"], summary: "Change pipeline models (super_admin)", requestBody: { required: true, content: { "application/json": { schema: { type: "object", properties: { transcription_model: { type: "string" }, audit_model: { type: "string" } } } } } }, responses: { "200": { description: "Updated", content: json("PlatformSettings") }, "400": { $ref: "#/components/responses/BadRequest" } } },
    },
  },
} as const;
