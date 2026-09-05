'use strict';

/**
 * Short-link codes, the `/s/<code>` URL shape, and the one project link. The link controller and
 * the project write paths both mint codes, so the alphabet and the collision retry live here.
 */

const crypto = require('crypto');
const config = require('../config');
const linksRepository = require('../repositories/links');

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

/**
 * One short link per project with a public page, minted on the write paths that own the project
 * record. Idempotent: a project already carrying a code keeps it, so re-seeding cannot orphan a
 * printed link. Only the Eagle id has a public page (`/p/<eagleId>`), so a project without one is
 * skipped rather than pointed at a URL that 404s.
 *
 * Mutates `project.shortCode` — the caller upserts the record it was handed.
 *
 * @param {object} project
 * @param {object} [repo] links repository, injected by the scripts' test seams
 * @returns {Promise<string|null>} the code, or null when the project has no public page
 */
async function ensureProjectShortLink(project, repo = linksRepository) {
  if (!project) return null;
  if (project.shortCode) return project.shortCode;
  if (!project.eagleId) return null;

  const record = {
    id: generateCode(),
    url: `${config.linkBaseUrl}/p/${project.eagleId}`,
    note: project.name || null,
    personal: false,
    createdAt: new Date().toISOString(),
    createdBy: 'system',
    updatedAt: null
  };

  try {
    await repo.create(record);
  } catch (err) {
    if (!isConflict(err)) throw err;
    // Uniqueness is Cosmos rejecting a duplicate id, not a read-then-write; retried once, as
    // `POST /api/links` does.
    record.id = generateCode();
    await repo.create(record);
  }

  project.shortCode = record.id;
  return record.id;
}

module.exports = { generateCode, shortUrlFor, isConflict, ensureProjectShortLink };
