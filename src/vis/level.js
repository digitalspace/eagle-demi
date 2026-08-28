'use strict';

/**
 * Field-visibility LEVEL: one integer per caller, 0 most privileged, 4 anonymous public.
 *
 * Phase 3 (docs/rbac-architecture.md §1, §5) adds `idir: 3` and moves `sysadmin`/`demi-admin` to 1;
 * team membership is never a role here but the row plane's team arm. DEMI reuses Eagle's realm
 * roles and creates none of its own.
 */
const ROLE_LEVELS = {
  sysadmin: 0,
  'demi-admin': 0,
  staff: 2,
  'demi-service-read': 2,
  'demi-service-write': 2,
  compliance: 2,
  public: 4
};

/** No recognised role — the fail-closed level (docs/rbac-architecture.md §1, "Fail closed"). */
const ANONYMOUS_LEVEL = 4;

/** Every level that exists. Anything else — `null`, a string, 7 — is invalid, not clamped. */
const LEVELS = [0, 1, 2, 3, 4];

/** Lowest level of any recognised role; an unknown role grants nothing. */
function levelFromRoles(roles) {
  if (!Array.isArray(roles)) return ANONYMOUS_LEVEL;

  let level = ANONYMOUS_LEVEL;
  for (const role of roles) {
    const roleLevel = ROLE_LEVELS[role];
    if (roleLevel !== undefined && roleLevel < level) level = roleLevel;
  }
  return level;
}

/** The level on an access context, fail-closed: anything but a real level reads as anonymous. */
function levelOf(access) {
  return LEVELS.includes(access && access.level) ? access.level : ANONYMOUS_LEVEL;
}

module.exports = { ROLE_LEVELS, ANONYMOUS_LEVEL, LEVELS, levelFromRoles, levelOf };
