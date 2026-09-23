'use strict';

/**
 * Short-link codes, the `/s/<code>` URL shape, and the one project link. The link controller and
 * the project write paths both mint codes, so the alphabet and the collision retry live here.
 */

const crypto = require('crypto');
const config = require('../config');
const linksRepository = require('../repositories/links');
const projectsRepository = require('../repositories/projects');
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

/** Vanity codes. Anything outside this alphabet cannot be a Cosmos id or a clean URL segment. */
const CUSTOM_CODE = /^[a-z0-9_-]{3,64}$/;

/** A code `generateCode` minted. Only these, on a row with no `shortCodeSource`, are migrated. */
const RANDOM_CODE = new RegExp(`^[${CODE_ALPHABET}]{${GENERATED_CODE_LENGTH}}$`);
const SLUG_MAX_LENGTH = 40;
/** `<slug>`, then `<slug>-2` ... `<slug>-5`, then a random code. */
const SLUG_TRIES = 5;

/** The project fields a whole-item upsert must carry across, or a printed link goes dead. */
const SHORT_LINK_FIELDS = ['shortCode', 'shortCodeSource', 'legacyShortCodes'];

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

function projectUrl(project) {
  return `${config.linkBaseUrl}/p/${project.eagleId}`;
}

/** The link record behind a project code; the destination is the Eagle public page. */
function projectLinkRecord(project, id, createdBy = 'system') {
  return {
    id,
    url: projectUrl(project),
    note: project.name || null,
    personal: false,
    createdAt: new Date().toISOString(),
    createdBy,
    updatedAt: null
  };
}

/**
 * Creates the link record for `code`, or adopts one already there when it is this project's own
 * leftover: pointing at this project's page, and claimed by no other project. A project write that
 * failed after its link landed leaves exactly that, and must not block the retry.
 *
 * @param {{links: object, projects: object}} repos
 * @returns {Promise<boolean>} false when the code belongs to someone else
 */
async function claimCode(project, code, repos, createdBy = 'system') {
  try {
    await repos.links.create(projectLinkRecord(project, code, createdBy));
    return true;
  } catch (err) {
    if (!isConflict(err)) throw err;
  }
  const record = await repos.links.getById(code);
  if (!record || record.url !== projectUrl(project)) return false;
  const owners = await repos.projects.listShortCodeOwners(code);
  return owners.every(id => id === String(project.id));
}

/** The first code in order this project can claim, or null when every one is taken. */
async function claimFirstFree(project, codes, repos) {
  for (const code of codes) {
    if (await claimCode(project, code, repos)) return code;
  }
  return null;
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
 * @returns {Promise<string|null>} the code, or null when the project has no public page
 */
async function ensureProjectShortLink(project, repos = {}) {
  const { links = linksRepository, projects = projectsRepository } = repos;
  if (!project) return null;
  const migrating = needsSlugMigration(project);
  if (project.shortCode && !migrating) return project.shortCode;
  if (!project.eagleId) return null;

  const slug = slugify(project.name);
  const candidates = slug
    ? [slug, ...Array.from({ length: SLUG_TRIES - 1 }, (_, i) => `${slug}-${i + 2}`)]
    : [];
  let code = await claimFirstFree(project, candidates, { links, projects });
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
    code = await claimFirstFree(project, [generateCode(), generateCode()], { links, projects });
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
  CUSTOM_CODE, generateCode, shortUrlFor, isConflict, slugify, needsSlugMigration,
  claimCode, carryShortLink, ensureProjectShortLink
};
