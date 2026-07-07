# DFL Phase 1 - Technical Implementation Plan
Target System: eagle-api (Node.js/Express/MongoDB) & eagle-typesense  
Target Platform: OpenShift Silver  

---

## 1. Schema Extensions (eagle-api)

Extend Mongoose schemas to support Track Master IDs, EDRMS tagging metadata, and strict project-document integrity.

### A. Project Schema (eagle-api/api/helpers/models/project.js)
Add trackProjectId sparse, unique index:
```javascript
trackProjectId: { 
  type: Number, 
  unique: true, 
  sparse: true, 
  index: true 
}
```

### B. Document Schema (eagle-api/api/helpers/models/document.js)
1. Enforce mandatory project constraint.
2. Reserve fields for deferred EDRMS migration.
```javascript
project: { 
  type: 'ObjectId', 
  ref: 'Project', 
  required: [true, 'A document must always belong to a valid project.'] 
},
edrmsRecordNumber: { 
  type: String, 
  unique: true, 
  sparse: true, 
  index: true 
},
orcsClassification: { 
  type: String, 
  index: true 
}
```

---

## 2. Mongoose Database Migration

Perform a one-time data migration to populate trackProjectId for historical projects.

1. Mapping Asset: Save postgres-derived mappings in JSON format:
   * Path: eagle-api/migrations_data/track_project_mappings.json
   * Format:
     ```json
     [
       { "id": 129, "epic_guid": "588510b0aaecd9001b8142a1" },
       { "id": 130, "epic_guid": "588510b0aaecd9001b8142a2" }
     ]
     ```

2. Migration Script:
   * Path: eagle-api/migrations/YYYYMMDDHHMMSS-add-track-project-ids.js
   * Implementation:
     ```javascript
     const mongoose = require('mongoose');
     const fs = require('fs');
     const path = require('path');

     module.exports = {
       async up(db, client) {
         const mappingsPath = path.join(__dirname, '../migrations_data/track_project_mappings.json');
         if (!fs.existsSync(mappingsPath)) return;
         
         const mappings = JSON.parse(fs.readFileSync(mappingsPath, 'utf8'));
         const projectCollection = db.collection('projects');

         for (const map of mappings) {
           await projectCollection.updateOne(
             { _id: new mongoose.Types.ObjectId(map.epic_guid) },
             { $set: { trackProjectId: Number(map.id) } }
           );
         }
       },

       async down(db, client) {
         await db.collection('projects').updateMany({}, { $unset: { trackProjectId: "" } });
       }
     };
     ```

---

## 3. DEMI Express API Architecture (eagle-demi)

To establish DEMI as the central master registry, we introduce a lightweight Express API service (`demi-api`) inside the `eagle-demi` repository. This service runs alongside `docling-serve` and connects to the central MongoDB instance.

### A. Endpoint Specifications
The service exposes the following endpoints:

* **GET /api/projects**
  * Returns the full list of active projects mapped to `trackProjectId` values.
  * Used by Eagle and Track during initialization and fallback caching.

* **PUT /api/projects/:trackProjectId**
  * Invoked by Track when a project is created, modified, or transitions phases.
  * Updates the master metadata and the `isPublished` visibility status in MongoDB.

* **POST /api/documents**
  * Invoked by `epic.submit` or admin upload tools to register new documents.
  * Saves metadata, stores the PDF in MinIO, and queues the file for async text extraction.

* **GET /api/search**
  * Public-facing search endpoint. Proxies and gates search queries to Typesense based on the client's Keycloak roles.

### B. Deployment Manifest Changes
Update the `eagle-demi` Helm chart to run the Express API as a cluster-internal Service with an OpenShift Route (for Track external webhooks) in `values.yaml`.

---

## 4. URL Redirection Middleware (eagle-api)

Intercept HTTP requests featuring legacy 24-character hexadecimal _id and map them to standard trackProjectId. Mount in app.js prior to Swagger router setup.

