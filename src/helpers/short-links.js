'use strict';

/**
 * Short-link codes, the `/s/<code>` URL shape, and the one project link. The link controller and
 * the project write paths both mint codes, so the alphabet and the collision retry live here.
 */

const crypto = require('crypto');
const config = require('../config');
const linksRepository = require('../repositories/links');
const projectsRepository = require('../repositories/projects');
const { eagleOnlyProjectId } = require('../merge/project');
const { logger } = require('../utils/logger');

/** No `0 O 1 l I` — a printed poster must not force a reader to guess which glyph they're looking at. */
const CODE_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
const GENERATED_CODE_LENGTH = 8;

function generateCode() {
  let code = '';
  for (let i = 0; i < GENERATED_CODE_LENGTH; i++) {
    code += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
  }
  return code;
}

/** The only place the public form of a code is composed. */
function shortUrlFor(code) {
  return `${config.linkBaseUrl}/s/${code}`;
}

function isConflict(err) {
  return Boolean(err) && (err.code === 409 || err.statusCode === 409);
}

function isPreconditionFailed(err) {
  return Boolean(err) && (err.code === 412 || err.statusCode === 412);
}

/** Vanity codes. Anything outside this alphabet cannot be a Cosmos id or a clean URL segment. */
const CUSTOM_CODE = /^[a-z0-9_-]{3,64}$/;

/** A code `generateCode` minted. Only these, on a row with no `shortCodeSource`, are migrated. */
const RANDOM_CODE = new RegExp(`^[${CODE_ALPHABET}]{${GENERATED_CODE_LENGTH}}$`);
const SLUG_MAX_LENGTH = 40;
/** `<slug>`, then `<slug>-2` ... `<slug>-5`, then a random code. */
const SLUG_TRIES = 5;

/** The project fields a whole-item upsert must carry across, or a printed link goes dead. */
const SHORT_LINK_FIELDS = ['shortCode', 'shortCodeSource', 'legacyShortCodes', 'shortLinkUrl'];

/**
 * A readable code from a project name: "Site C Clean Energy" -> `site-c-clean-energy`. Null when
 * the name leaves fewer than 3 characters, which `CUSTOM_CODE` would refuse.
 */
function slugify(name) {
  const slug = String(name || '')
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  let capped = slug;
  if (slug.length > SLUG_MAX_LENGTH) {
    // One past the cap, so a word ending exactly at 40 is kept whole.
    const cut = slug.slice(0, SLUG_MAX_LENGTH + 1).lastIndexOf('-');
    capped = cut > 0 ? slug.slice(0, cut) : slug.slice(0, SLUG_MAX_LENGTH);
  }
  return capped.length >= 3 ? capped : null;
}

/** A stored project still on the random code minted before slugs. */
function needsSlugMigration(project) {
  return Boolean(project && project.shortCode && !project.shortCodeSource &&
    RANDOM_CODE.test(project.shortCode));
}

/** The project's Eagle public page, where its codes point unless staff set another target. */
function defaultProjectUrl(project) {
  return `${config.linkBaseUrl}/p/${project.eagleId}`;
}

/** Where the project's codes point: the staff-set `shortLinkUrl`, else the public page. */
function projectTarget(project) {
  return project.shortLinkUrl || defaultProjectUrl(project);
}

/**
 * A record url at this project's `/p/<eagleId>` path on a host other than `LINK_BASE_URL`, on a
 * project with no custom target. Old records carry the prod host on test; these are safe to move.
 */
function isWrongHostDefault(project, url) {
  if (!project || !project.eagleId || project.shortLinkUrl) return false;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return parsed.pathname === `/p/${project.eagleId}` &&
    parsed.origin !== new URL(config.linkBaseUrl).origin;
}

/** The ids that count as this project when it holds a code: its own, and its Eagle-only twin's. */
function selfIds(project) {
  const ids = new Set([String(project.id)]);
  if (project.eagleId) ids.add(eagleOnlyProjectId(project.eagleId));
  return ids;
}

/** The link record behind a project code; the destination is the Eagle public page. */
function projectLinkRecord(project, id, createdBy = 'system') {
  return {
    id,
    url: projectTarget(project),
    note: project.name || null,
    personal: false,
    createdAt: new Date().toISOString(),
    createdBy,
    updatedAt: null
  };
}

