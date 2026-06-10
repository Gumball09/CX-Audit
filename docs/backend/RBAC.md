# Role-Based Access Control

Three roles. Enforcement lives in `src/services/rbac.ts` (pure permission
functions) and is applied by route guards in `src/routes/*` + the auth
middleware in `src/services/auth.ts`.

## Roles

| Role | Scope | Summary |
|------|-------|---------|
| `super_admin` | org-wide | Manage admins **and** users, edit any team rubric, view all audits. |
| `admin` | one team | Manage `user` accounts in their team, edit their team's rubric, view their team's audits. |
| `user` | self | View their own audits only. |

## Permission matrix

| Action | super_admin | admin | user |
|--------|:-----------:|:-----:|:----:|
| Create admin | ✅ | ❌ | ❌ |
| Create user | ✅ | ✅ (own team) | ❌ |
| Update user role / team | ✅ | ❌ | ❌ |
| Update user name / agent_id / status | ✅ | ✅ (own team users) | ❌ |
| Delete admin | ✅ | ❌ | ❌ |
| Delete user | ✅ | ✅ (own team) | ❌ |
| Edit team rubric | ✅ (any) | ✅ (own team) | ❌ |
| View audits | all | own team | own (`agent_id`) |

Guard rails:
- An admin can only ever touch rows where `targetRole === "user"` and
  `targetTeam === admin.team` (`canManageUser`).
- Only a super_admin may change a user's `role` or `team`.
- You cannot delete your own account, and the **last** super_admin cannot be
  deleted.

## How a request is authorized

1. `POST /api/auth/login` with an email → returns a **JWT** + the user record.
2. Every protected route runs `authenticate`, which verifies the token and
   **re-loads the user from DynamoDB** — so a deactivated or re-roled user loses
   access immediately, not at token expiry.
3. Route guards (`requireRole(...)`) and the rbac helpers
   (`canManageUser`, `canEditRubric`, `auditScope`) enforce the matrix above.

> Login is email-only today (mirrors the existing dashboard). To add passwords
> or SSO, validate the credential inside `routes/auth.ts#login` before
> `signToken` — nothing else changes, since the rest of the stack only trusts
> the issued JWT.

## Audit visibility (scope)

`auditScope(role)` maps each role to a query (see `docs/DYNAMODB.md`):

```
super_admin → scanAll()                  (every audit)
admin       → queryByTeam(user.team)     (team-index)
user        → queryByAgent(user.agent_id)(agent-index)
```

Single-record reads (`GET /api/audits/:id`, `/transcript`) re-check scope with
`canView` so an out-of-scope id returns 403, not data.
