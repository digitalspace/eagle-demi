'use strict';

const { writeGuarded } = require('../helpers/etag-write');
const { eagleBaseAcl } = require('../helpers/eagle-acl');
const { auditEvent } = require('../utils/audit');
const { logger } = require('../utils/logger');

/**
 * The one write path for domain modules: etag-guarded, rebuilt from the stored row on every lost
 * race, and audited once when it lands.
 *
 * @param {object} options
 * @param {{req: object}} options.ctx `req` supplies the audit identity
 * @param {{upsert: (row: object, current: object|null) => Promise<object>}} options.repo
 * @param {object|null} options.existing the row the domain loaded, `null` for a create
 * @param {() => Promise<object|null>} options.reread the stored row again after a lost race
 * @param {(current: object|null) => object|null} options.build the row to store; `null` = the row
 *   is gone
 * @param {(saved: object, from: object|null) => object} options.audit the audit event for this
 *   write; `from` is the row it replaced
 * @returns {Promise<{status: 'ok', value: object, created: boolean} | {status: 'not-found'} |
 *   {status: 'busy'}>}
 */
async function writeRow({ ctx, repo, existing = null, reread, build, audit }) {
  if (typeof audit !== 'function') throw new TypeError('writeRow needs an audit builder');
  if (typeof build !== 'function') throw new TypeError('writeRow needs a build function');
  // Checked here because writeGuarded only calls it after a lost race, which no test may reach.
  if (typeof reread !== 'function') throw new TypeError('writeRow needs a reread function');

  const written = await writeGuarded({
    existing,
    reread,
    attempt: async (current) => {
      const row = await build(current);
      if (!row) return { status: 'not-found' };
      return { status: 'ok', from: current, saved: await repo.upsert(row, current) };
    },
    onLost: (current, attempt) =>
      logger.warn('[Domain] write lost its etag race, rebuilding', { id: current && current.id, attempt })
  });

  if (written.status === 'conflict') return { status: 'busy' };
  if (written.status !== 'ok') return written;

  const event = audit(written.saved, written.from);
  auditEvent(ctx.req, event);
  logger.info(`[Domain] ${event.action} ${written.saved.id}`, { action: event.action, id: written.saved.id });
  return { status: 'ok', value: written.saved, created: written.from === null };
}

/** The two reads a publish toggle moves a row between: staff-only, or open to the public too. */
const STAFF_READ = Object.freeze(['staff', 'sysadmin']);
const PUBLIC_READ = Object.freeze(['public', ...STAFF_READ]);

/** `read` with `public` added or taken out; other entries are kept, and an emptied read falls back to staff. */
function readWith(read, published) {
  const rest = eagleBaseAcl(read).filter(r => r !== 'public');
  const base = rest.length ? rest : [...STAFF_READ];
  return published ? ['public', ...base] : base;
}

module.exports = { writeRow, readWith, STAFF_READ, PUBLIC_READ };