/**
 * Creates the link record for `code`, or adopts a shared one already there. Adopted when only this
 * project (or its Eagle-only twin) holds the code, whatever the url; when nobody holds it, only a
 * record the system or this same caller (`createdBy`) wrote, at this project's target or `alsoUrl`.
 * A project write that failed after its link landed leaves exactly that, and must not block the
 * retry. A personal record is never adopted: it is one staff member's own link, and the /links
 * routes refuse to edit a project's code.
 *
 * Adoption patches the record on the revision read (url to the target, `claimedBy`), so a racing
 * `releaseCreatedCode` delete gets a 412 and keeps it. A record that moved in between is judged
 * again, once.
 *
 * @param {{links: object, projects: object}} repos
 * @param {{createdBy?: string, attempt?: object, alsoUrl?: string}} [opts] `attempt` gets
 *   `created: {code, etag}` when this call wrote the record
 * @returns {Promise<boolean>} false when the code belongs to someone else
 */
async function claimCode(project, code, repos, { createdBy = 'system', attempt = null, alsoUrl = null } = {}) {
  const target = projectTarget(project);
  for (let tries = 0; tries < 2; tries++) {
    try {
      const saved = await repos.links.create(projectLinkRecord(project, code, createdBy));
      if (attempt) attempt.created = { code, etag: saved && saved._etag };
      return true;
    } catch (err) {
      if (!isConflict(err)) throw err;
    }
    const record = await repos.links.getById(code);
    if (!record) continue;
    if (!(await adoptable(project, record, repos, createdBy, alsoUrl))) return false;
    try {
      const adopted = await repos.links.repoint(code, target,
        { etag: record._etag, claimedBy: String(project.id) });
      if (adopted) {
        logger.info('[short-links] link record adopted', { projectId: project.id, code, from: record.url, to: target });
        return true;
      }
    } catch (err) {
      if (!isPreconditionFailed(err)) throw err;
    }
  }
  return false;
}

async function adoptable(project, record, repos, createdBy, alsoUrl) {
  if (record.personal === true) return false;
  const owners = await repos.projects.listShortCodeOwners(record.id);
  if (owners.length) {
    const self = selfIds(project);
    return owners.every(id => self.has(String(id)));
  }
  if (record.createdBy !== 'system' && record.createdBy !== createdBy) return false;
  return record.url === projectTarget(project) || (Boolean(alsoUrl) && record.url === alsoUrl);
}

/** The first code in order this project can claim, or null when every one is taken. */
async function claimFirstFree(project, codes, repos, attempt) {
  for (const code of codes) {
    if (await claimCode(project, code, repos, { attempt })) return code;
  }
  return null;
}

/**
 * Removes the record `ensureProjectShortLink` created in `attempt`, after the project write it was
 * minted for lost. Kept when a project holds the code now, or the record moved since it was
 * written (412): either way someone else is using it.
 *
 * @returns {Promise<boolean>} true when the record was removed
 */
async function releaseCreatedCode(attempt, repos = {}) {
  const { links = linksRepository, projects = projectsRepository } = repos;
  const created = attempt && attempt.created;
  // No etag, no proof the record is still the one this attempt wrote.
  if (!created || !created.etag) return false;
  attempt.created = null;
  if ((await projects.listShortCodeOwners(created.code)).length) {
    logger.info('[short-links] minted code now held by a project, kept', { code: created.code });
    return false;
  }
  try {
    const removed = await links.remove(created.code, { etag: created.etag });
    if (removed) logger.info('[short-links] minted code released after a lost write', { code: created.code });
    return Boolean(removed);
  } catch (err) {
    if (!isPreconditionFailed(err)) throw err;
    logger.info('[short-links] minted code changed since written, kept', { code: created.code });
    return false;
  }
}

/**
 * Points the record behind every code the project holds, current and legacy, at its target, so a
 * printed code follows the project. Each write is guarded on the revision read; one that moved in
 * between is left and listed in `lost`. Personal records and ones already on target are skipped.
 * A held code with no record, or whose record is deleted before the patch lands, is written again
 * at the target (listed in `repointed`), or `lost`. Under `only`, which narrows the pass to
 * existing records, a missing one is skipped and one deleted before the patch is `lost`.
 *
 * @param {{links?: object}} [repos]
 * @param {{only?: function(object): (boolean|Promise<boolean>), by?: string}} [opts] `only(record)`
 *   narrows which existing records move
 * @returns {Promise<{repointed: string[], lost: string[]}>}
 */
