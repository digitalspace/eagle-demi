'use strict';

/**
 * One-off backfill: populate the read[] ACL on records that predate it.
 *
 * Visibility is now decided by read[] (see src/helpers/access.js). Existing rows only
 * carry the isPublished boolean, so translate it:
 *
 *   isPublished === true  ->  ['public', 'sysadmin', 'staff', 'demi-admin']
 *   anything else         ->  ['sysadmin', 'staff', 'demi-admin']   (fail closed)
 *
 * Idempotent — rows that already have a non-empty read[] are left untouched.
 *
 * Usage:
 *   node src/scripts/backfill-read-acl.js [--dry-run]
 */

const { initCosmosClient, getContainer } = require('../db/cosmos');
const { SECURE_ROLES } = require('../helpers/access');

const COLLECTIONS = ['projects', 'documents', 'records'];

const PUBLIC_ACL = ['public', ...SECURE_ROLES];
const PRIVATE_ACL = [...SECURE_ROLES];

async function backfill({ dryRun = false } = {}) {
  await initCosmosClient();

  const summary = [];

  for (const name of COLLECTIONS) {
    const col = getContainer(name);
    if (!col) {
      console.warn(`[backfill] collection "${name}" unavailable, skipping`);
      continue;
    }

    // Only touch rows with no usable ACL.
    const needsAcl = { $or: [{ read: { $exists: false } }, { read: { $size: 0 } }] };

    // Mirrors readFilter()'s three tiers exactly, so running this is a no-op in terms of
    // who can see what — it just makes the implicit state explicit, which lets the legacy
    // "no isPublished field" clause be deleted from readFilter afterwards.
    //   isPublished === true          -> public
    //   isPublished absent (legacy)   -> public (these were already served publicly)
    //   isPublished === false         -> private
    // $and, not spread — two $or keys in one object would silently overwrite each other.
    const toPublic = {
      $and: [needsAcl, { $or: [{ isPublished: true }, { isPublished: { $exists: false } }] }]
    };
    const toPrivate = { $and: [needsAcl, { isPublished: false }] };

    const publicCount = await col.countDocuments(toPublic);
    const privateCount = await col.countDocuments(toPrivate);

    if (!dryRun) {
      if (publicCount > 0) await col.updateMany(toPublic, { $set: { read: PUBLIC_ACL } });
      if (privateCount > 0) await col.updateMany(toPrivate, { $set: { read: PRIVATE_ACL } });
    }

    summary.push({ collection: name, madePublic: publicCount, madePrivate: privateCount });
    console.log(
      `[backfill] ${name}: ${publicCount} -> public ACL, ${privateCount} -> private ACL` +
      (dryRun ? ' (dry run, nothing written)' : '')
    );
  }

  return summary;
}

if (require.main === module) {
  const dryRun = process.argv.includes('--dry-run');
  backfill({ dryRun })
    .then(() => {
      console.log('[backfill] done');
      process.exit(0);
    })
    .catch(err => {
      console.error('[backfill] failed:', err.message);
      process.exit(1);
    });
}

module.exports = { backfill };