* Path: eagle-api/api/middleware/projectRedirect.js
* Code:
```javascript
const mongoose = require('mongoose');

module.exports = function projectRedirectMiddleware() {
  const OBJECTID_REGEX = /^[0-9a-fA-F]{24}$/;

  return async function (req, res, next) {
    const segments = req.path.split('/');
    const legacyIdIndex = segments.findIndex(seg => OBJECTID_REGEX.test(seg));

    if (legacyIdIndex !== -1) {
      const legacyId = segments[legacyIdIndex];
      try {
        const Project = mongoose.model('Project');
        const project = await Project.findById(legacyId).select('trackProjectId').lean();
        if (project && project.trackProjectId) {
          segments[legacyIdIndex] = project.trackProjectId.toString();
          const newPath = segments.join('/');
          const queryStr = req.url.includes('?') ? req.url.substring(req.url.indexOf('?')) : '';

          if (req.method === 'GET') {
            return res.redirect(301, newPath + queryStr);
          } else {
            req.url = newPath + queryStr; // Transparent rewrite for POST/PUT/DELETE
          }
        }
      } catch (err) {
        // Fail silent, proceed to default handler
      }
    }
    next();
  };
};
```

---

## 5. Geospatial Search & Alignment (eagle-typesense)

Align coordinate storage between MongoDB (GeoJSON order) and Typesense requirements.

### A. Coordinate Translation Rule
MongoDB standard is [longitude, latitude]. Typesense geopoint strictly requires [latitude, longitude]. Swap array order during Typesense document sync:
```javascript
// file: eagle-typesense/transform.js
centroid: doc.centroid && doc.centroid.length === 2 
  ? [doc.centroid[1], doc.centroid[0]] // [lat, lng]
  : undefined
```

### B. Map Bounding-Box Query Syntax
Execute spatial viewport queries using geographic bounding-box parameters:
```javascript
// Query syntax for map view bounds (South, West, North, East)
const queryParams = {
  q: '*',
  query_by: 'name,description',
  filter_by: 'centroid:(48.30, -124.01, 50.55, -120.45)'
};
```

---

## 6. Infrastructure Deployment (OpenShift Silver)

No code modifications required to use MinIO. Support is built-in. Populate environment variables inside Deployment configs using OpenShift Secrets.

| Environment Variable | Description | Value Example |
|---|---|---|
| MINIO_HOST | MinIO internal endpoint / S3 Service | minio.6cdc9e-dev.svc.cluster.local |
| MINIO_PORT | Communications port | 9000 (or 443 for TLS Object Storage) |
| MINIO_BUCKET_NAME | S3 Target Document Bucket | dfl-documents |
| MINIO_ACCESS_KEY | Authentication Username | Set from secret |
| MINIO_SECRET_KEY | Authentication Password | Set from secret |
| MINIO_USE_SSL | Enable secure transfer | true |

---

## 7. System Boundaries & Domain Separation

To prevent domain pollution and maintain microservice isolation, clear data boundaries are enforced between DEMI and Eagle.

### A. Migrated to DEMI (Core Master Registry)
DEMI acts as the single source of truth for the following datasets:
* **Projects**: Central registry managed by Track IDs (`trackProjectId`).
* **Documents**: PDF, DOCX, and raw binaries stored securely in S3/MinIO.
* **Document Metadata**: Extract structures, file sizes, mime-types, and indexing classifications.

### B. Retained in Eagle (Application & Engagement Engine)
To prevent turning DEMI into a heavy application monolith, these schemas and workflows stay inside Eagle. 

* **Read-Only Local Cache**: Local project and document directories in Eagle are strictly read-only local caches synced from Track and DEMI. All project creations/edits are decommissioned inside Eagle Admin.
* **Eagle Admin Active Write Access**: The only active write operations (Create, Update, and Delete) permitted inside the Eagle Admin portal are restricted to:
  * **Updates** (`RecentActivity` schema): Public announcements, dashboard updates, and news feeds.
  * **Contacts** (`Organization` schema): Proponent organizations, contractors, and contact directories.
* **Other Core Schemas (Stay in Eagle)**:
  * **Public Engagement**: Comments, comment periods, public submissions, and moderation lists.
  * **Compliance & Enforcement**: Site inspections, inspection elements, checklists, and violation records.
  * **Environmental Metrics**: Valued Components (VCs) and geographic topics.
  * **Access Control**: Administrative user accounts, user groups, and local Keycloak client roles.

---

## 8. Project Visibility & Permission Gating (Track Integration)

Since Track is the sole creator of projects, it controls project lifecycles and publication phases. Certain phases are pre-public (draft, in-progress, confidential) and must not be exposed to the public.