async function repointProjectLinks(project, repos = {}, { only, by = 'system' } = {}) {
  const { links = linksRepository } = repos;
  const target = projectTarget(project);
  const codes = [...new Set([project.shortCode, ...(project.legacyShortCodes || [])].filter(Boolean))];
  const result = { repointed: [], lost: [] };
  for (const code of codes) {
    const record = await links.getById(code);
    if (!record) {
      if (!only) await recreate(project, code, links, by, result);
      continue;
    }
    if (record.personal === true || record.url === target) continue;
    if (only && !(await only(record))) continue;
    let moved;
    try {
      moved = await links.repoint(code, target, { etag: record._etag });
    } catch (err) {
      if (!isPreconditionFailed(err)) throw err;
      logger.warn('[short-links] link record changed since read, not repointed',
        { projectId: project.id, code });
      result.lost.push(code);
      continue;
    }
    if (!moved) {
      // Deleted between the read and the patch.
      if (only) result.lost.push(code);
      else await recreate(project, code, links, by, result);
      continue;
    }
    result.repointed.push(code);
    logger.info('[short-links] project link repointed',
      { projectId: project.id, code, from: record.url, to: target, by });
  }
  return result;
}

async function recreate(project, code, links, by, result) {
  try {
    await links.create(projectLinkRecord(project, code, by));
  } catch (err) {
    logger.warn('[short-links] held code has no record and could not be recreated',
      { projectId: project.id, code, error: err.message });
    result.lost.push(code);
    return;
  }
  result.repointed.push(code);
  logger.warn('[short-links] held code had no record, recreated at the target',
    { projectId: project.id, code, to: projectTarget(project), by });
}

/** Copies the short-link fields off the stored row onto the row about to replace it. */
function carryShortLink(target, existing) {
  if (!existing) return target;
  for (const field of SHORT_LINK_FIELDS) {
    if (existing[field] !== undefined) target[field] = existing[field];
  }
  return target;
}

/**
 * One short link per project with a public page, minted on the write paths that own the project
 * record. The code is the name slug, suffixed on a clash, and random only when both fail.
 * Idempotent: a project already carrying a code keeps it, so a rename or a re-seed cannot orphan a
 * printed link. Only the Eagle id has a public page (`/p/<eagleId>`), so a project without one is
 * skipped rather than pointed at a URL that 404s.
 *
 * The one exception is a pre-slug random code: it is swapped for the name slug once, and kept in
 * `legacyShortCodes` with its link record, so a printed copy still resolves.
 *
 * Mutates `shortCode`, `shortCodeSource` and `legacyShortCodes` — the caller upserts the record.
 *
 * @param {object} project
 * @param {{links?: object, projects?: object}} [repos] injected by the scripts' test seams
 * @param {object} [attempt] gets `created: {code, etag}` when a record was written, for
 *   `releaseCreatedCode` should the project write then lose
 * @returns {Promise<string|null>} the code, or null when the project has no public page
 */
async function ensureProjectShortLink(project, repos = {}, attempt = null) {
  const { links = linksRepository, projects = projectsRepository } = repos;
  if (attempt) attempt.created = null;
  if (!project) return null;
  const migrating = needsSlugMigration(project);
  if (project.shortCode && !migrating) return project.shortCode;
  if (!project.eagleId) return null;

  const slug = slugify(project.name);
  const candidates = slug
    ? [slug, ...Array.from({ length: SLUG_TRIES - 1 }, (_, i) => `${slug}-${i + 2}`)]
    : [];
  let code = await claimFirstFree(project, candidates, { links, projects }, attempt);
  let source = 'name';

  if (!code && migrating) {
    // Swapping one random code for another gains a reader nothing; the flag stops a retry nightly.
    logger.warn('[short-links] no free name slug, legacy code kept',
      { projectId: project.id, shortCode: project.shortCode, slug });
    project.shortCodeSource = 'random';
    return project.shortCode;
  }
  if (!code) {
    if (slug) {
      logger.warn('[short-links] name slug taken through every suffix, minting a random code',
        { projectId: project.id, slug });
    }
    // Uniqueness is Cosmos rejecting a duplicate id, not a read-then-write; a random code is
    // retried once, as `POST /api/links` does.
    code = await claimFirstFree(project, [generateCode(), generateCode()], { links, projects }, attempt);
    if (!code) throw new Error('two random short codes collided');
    source = 'random';
  }

  if (migrating) {
    project.legacyShortCodes = [...new Set([...(project.legacyShortCodes || []), project.shortCode])];
    logger.info('[short-links] legacy code moved to legacyShortCodes',
      { projectId: project.id, from: project.shortCode, to: code });
  }
  project.shortCode = code;
  project.shortCodeSource = source;
  return code;
}

module.exports = {
  CUSTOM_CODE, generateCode, shortUrlFor, isConflict, isPreconditionFailed, slugify, needsSlugMigration,
  defaultProjectUrl, projectTarget, isWrongHostDefault,
  claimCode, carryShortLink, ensureProjectShortLink, releaseCreatedCode, repointProjectLinks
};
