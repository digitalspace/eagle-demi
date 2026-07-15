'use strict';

/**
 * Unified Search & Database Diagnostics CLI
 *
 * Runs comprehensive health and synchronization checks:
 * 1. MongoDB connectivity, active databases, and collection counts.
 * 2. Typesense connectivity, schema integrity, and document counts.
 * 3. Compares MongoDB master records with Typesense search indexes to spot sync drift.
 * 4. Runs a mock public search to verify keyword dual-query merging works correctly.
 */

const mongoose = require('mongoose');
const config = require('../config');

// Load environment variables for Typesense
const TYPESENSE_HOST = process.env.TYPESENSE_HOST || 'eagle-typesense';
const TYPESENSE_PORT = process.env.TYPESENSE_PORT || '8108';
const TYPESENSE_PROTOCOL = process.env.TYPESENSE_PROTOCOL || 'http';
const TYPESENSE_API_KEY = process.env.TYPESENSE_API_KEY || 'local-dev-key';
const TYPESENSE_BASE = `${TYPESENSE_PROTOCOL}://${TYPESENSE_HOST}:${TYPESENSE_PORT}`;

// ASCII Colors
const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const BLUE = '\x1b[34m';
const CYAN = '\x1b[36m';

async function main() {
  console.log(`\n${BOLD}${CYAN}=====================================================${RESET}`);
  console.log(`${BOLD}${CYAN}      DEMI SYSTEM SEARCH & SYNC DIAGNOSTICS          ${RESET}`);
  console.log(`${BOLD}${CYAN}=====================================================${RESET}\n`);

  let mongoCounts = { projects: 0, documents: 0 };
  let tsCounts = { projects: 0, documents: 0, chunks: 0 };

  // ──── 1. MongoDB Health & Counts ────
  console.log(`${BOLD}${BLUE}--- [1/4] Checking MongoDB Master ---${RESET}`);
  try {
    console.log(`Connecting to MongoDB URI: ${YELLOW}${config.mongoUri.replace(/:([^@]+)@/, ':****@')}${RESET}`);
    await mongoose.connect(config.mongoUri, { directConnection: true });
    console.log(`${GREEN}✓ Connected successfully to MongoDB.${RESET}`);

    // Dynamic collections lookup
    const collections = await mongoose.connection.db.listCollections().toArray();
    const collectionNames = collections.map(c => c.name);
    console.log(`Available Collections: [ ${CYAN}${collectionNames.join(', ')}${RESET} ]`);

    // Fetch counts from schemas
    const Project = require('../models/project');
    const Document = require('../models/document');
    const Boundary = require('../models/boundary');
    const Region = require('../models/region');

    mongoCounts.projects = await Project.countDocuments();
    mongoCounts.documents = await Document.countDocuments();
    const boundaryCount = await Boundary.countDocuments();
    const regionCount = await Region.countDocuments();

    console.log(`- ${BOLD}Projects (Mongoose):${RESET}     ${GREEN}${mongoCounts.projects}${RESET}`);
    console.log(`- ${BOLD}Documents (Mongoose):${RESET}    ${GREEN}${mongoCounts.documents}${RESET}`);
    console.log(`- ${BOLD}Boundaries (Mongoose):${RESET}   ${GREEN}${boundaryCount}${RESET}`);
    console.log(`- ${BOLD}Regions (Mongoose):${RESET}      ${GREEN}${regionCount}${RESET}`);

    await mongoose.disconnect();
  } catch (err) {
    console.error(`${RED}✗ MongoDB Check Failed: ${err.message}${RESET}`);
  }

  console.log();

  // ──── 2. Typesense Health & Counts ────
  console.log(`${BOLD}${BLUE}--- [2/4] Checking Typesense Search Engine ---${RESET}`);
  try {
    console.log(`Connecting to Typesense: ${YELLOW}${TYPESENSE_BASE}${RESET}`);
    
    const healthRes = await fetch(`${TYPESENSE_BASE}/health`);
    if (!healthRes.ok) throw new Error(`Health API returned status: ${healthRes.status}`);
    const health = await healthRes.json();
    console.log(`${GREEN}✓ Typesense server is healthy. (Status: ${health.ok ? 'OK' : 'Error'})${RESET}`);

    // Check collections
    const collectionsRes = await fetch(`${TYPESENSE_BASE}/collections`, {
      headers: { 'X-TYPESENSE-API-KEY': TYPESENSE_API_KEY }
    });
    if (!collectionsRes.ok) throw new Error(`Collections API returned status: ${collectionsRes.status}`);
    const tsCollections = await collectionsRes.json();

    console.log('Indexed Collections found:');
    for (const coll of tsCollections) {
      console.log(`  • ${BOLD}${coll.name}${RESET} (fields: ${coll.fields.length}, documents: ${coll.num_documents})`);
      if (coll.name === 'projects' || coll.name.startsWith('projects_')) tsCounts.projects = coll.num_documents;
      if (coll.name === 'documents' || coll.name.startsWith('documents_')) tsCounts.documents = coll.num_documents;
      if (coll.name === 'document_chunks' || coll.name.startsWith('document_chunks_')) tsCounts.chunks = coll.num_documents;
    }
  } catch (err) {
    console.error(`${RED}✗ Typesense Check Failed: ${err.message}${RESET}`);
  }

  console.log();

  // ──── 3. Synchronization Audit ────
  console.log(`${BOLD}${BLUE}--- [3/4] Synchronization Integrity Audit ---${RESET}`);
  let syncOk = true;

  const projectDiff = mongoCounts.projects - tsCounts.projects;
  if (projectDiff !== 0) {
    syncOk = false;
    console.log(`${YELLOW}⚠ Project Count Mismatch! MongoDB (${mongoCounts.projects}) vs Typesense (${tsCounts.projects}). Drift: ${projectDiff}${RESET}`);
  } else {
    console.log(`${GREEN}✓ Project Index synchronized. (Counts match at ${mongoCounts.projects})${RESET}`);
  }

  const documentDiff = mongoCounts.documents - tsCounts.documents;
  if (documentDiff !== 0) {
    syncOk = false;
    console.log(`${YELLOW}⚠ Document Metadata Count Mismatch! MongoDB (${mongoCounts.documents}) vs Typesense (${tsCounts.documents}). Drift: ${documentDiff}${RESET}`);
  } else {
    console.log(`${GREEN}✓ Document Metadata Index synchronized. (Counts match at ${mongoCounts.documents})${RESET}`);
  }

  if (tsCounts.chunks === 0 && mongoCounts.documents > 0) {
    console.log(`${YELLOW}⚠ document_chunks index is empty. Deep-text searches will yield metadata-only hits only.${RESET}`);
  } else {
    console.log(`${GREEN}✓ Page-level deep text chunks found: ${tsCounts.chunks} partitions.${RESET}`);
  }

  if (syncOk) {
    console.log(`${BOLD}${GREEN}✓ SUCCESS: MongoDB and Typesense indexes are in perfect sync.${RESET}`);
  } else {
    console.log(`${BOLD}${YELLOW}⚠ WARNING: Sync drift detected. Run nightly sync or manual full rebuild to resolve.${RESET}`);
  }

  console.log();

  // ──── 4. Mock Search Integration Test ────
  console.log(`${BOLD}${BLUE}--- [4/4] Keyword Dual-Query Integration Test ---${RESET}`);
  const testKeywords = process.argv[2] || 'frog';
  console.log(`Testing keyword search with: "${BOLD}${CYAN}${testKeywords}${RESET}"`);

  try {
    const filterBy = 'allowed_roles:=[public, sysadmin, staff]';
    const docsUrl = `${TYPESENSE_BASE}/collections/documents/documents/search?q=${encodeURIComponent(testKeywords)}&query_by=displayName,documentFileName,description,projectName&per_page=5&filter_by=${encodeURIComponent(filterBy)}`;
    const chunksUrl = `${TYPESENSE_BASE}/collections/document_chunks/documents/search?q=${encodeURIComponent(testKeywords)}&query_by=content&group_by=documentId&group_limit=1&per_page=5&filter_by=${encodeURIComponent(filterBy)}`;

    const [docsRes, chunksRes] = await Promise.all([
      fetch(docsUrl, { headers: { 'X-TYPESENSE-API-KEY': TYPESENSE_API_KEY } }),
      fetch(chunksUrl, { headers: { 'X-TYPESENSE-API-KEY': TYPESENSE_API_KEY } })
    ]);

    const docsData = await docsRes.json();
    const chunksData = await chunksRes.json();

    const docHits = docsData.hits ? docsData.hits.length : 0;
    const chunkHits = chunksData.grouped_hits ? chunksData.grouped_hits.length : 0;

    console.log(`- Metadata-only matches: ${GREEN}${docHits}${RESET}`);
    console.log(`- Deep-text chunk matches: ${GREEN}${chunkHits}${RESET}`);

    // Merging Demo Simulation
    const mergedMap = new Map();
    (docsData.hits || []).forEach(h => mergedMap.set(h.document.id, h.document.displayName));
    (chunksData.grouped_hits || []).forEach(g => mergedMap.set(g.group_key[0], g.hits[0].document.documentFileName));

    console.log(`- Total unique merged documents resolved: ${BOLD}${GREEN}${mergedMap.size}${RESET}`);
    if (mergedMap.size > 0) {
      console.log('Sample matching document titles:');
      let i = 0;
      for (const [id, val] of mergedMap.entries()) {
        console.log(`  • [${CYAN}${id}${RESET}] ${val}`);
        if (++i >= 3) break;
      }
    }
  } catch (err) {
    console.error(`${RED}✗ Integration Search Test Failed: ${err.message}${RESET}`);
  }

  console.log(`\n${BOLD}${CYAN}=====================================================${RESET}\n`);
}

main().catch(err => {
  console.error('Fatal execution error:', err);
  process.exit(1);
});
