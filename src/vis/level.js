'use strict';

/**
 * Field-visibility LEVEL: one integer per caller, 1 narrowest, 4 anonymous public; lowest wins.
 * 0 is not a caller level — it's the sealed row-plane compartment `systemAccess()` carries.
 */
const ROLE_LEVELS = {
  sysadmin: 1,
  'demi-admin': 1,
  staff: 2,
  'demi-service-read': 2,
  'demi-service-write': 2,
  compliance: 2,
  idir: 3,
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
