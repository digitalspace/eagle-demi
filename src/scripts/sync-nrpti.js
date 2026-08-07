'use strict';

const https = require('https');
const recordsRepo = require('../repositories/records');
const projectsRepo = require('../repositories/projects');
const { systemAccess } = require('../helpers/access-sql');

const NRPTI_API_BASE = process.env.NRPTI_API_BASE ||
  'https://nrpti-api-f00029-prod.apps.silver.devops.gov.bc.ca/api/public';

const DATASETS = [
  'Order',
  'Inspection',
  'AdministrativePenalty',
  'AdministrativeSanction',
  'CourtConviction',
  'RestorativeJustice',
  'Ticket',
  'Warning',
  'Certificate',
  'Permit',
  'Agreement',
  'ConstructionPlan',
  'ManagementPlan',
  'SelfReport'
];

function normalizeProjectName(name) {
  if (!name || typeof name !== 'string') return '';
  return name
    .toLowerCase()
    .replace(/\b(conuma coal|conuma coal resources limited|chetwynd bc|chetwynd)\b/gi, '')
    .replace(/\b(project|mine|facility|expansion|phase\s+\d+|quarry|plant|terminal|operation|site)\b/gi, '')
    .replace(/[^a-z0-9]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          if (res.statusCode >= 400) {
            return reject(new Error(`HTTP ${res.statusCode}: ${data.substring(0, 100)}`));
          }
          resolve(JSON.parse(data));
        } catch (err) {
          reject(err);
        }
      });
    }).on('error', reject);
  });
}

/**
 * Resolve a compliance record to a project that ALREADY EXISTS, or null.
 *
 * Five strategies, loosest last. There is deliberately no sixth that invents a project: this used
 * to fall through to auto-seeding one from `projectName || location`, and many of those strings
 * are facilities, locations or record titles rather than EPIC projects, so the registry filled
 * with rows no project ever existed for. Track owns the registry; a sync does not add to it.
 *
 * Pure — no repository, no network — so the ladder is testable without standing up Cosmos or
 * reaching NRPTI. That is the only reason it is a function rather than inline.
 *
 * @param {{epicProjectId: any, rawProjName: string}} item
 * @param {{eagleIdToProjMap: Map, exactNameToProjMap: Map, normalizedNameToProjMap: Map}} maps
 * @returns {string|null}
 */
function resolveProjectLink({ epicProjectId, rawProjName }, maps) {
  const { eagleIdToProjMap, exactNameToProjMap, normalizedNameToProjMap } = maps;

  // Priority 1: Match by _epicProjectId
  if (epicProjectId && eagleIdToProjMap.has(String(epicProjectId))) {
    return eagleIdToProjMap.get(String(epicProjectId));
  }

  if (!rawProjName) return null;

  // Priority 2: Match by exact project name
  const exactKey = rawProjName.toLowerCase();
  if (exactNameToProjMap.has(exactKey)) {
    return exactNameToProjMap.get(exactKey);
  }

  // Priority 3: Match by normalized project name
  const normKey = normalizeProjectName(rawProjName);
  if (normKey && normalizedNameToProjMap.has(normKey)) {
    return normalizedNameToProjMap.get(normKey);
  }

  // Priority 3b: Match by multi-segment parts (split by ' - ', ',', '/', ';')
  const parts = rawProjName.split(/ - |,|\/|;/);
  for (let p = parts.length - 1; p >= 0; p--) {
    const partNorm = normalizeProjectName(parts[p]);
    if (partNorm && normalizedNameToProjMap.has(partNorm)) {
      return normalizedNameToProjMap.get(partNorm);
    }
  }

  // Priority 3c: Match by token inclusion (e.g. existing norm "brule" in "conuma coal chetwynd bc
  // brule coal mine"). Length >= 4 so a short token cannot swallow unrelated names.
  if (normKey) {
    for (const [existingNormKey, projId] of normalizedNameToProjMap.entries()) {
      if (existingNormKey.length >= 4 && (
        normKey === existingNormKey ||
        normKey.startsWith(`${existingNormKey} `) ||
        normKey.endsWith(` ${existingNormKey}`) ||
        normKey.includes(` ${existingNormKey} `)
      )) {
        return projId;
      }
    }
  }

  return null;
}

