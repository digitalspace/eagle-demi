'use strict';

/**
 * extract.js — Bulk document extraction worker for eagle-demi.
 *
 * Queries MongoDB for unextracted Documents, downloads each file from MinIO,
 * sends to docling-serve for text extraction, and writes DocumentChunk records
 * back to MongoDB. eagle-typesense Change Stream picks up the new chunks and
 * syncs them to Typesense automatically.
 *
 * Supported file types: PDF (including scanned/OCR), DOCX, DOC, PPTX, XLSX
 * (anything docling-serve supports — configured server-side).
 *
 * Usage:
 *   node src/extract.js                     # full batch (resumable)
 *   node src/extract.js --retry-failed      # re-extract previous failures
 *   node src/extract.js --doc-id <mongoId>  # single document
 *   node src/extract.js --dry-run           # count eligible only
 *
 * Exit codes: 0 = success, 1 = fatal error
 */

// Node 20+ provides fetch, FormData, Blob as globals — no import needed.
const { MongoClient, ObjectId } = require('mongodb');
const Minio  = require('minio');
const config = require('./config');
const { chunkMarkdown } = require('./chunker');

// File extensions handled by docling-serve
const SUPPORTED_EXTENSIONS = new Set([
  'pdf', 'PDF', '.pdf', '.PDF',
  'docx', 'DOCX', '.docx', '.DOCX',
  'doc',  'DOC',  '.doc',  '.DOC',
  'pptx', 'PPTX', '.pptx', '.PPTX',
  'xlsx', 'XLSX', '.xlsx', '.XLSX',
]);

// Only process published, non-deleted documents
const BASE_FILTER = {
  _schemaName: 'Document',
  isDeleted:   { $ne: true },
  read:        'public',
};

// ── MongoDB helpers ───────────────────────────────────────────────────────────

async function getDb(client) {
  return client.db(config.mongoDb);
}

/**
 * Build id→name lookup for Projects so chunks get a denormalised projectName.
 */
async function buildProjectLookup(db) {
  const projects = await db.collection('epic')
    .find({ _schemaName: 'Project' }, { projection: { _id: 1, name: 1 } })
    .toArray();
  return new Map(projects.map(p => [p._id.toString(), p.name || '']));
}

/**
 * Build id→label lookup for List items (type, milestone, etc.)
 */
async function buildListLookup(db) {
  const lists = await db.collection('epic')
    .find({ _schemaName: 'List' }, { projection: { _id: 1, name: 1 } })
    .toArray();
  return new Map(lists.map(l => [l._id.toString(), l.name || '']));
}

function resolveLabel(val, listLookup) {
  if (!val) return undefined;
  const s = val.toString();
  if (listLookup && listLookup.has(s)) return listLookup.get(s);
  return s;
}

// ── MinIO helper ──────────────────────────────────────────────────────────────

function getMinioClient() {
  return new Minio.Client({
    endPoint:  config.minioHost,
    port:      config.minioPort,
    useSSL:    config.minioSsl,
    accessKey: config.minioAccess,
    secretKey: config.minioSecret,
  });
}

/**
 * Download a MinIO object and return it as a Buffer.
 */
async function downloadFromMinio(minioClient, objectPath) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    minioClient.getObject(config.minioBucket, objectPath, (err, stream) => {
      if (err) return reject(err);
      stream.on('data', chunk => chunks.push(chunk));
      stream.on('end',  ()    => resolve(Buffer.concat(chunks)));
      stream.on('error', reject);
    });
  });
}

// ── docling-serve helper ──────────────────────────────────────────────────────

/**
 * Send a file buffer to docling-serve and return the extracted markdown.
 * @param {Buffer} buffer
 * @param {string} filename  - used for MIME detection by docling-serve
 * @returns {Promise<string>}
 */
async function extractWithDocling(buffer, filename) {
  const form = new FormData();
  form.append('files', new Blob([buffer]), filename);
  form.append(
    'options',
    JSON.stringify({ to_formats: ['md'], return_as_file: false }),
    { type: 'application/json' },
  );

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.doclingTimeout);

  try {
    const res = await fetch(`${config.doclingUrl}/v1/convert/file`, {
      method:  'POST',
      headers: { 'X-Api-Key': config.doclingKey },
      body:    form,
      signal:  controller.signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`docling-serve HTTP ${res.status}: ${text.slice(0, 200)}`);
    }

    const json = await res.json();
    // docling-serve returns { document: { md_content: "..." }, ... }
    const md = json?.document?.md_content || json?.documents?.[0]?.md_content || '';
    if (!md) throw new Error('docling-serve returned empty markdown');
    return md;
  } finally {
    clearTimeout(timer);
  }
}

// ── Chunk persistence ─────────────────────────────────────────────────────────

/**
 * Delete existing chunks for a document and insert fresh ones.
 * Returns the count of chunks written.
 */