### A. Database Schema Field
We add a visibility flag to the `Project` model in MongoDB:
```javascript
// file: eagle-api/api/helpers/models/project.js
isPublished: { 
  type: Boolean, 
  default: false, 
  index: true 
}
```

### B. Ingestion Synchronization (Track to DEMI)
1. **Creation**: When Track creates a project, it triggers a `POST /api/projects` call to DEMI with `isPublished` set based on its active phase.
2. **Phase Transition**: When a project transitions to a public phase inside Track, Track triggers `PUT /api/projects/:trackProjectId` on DEMI, updating `isPublished: true`.
3. **Cascading Updates**: Updating the project's `isPublished` status in MongoDB automatically fires a database Change Stream, updating the corresponding `projectIsPublished` flag on all related documents inside the Typesense index.

### C. Search Endpoint Gating (DEMI API Middleware)
The search router (`GET /api/search`) enforces strict gating based on user Keycloak authorization scopes:

```javascript
// Example validation inside DEMI search controller
const searchFilters = [];

if (!userHasAdminScope(req)) {
  // Public users: Can only view documents that are published AND belong to published projects
  searchFilters.push('isPublished:true');
  searchFilters.push('projectIsPublished:true');
} else {
  // Admin users: Can view all documents, including pre-public drafts
  // No restrictive publication filters added
}

const typesenseQueryParams = {
  q: req.query.q,
  filter_by: searchFilters.join(' && ')
};
```

---

## 9. Scalability of Full Document Content Indexing

The platform is architected to scale to full document body text search (hundreds of thousands of pages) without degrading API response times or search performance.

### A. Asynchronous Extraction Isolation
* **Separation of Concerns**: Heavy PDF text extraction (docling-serve CPU, EasyOCR) and chunking do not block online API processes. 
* **Worker Execution**: The `eagle-demi-worker` runs as a nightly CronJob (2:00 AM) inside an isolated container with strict CPU/RAM limits (Request: 250m CPU / 2Gi RAM, Limit: 500m CPU / 3Gi RAM). 
* **MongoDB Storage**: Extracted pages are split into standard `DocumentChunk` records (max 4,000 characters with 200 character overlap to avoid sentence truncation) and saved in the MongoDB `epic` collection with a unique sparse compound index:
  ```javascript
  { _schemaName: 1, documentId: 1, pageNumber: 1, chunkIndex: 1 }
  ```

### B. Index Synchronization Pipeline
* **Real-time Streaming**: Rather than running massive batch sync loops, the `eagle-typesense` container monitors the MongoDB `epic` collection via real-time Change Streams. 
* **Incremental Updates**: Any new `DocumentChunk` records inserted by the nightly extraction job are automatically picked up by the Change Stream listener and pushed to the `document_chunks` Typesense collection incrementally.

### C. Typesense Sizing & Query Performance
* **Memory Optimization**: Large-text search indices are loaded fully in RAM by the Typesense engine. To prevent Out-Of-Memory (OOM) failures under heavy loads, the container limits are configured to 4 Gi RAM.
* **Result Collapsing**: Search queries against document content leverage Typesense native `group_by: 'documentId'` and `group_limit: 3` parameters. This collapses raw page-level hits (from a single document) into a single search result card, enabling instant deep-linking to the exact page offset (`#page=N`).
* **Resource Allocation**:
  * MongoDB Persistent Volume (PVC): 10 Gi (accommodates up to 3 GB of raw text chunks).
  * Typesense Persistent Volume (PVC): 5 Gi (stores schema indices).

---

## 10. Official References & Documentation

For further technical context on libraries, configurations, and core components utilized in this architecture, refer to the following official resources:

- **Typesense Vector & Semantic Search**: [Official Typesense Vector Search Guide](https://typesense.org/docs/30.2/api/vector-search.html)
- **MinIO Javascript Client API**: [Official MinIO JS SDK API Reference](https://min.io/docs/minio/linux/developers/javascript/API.html)
- **KEDA Autoscaling**: [Official KEDA ScaledObject Guide](https://keda.sh/docs/latest/concepts/scaling-deployments/)
- **Docling Serve**: [Official Docling Serve GitHub Repository](https://github.com/docling-project/docling-serve)