async function syncNrptiData(options = {}) {
  const sinceDate = options.since ? new Date(options.since) : null;
  console.log(`[NRPTI Sync] Starting NRPTI compliance ingestion${sinceDate ? ` (incremental since ${sinceDate.toISOString()})` : ''}...`);
  const startTime = Date.now();

  // systemAccess() — a sync reconciles the whole registry, and it takes no arguments so it
  // cannot be derived from a request. This script is never on the request path.
  const { items: existingProjects } = await projectsRepo.listVisible(systemAccess());
  // No seeded-projects-last sort here any more. It existed so a real Track project would win the
  // name maps against a phantom with the same name; `purge-nrpti-seeded.js --live` ran on dev
  // 2026-08-07 and removed all 1,855, and a second dry run reports 0. Nothing creates them — the
  // auto-seed went with Priority 4 — so there is no longer a class of project for it to order.

  const eagleIdToProjMap = new Map();
  const exactNameToProjMap = new Map();
  const normalizedNameToProjMap = new Map();

  for (const proj of existingProjects) {
    const projIdStr = String(proj.id);
    eagleIdToProjMap.set(projIdStr, projIdStr);

    // `eagleId` is the merged registry's own field; the raw payload under sources.eagle is the
    // fallback for rows that predate it.
    if (proj.eagleId) {
      eagleIdToProjMap.set(String(proj.eagleId), projIdStr);
    } else if (proj.sources?.eagle?._id) {
      eagleIdToProjMap.set(String(proj.sources.eagle._id), projIdStr);
    } else if (proj.metadata?.eagleAttributes?._id) {
      eagleIdToProjMap.set(String(proj.metadata.eagleAttributes._id), projIdStr);
    }

    if (proj.name) {
      const exactKey = proj.name.toLowerCase().trim();
      const normKey = normalizeProjectName(proj.name);
      if (!exactNameToProjMap.has(exactKey)) {
        exactNameToProjMap.set(exactKey, projIdStr);
      }
      if (normKey && !normalizedNameToProjMap.has(normKey)) {
        normalizedNameToProjMap.set(normKey, projIdStr);
      }
    }
  }

  console.log(`[NRPTI Sync] Loaded ${existingProjects.length} existing projects for linking.`);

  const maps = { eagleIdToProjMap, exactNameToProjMap, normalizedNameToProjMap };

  let totalIngested = 0;
  let totalLinkedExisting = 0;
  let totalUnlinked = 0;
  // The ONLY trace an unmatched record leaves, now that none is written. Counted by name so the
  // log says which upstream strings the linker cannot resolve, rather than just how many.
  const unlinkedNames = new Map();
  const projectStats = new Map();

  for (const dataset of DATASETS) {
    console.log(`[NRPTI Sync] Syncing dataset: ${dataset}...`);
    const pageSize = 1000;
    let pageNum = 0;
    let hasMore = true;
    let dsIngested = 0;

    while (hasMore) {
      const url = `${NRPTI_API_BASE}/search?dataset=${dataset}&pageNum=${pageNum}&pageSize=${pageSize}`;
      let response;
      try {
        response = await fetchJson(url);
      } catch (err) {
        console.error(`[NRPTI Sync] Error fetching page ${pageNum} of ${dataset}: ${err.message}`);
        break;
      }

      const results = response[0]?.searchResults || [];
      const totalCount = response[0]?.meta?.[0]?.searchResultsTotal || 0;
      const totalPages = Math.ceil(totalCount / pageSize);

      if (results.length === 0) {
        break;
      }

      console.log(`[NRPTI Sync] ${dataset} page ${pageNum + 1}/${totalPages || 1} (${results.length} items)...`);

      for (const item of results) {
        // High-water mark delta check
        if (sinceDate && item.dateIssued) {
          const itemDate = new Date(item.dateIssued);
          if (itemDate < sinceDate) continue;
        }

        const rawProjName = (item.projectName || item.location || '').trim();
        const linkedProjId = resolveProjectLink(
          { epicProjectId: item._epicProjectId, rawProjName },
          maps
        );

        // Unmatched records are DROPPED, not written. There is no unmatched bucket: a record
        // written with `projectId: ''` would sit in the empty-string partition, unreachable by any
        // scoped or per-project read while still listing publicly from `GET /records`, and
        // re-pointing it later is a delete plus an insert because `projectId` is the partition key.
        // The log line at the end of the run is the record of what was skipped.
        if (!linkedProjId) {
          totalUnlinked++;
          const key = rawProjName || '(no project name)';
          unlinkedNames.set(key, (unlinkedNames.get(key) || 0) + 1);
          continue;
        }
        totalLinkedExisting++;

        if (!projectStats.has(linkedProjId)) {
          projectStats.set(linkedProjId, { total: 0, orders: 0, inspections: 0, tickets: 0, lastDate: null });
        }
        const stats = projectStats.get(linkedProjId);
        stats.total++;
        if (dataset === 'Order') stats.orders++;
        if (dataset === 'Inspection') stats.inspections++;
        if (dataset === 'Ticket') stats.tickets++;
        if (item.dateIssued) {
          const issueDate = new Date(item.dateIssued);
          if (!stats.lastDate || issueDate > stats.lastDate) stats.lastDate = issueDate;
        }

        const dateIssued = item.dateIssued ? new Date(item.dateIssued).toISOString() : null;

        const recordDoc = {
          id: String(item._id),
          sourceSystem: 'nrpti',
          nrptiId: String(item._id),
          // `dataset`, not `nrptiSchemaName`. The latter was only ever the Typesense index field
          // name, so every query filtering on it matched nothing — no Cosmos item carries it.
          dataset: item._schemaName || dataset,
          // `projectId` is the container's PARTITION KEY, and always a real project here — the
          // unmatched path returned above rather than falling through to the empty-string
          // partition.
          projectId: String(linkedProjId),
          recordName: item.recordName || item.title || `${dataset} Record`,
          recordType: item.recordType || dataset,
          recordSubtype: item.recordSubtype || '',
          dateIssued,
          issuingAgency: item.issuingAgency || item.author || '',
          author: item.author || '',
          projectName: item.projectName || rawProjName,
          issuedToName: item.issuedTo?.fullName || item.issuedTo?.companyName || '',
          summary: item.summary || item.description || '',
          documents: Array.isArray(item.documents) ? item.documents : [],
          sourceSystemRef: item.sourceSystemRef || 'nrpti',
          isPublished: true,
          // Respect the upstream ACL when NRPTI supplies one; otherwise default to the
          // full role set. Previously these were two duplicate `read:` keys and the
          // second silently won, so demi-admin was dropped from every record.
          read: Array.isArray(item.read) && item.read.length > 0
            ? item.read
            : ['public', 'sysadmin', 'staff', 'demi-admin'],
          sourceData: item
        };

        await recordsRepo.upsert(recordDoc);
        dsIngested++;
        totalIngested++;
      }

      if ((pageNum + 1) * pageSize >= totalCount || results.length < pageSize) {
        hasMore = false;
      } else {
        pageNum++;
      }
    }

    console.log(`[NRPTI Sync] ${dataset} sync complete: ${dsIngested} records processed.`);
  }

  // Update project compliance stats
  console.log(`[NRPTI Sync] Updating compliance metrics for projects in Cosmos DB...`);
  await recalculateAllProjectComplianceStats();

  const duration = ((Date.now() - startTime) / 1000).toFixed(2);
  console.log(`[NRPTI Sync] Ingestion finished in ${duration}s. Total: ${totalIngested} records ingested (${totalLinkedExisting} linked to existing projects, ${totalUnlinked} skipped as unlinked).`);

  const unlinkedSample = Array.from(unlinkedNames.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([name, count]) => ({ name, count }));

  if (unlinkedSample.length) {
    console.log(`[NRPTI Sync] ${unlinkedNames.size} distinct unmatched project names. Top ${unlinkedSample.length}:`);
    for (const { name, count } of unlinkedSample) {
      console.log(`[NRPTI Sync]   ${count} x ${name}`);
    }
  }

  return {
    totalIngested,
    totalLinkedExisting,
    totalUnlinked,
    unlinkedDistinctNames: unlinkedNames.size,
    unlinkedSample,
    linkedProjectCount: projectStats.size
  };
}