async function replaceChunks(db, docId, doc, pageChunks, projectName, listLookup) {
  const col = db.collection('epic');

  // Delete stale chunks first so re-runs stay clean
  await col.deleteMany({ _schemaName: 'DocumentChunk', document: new ObjectId(docId) });

  if (pageChunks.length === 0) return 0;

  const records = pageChunks.map(({ pageNumber, chunkIndex, content }) => ({
    _schemaName:  'DocumentChunk',
    document:     new ObjectId(docId),
    project:      doc.project || undefined,
    pageNumber,
    chunkIndex,
    content,
    documentName: doc.displayName || doc.documentFileName || '',
    projectName:  projectName || undefined,
    documentType: resolveLabel(doc.type, listLookup),
    milestone:    resolveLabel(doc.milestone, listLookup),
    datePosted:   doc.datePosted || undefined,
    read:         doc.read,
    dateAdded:    Date.now(),
  }));

  await col.insertMany(records, { ordered: false });
  return records.length;
}

/**
 * Mark a Document record with extraction outcome.
 */
async function markDocument(db, docId, pageCount, error) {
  const col = db.collection('epic');
  const update = error
    ? { $set: { contentExtracted: true, contentExtractedAt: new Date(), contentPageCount: 0, contentExtractionError: String(error), extractionMethod: 'docling' } }
    : { $set: { contentExtracted: true, contentExtractedAt: new Date(), contentPageCount: pageCount, contentExtractionError: null, extractionMethod: 'docling' } };
  await col.updateOne({ _id: new ObjectId(docId) }, update);
}

// ── Core per-document logic ───────────────────────────────────────────────────

async function processDocument(db, minioClient, doc, projectLookup, listLookup) {
  const docId      = doc._id.toString();
  const objectPath = doc.internalURL;

  if (!objectPath) {
    await markDocument(db, docId, 0, 'No internalURL');
    return { docId, status: 'skipped', reason: 'no internalURL' };
  }

  try {
    const buffer   = await downloadFromMinio(minioClient, objectPath);
    const filename = doc.documentFileName || objectPath.split('/').pop() || 'document';
    const markdown = await extractWithDocling(buffer, filename);
    const chunks   = chunkMarkdown(markdown);

    const projectName = doc.project ? projectLookup.get(doc.project.toString()) : undefined;
    const count       = await replaceChunks(db, docId, doc, chunks, projectName, listLookup);

    await markDocument(db, docId, count, null);
    return { docId, status: 'ok', chunks: count };
  } catch (err) {
    await markDocument(db, docId, 0, err.message);
    return { docId, status: 'error', reason: err.message };
  }
}

// ── Entry point ───────────────────────────────────────────────────────────────

async function main() {
  const args        = process.argv.slice(2);
  const retryFailed = args.includes('--retry-failed');
  const dryRun      = args.includes('--dry-run');
  const docIdIdx    = args.indexOf('--doc-id');
  const docIdArg    = docIdIdx !== -1 ? args[docIdIdx + 1] : null;

  const client = new MongoClient(config.mongoUri);
  await client.connect();
  const db = await getDb(client);
  const col = db.collection('epic');

  try {
    // ── Build filter ────────────────────────────────────────────────────────
    let filter;

    if (docIdArg) {
      // Single-document mode: override everything
      filter = { _schemaName: 'Document', _id: new ObjectId(docIdArg) };
    } else {
      filter = {
        ...BASE_FILTER,
        internalURL: { $exists: true, $ne: '' },
        internalExt: { $in: [...SUPPORTED_EXTENSIONS] },
      };

      if (retryFailed) {
        // Re-extract documents that failed previously (error set, zero chunks)
        filter.contentExtracted    = true;
        filter.contentPageCount    = 0;
        filter.contentExtractionError = { $ne: null };
      } else {
        // Default: only documents never successfully extracted
        filter.contentExtracted = { $ne: true };
      }
    }

    const total = await col.countDocuments(filter);
    console.log(`\nMode: ${docIdArg ? `single doc ${docIdArg}` : retryFailed ? 'retry-failed' : 'full batch'}`);
    console.log(`Eligible documents: ${total}`);

    if (dryRun || total === 0) {
      await client.close();
      return;
    }

    // ── Load lookups ────────────────────────────────────────────────────────
    const [projectLookup, listLookup] = await Promise.all([
      buildProjectLookup(db),
      buildListLookup(db),
    ]);

    // ── Process in batches ──────────────────────────────────────────────────
    const minio = getMinioClient();
    const docs  = await col.find(filter, {
      projection: {
        _id: 1, internalURL: 1, project: 1,
        displayName: 1, documentFileName: 1,
        type: 1, milestone: 1, datePosted: 1, read: 1,
      },
    }).toArray();

    let ok = 0, errors = 0, skipped = 0;

    for (const doc of docs) {
      const result = await processDocument(db, minio, doc, projectLookup, listLookup);
      if (result.status === 'ok')      { ok++;      console.log(`  ✓ ${result.docId} — ${result.chunks} chunks`); }
      else if (result.status === 'skipped') { skipped++; console.log(`  - ${result.docId} — skipped: ${result.reason}`); }
      else                             { errors++;  console.error(`  ✗ ${result.docId} — ${result.reason}`); }
    }

    console.log(`\nDone. ok=${ok} errors=${errors} skipped=${skipped}`);
  } finally {
    await client.close();
  }
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
