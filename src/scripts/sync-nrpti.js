'use strict';

const https = require('https');
const Record = require('../models/record');
const Project = require('../models/project');
const { initCosmosClient } = require('../db/cosmos');

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

function simpleHash(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) - hash + str.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
}

async function syncNrptiData(options = {}) {
  const sinceDate = options.since ? new Date(options.since) : null;
  console.log(`[NRPTI Sync] Starting NRPTI compliance ingestion${sinceDate ? ` (incremental since ${sinceDate.toISOString()})` : ''}...`);
  const startTime = Date.now();

  const existingProjects = await Project.find();
  existingProjects.sort((a, b) => {
    const aIsAuto = a.metadata?.sourceSystem === 'nrpti' ? 1 : 0;
    const bIsAuto = b.metadata?.sourceSystem === 'nrpti' ? 1 : 0;
    return aIsAuto - bIsAuto;
  });

  const eagleIdToProjMap = new Map();
  const exactNameToProjMap = new Map();
  const normalizedNameToProjMap = new Map();

  for (const proj of existingProjects) {
    const projIdStr = String(proj._id);
    eagleIdToProjMap.set(projIdStr, projIdStr);

    if (proj.sources?.eagle?._id) {
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

  let totalIngested = 0;
  let totalLinkedExisting = 0;
  let totalAutoSeededProjects = 0;
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
        hasMore = false;
        break;
      }

      console.log(`[NRPTI Sync] ${dataset} page ${pageNum + 1}/${totalPages || 1} (${results.length} items)...`);

      for (const item of results) {
        // High-water mark delta check
        if (sinceDate && item.dateIssued) {
          const itemDate = new Date(item.dateIssued);
          if (itemDate < sinceDate) continue;
        }

        let linkedProjId = null;
        const rawProjName = (item.projectName || item.location || '').trim();

        // Priority 1: Match by _epicProjectId
        if (item._epicProjectId && eagleIdToProjMap.has(String(item._epicProjectId))) {
          linkedProjId = eagleIdToProjMap.get(String(item._epicProjectId));
        }

        // Priority 2: Match by exact project name
        if (!linkedProjId && rawProjName) {
          const exactKey = rawProjName.toLowerCase();
          if (exactNameToProjMap.has(exactKey)) {
            linkedProjId = exactNameToProjMap.get(exactKey);
          }
        }

        // Priority 3: Match by normalized project name
        if (!linkedProjId && rawProjName) {
          const normKey = normalizeProjectName(rawProjName);
          if (normKey && normalizedNameToProjMap.has(normKey)) {
            linkedProjId = normalizedNameToProjMap.get(normKey);
          }
        }

        // Priority 3b: Match by multi-segment parts (split by ' - ', ',', '/', ';')
        if (!linkedProjId && rawProjName) {
          const parts = rawProjName.split(/ - |,|\/|;/);
          for (let p = parts.length - 1; p >= 0; p--) {
            const partNorm = normalizeProjectName(parts[p]);
            if (partNorm && normalizedNameToProjMap.has(partNorm)) {
              linkedProjId = normalizedNameToProjMap.get(partNorm);
              break;
            }
          }
        }

        // Priority 3c: Match by token inclusion (e.g. existing norm "brule" in "conuma coal chetwynd bc brule coal mine")
        if (!linkedProjId && rawProjName) {
          const normRaw = normalizeProjectName(rawProjName);
          if (normRaw) {
            for (const [existingNormKey, projId] of normalizedNameToProjMap.entries()) {
              if (existingNormKey.length >= 4 && (normRaw === existingNormKey || normRaw.startsWith(`${existingNormKey} `) || normRaw.endsWith(` ${existingNormKey}`) || normRaw.includes(` ${existingNormKey} `))) {
                linkedProjId = projId;
                break;
              }
            }
          }
        }

        // Priority 4: Auto-seed new project if unmatched!
        if (!linkedProjId && rawProjName) {
          const exactKey = rawProjName.toLowerCase().trim();
          const normKey = normalizeProjectName(rawProjName);
          const syntheticTrackId = 8000000 + (simpleHash(rawProjName) % 1000000);
          const newProjId = String(syntheticTrackId);

          const seededProject = {
            _id: newProjId,
            id: newProjId,
            trackProjectId: syntheticTrackId,
            name: rawProjName,
            region: item.location || 'BC',
            regionalDistrict: '',
            municipality: '',
            electoralDistrict: '',
            description: `Auto-seeded from NRPTI compliance records for ${rawProjName}.`,
            proponentName: item.issuedTo?.companyName || item.issuedTo?.fullName || '',
            projectState: 'Compliance Record Ingest',
            projectType: dataset || 'Compliance',
            centroid: {
              type: 'Point',
              coordinates: [-123.3656, 48.4284]
            },
            isPublished: true,
            read: ['public', 'sysadmin', 'staff', 'demi-admin'],
            read: ['sysadmin', 'staff', 'public'],
            sources: {
              track: null,
              eagle: null,
              nrpti: {
                recordCount: 0,
                orderCount: 0,
                inspectionCount: 0,
                ticketCount: 0,
                lastRecordDate: null,
                isPrimarySource: true
              }
            },
            metadata: {
              sourceSystem: 'nrpti',
              seededFromNrpti: true,
              seededAt: new Date().toISOString()
            }
          };

          await Project.upsert(seededProject);
          linkedProjId = newProjId;
          totalAutoSeededProjects++;

          exactNameToProjMap.set(exactKey, newProjId);
          if (normKey) normalizedNameToProjMap.set(normKey, newProjId);
        } else if (linkedProjId) {
          totalLinkedExisting++;
        }

        if (linkedProjId) {
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
        }

        const dateIssued = item.dateIssued ? new Date(item.dateIssued).toISOString() : null;

        const recordDoc = {
          _id: String(item._id),
          id: String(item._id),
          nrptiId: String(item._id),
          nrptiSchemaName: item._schemaName || dataset,
          project: linkedProjId ? String(linkedProjId) : '',
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
          read: ['public', 'sysadmin', 'staff', 'demi-admin'],
          read: Array.isArray(item.read) ? item.read : ['sysadmin', 'staff', 'public'],
          sourceData: item
        };

        await Record.upsert(recordDoc);
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
  console.log(`[NRPTI Sync] Ingestion finished in ${duration}s. Total: ${totalIngested} records (${totalLinkedExisting} linked existing, ${totalAutoSeededProjects} auto-seeded new projects).`);

  return { totalIngested, totalLinkedExisting, totalAutoSeededProjects, linkedProjectCount: projectStats.size };
}

async function recalculateAllProjectComplianceStats() {
  console.log('[NRPTI Sync] Recalculating compliance stats across all records in Cosmos DB...');
  const records = await Record.find({ isPublished: true });
  
  const statsMap = new Map();
  for (const rec of records) {
    const pId = rec.project;
    if (!pId) continue;
    if (!statsMap.has(pId)) {
      statsMap.set(pId, { total: 0, orders: 0, inspections: 0, tickets: 0, lastDate: null, records: [] });
    }
    const st = statsMap.get(pId);
    st.total++;
    st.records.push(rec);
    const ds = rec.recordType || rec.nrptiSchemaName || '';
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
    let proj = await Project.findById(pId);
    if (!proj) {
      const escaped = String(pId).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      proj = await Project.findOne({
        $or: [
          { legacyEagleId: String(pId) },
          { trackProjectId: isNaN(pId) ? -1 : Number(pId) },
          { name: { $regex: `^${escaped}$`, $options: 'i' } }
        ]
      });
    }
    if (proj) {
      if (!proj.sources) proj.sources = {};
      proj.nrptiRecords = st.records;
      proj.sources.nrpti = {
        recordCount: st.total,
        orderCount: st.orders,
        inspectionCount: st.inspections,
        ticketCount: st.tickets,
        complianceStatus: 'Active Monitoring',
        lastRecordDate: st.lastDate ? st.lastDate.toISOString() : null,
        records: st.records
      };
      await Project.upsert(proj);
      console.log(`[NRPTI Sync] Folded ${st.total} NRPTI records into project: ${proj.name || pId} (${proj._id})`);
    }
  }
}

if (require.main === module) {
  initCosmosClient()
    .then(async () => {
      await syncNrptiData();
      process.exit(0);
    })
    .catch((err) => {
      console.error('[NRPTI Sync] Error during execution:', err);
      process.exit(1);
    });
}

module.exports = { syncNrptiData, recalculateAllProjectComplianceStats };