/**
 * Roll every record up into the BOUNDED per-project aggregate.
 *
 * Records are REFERENCED, never folded in. This used to write the full record objects onto the
 * project twice — `nrptiRecords` and `sources.nrpti.records` — each carrying the raw upstream
 * payload. Roughly 250 records took a project past the 2 MB Cosmos item cap; Mongo's 16 MB limit
 * was hiding it. `/records?project=X` is a single-partition read, so nothing needs the copy.
 */
async function recalculateAllProjectComplianceStats() {
  console.log('[NRPTI Sync] Recalculating compliance stats across all records in Cosmos DB...');
  const access = systemAccess();
  const { items: records } = await recordsRepo.listVisible(access);

  const statsMap = new Map();
  for (const rec of records) {
    const pId = rec.projectId;
    if (!pId) continue;
    if (!statsMap.has(pId)) {
      statsMap.set(pId, { total: 0, orders: 0, inspections: 0, tickets: 0, lastDate: null });
    }
    const st = statsMap.get(pId);
    st.total++;
    const ds = rec.recordType || rec.dataset || '';
    if (ds === 'Order') st.orders++;
    if (ds === 'Inspection') st.inspections++;
    if (ds === 'Ticket') st.tickets++;
    if (rec.dateIssued) {
      const d = new Date(rec.dateIssued);
      if (!st.lastDate || d > st.lastDate) st.lastDate = d;
    }
  }

  console.log(`[NRPTI Sync] Aggregated compliance stats for ${statsMap.size} project identifiers.`);
  for (const [pId, st] of statsMap.entries()) {
    // The ingest phase resolved every record's projectId from this same registry, so a point
    // read hits. The eagleId lookup covers rows linked before the merge assigned Track ids.
    // The old name-regex fallback is gone with the Mongo filter interface.
    const proj = await projectsRepo.getById(access, pId) ||
      await projectsRepo.getByEagleId(access, pId);

    if (!proj) continue;

    // A patch of one path, not a read-modify-write: atomic, and it cannot erase what the Track
    // or wildfire syncs wrote in between.
    await projectsRepo.patchNrptiStats(proj.id, {
      recordCount: st.total,
      orderCount: st.orders,
      inspectionCount: st.inspections,
      ticketCount: st.tickets,
      complianceStatus: 'Active Monitoring',
      lastRecordDate: st.lastDate ? st.lastDate.toISOString() : null
    });
    console.log(`[NRPTI Sync] Recorded ${st.total} NRPTI records against project: ${proj.name || pId} (${proj.id})`);
  }
}

if (require.main === module) {
  syncNrptiData()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('[NRPTI Sync] Error during execution:', err);
      process.exit(1);
    });
}

module.exports = {
  syncNrptiData,
  recalculateAllProjectComplianceStats,
  resolveProjectLink,
  normalizeProjectName
};
