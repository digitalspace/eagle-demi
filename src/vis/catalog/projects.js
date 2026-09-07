'use strict';

/**
 * Field visibility policy for a stored project. Security policy as data: reviewed in diffs, tested
 * by test/vis/catalog-completeness.test.js, never read from Cosmos.
 *
 * `defaultVis` is the baseline level a field is visible at; `maxVis` is the ceiling a per-record
 * dial may ever raise it to. A field absent from this table is removed from every response.
 *
 * Day-one defaults reproduce today's anonymous output (docs/rbac-architecture.md §2 item 3), so
 * almost everything is 4/4. Keys may be dotted one level; the redactor descends only for those.
 * A `when` names a predicate in src/vis/predicates.js: true widens the field to `maxVis`, and a
 * dial beats it (§2 item 7). redact.js throws at load on a name predicates.js does not export.
 */
module.exports = {
  // Structural / identity.
  id: { defaultVis: 4, maxVis: 4 },
  trackProjectId: { defaultVis: 4, maxVis: 4 },
  eagleId: { defaultVis: 4, maxVis: 4 },
  sourceSystem: { defaultVis: 4, maxVis: 4 },
  isPublished: { defaultVis: 4, maxVis: 4 },
  createdAt: { defaultVis: 4, maxVis: 4 },
  updatedAt: { defaultVis: 4, maxVis: 4 },
  centroid: { defaultVis: 4, maxVis: 4 },

  // Track-precedence targets.
  name: { defaultVis: 4, maxVis: 4 },
  description: { defaultVis: 4, maxVis: 4 },
  projectType: { defaultVis: 4, maxVis: 4 },
  projectSubType: { defaultVis: 4, maxVis: 4 },
  proponentName: { defaultVis: 4, maxVis: 4 },
  // The Organization ObjectId behind the name. Public because it is only useful as a filter value,
  // and eagle-public's own project-list URLs already carry it.
  proponentId: { defaultVis: 4, maxVis: 4 },
  projectState: { defaultVis: 4, maxVis: 4 },
  abbreviation: { defaultVis: 4, maxVis: 4 },
  address: { defaultVis: 4, maxVis: 4 },
  isActive: { defaultVis: 4, maxVis: 4 },
  // Certificate number or state — both are published on the EAO's own certificate pages.
  eaCertificate: { defaultVis: 4, maxVis: 4 },
  // Track's assessment phases, dates only — the progress rail eagle-public draws. No staff, no
  // notes: seed/sources.js maps the fields listed here and drops the rest of the Track row.
  phases: { defaultVis: 4, maxVis: 4 },
  // The project's own short link code. The public page it points at is public, so the code is.
  shortCode: { defaultVis: 4, maxVis: 4 },

  // Eagle-only EA process record.
  eaStatus: { defaultVis: 4, maxVis: 4 },
  eacDecision: { defaultVis: 4, maxVis: 4 },
  decisionDate: { defaultVis: 4, maxVis: 4 },
  currentPhaseName: { defaultVis: 4, maxVis: 4 },
  phaseHistory: { defaultVis: 4, maxVis: 4 },
  legislation: { defaultVis: 4, maxVis: 4 },
  legislationYear: { defaultVis: 4, maxVis: 4 },
  review180Start: { defaultVis: 4, maxVis: 4 },
  review45Start: { defaultVis: 4, maxVis: 4 },
  reviewExtensions: { defaultVis: 4, maxVis: 4 },
  reviewSuspensions: { defaultVis: 4, maxVis: 4 },
  substitution: { defaultVis: 4, maxVis: 4 },
  CEAAInvolvement: { defaultVis: 4, maxVis: 4 },
  // The federal registry link that goes with CEAAInvolvement, and the regulation the project is
  // assessed under as `{_id, name, item}` — `item` is the public BC Laws URL the label links to.
  CEAALink: { defaultVis: 4, maxVis: 4 },
  applicableRegulation: { defaultVis: 4, maxVis: 4 },
  // Eagle's own record dates and build tag. Already on the public project page.
  dateAdded: { defaultVis: 4, maxVis: 4 },
  build: { defaultVis: 4, maxVis: 4 },
  sector: { defaultVis: 4, maxVis: 4 },
  commodity: { defaultVis: 4, maxVis: 4 },
  region: { defaultVis: 4, maxVis: 4 },
  fedElecDist: { defaultVis: 4, maxVis: 4 },
  provElecDist: { defaultVis: 4, maxVis: 4 },
  projectCAC: { defaultVis: 4, maxVis: 4 },
  projectCACPublished: { defaultVis: 4, maxVis: 4 },
  overallProgress: { defaultVis: 4, maxVis: 4 },
  code: { defaultVis: 4, maxVis: 4 },
  nameSearchTerms: { defaultVis: 4, maxVis: 4 },

  // Contacts. eagle-public shows these to anonymous visitors today, so they stay at 4.
  projectLead: { defaultVis: 4, maxVis: 4 },
  responsibleEPD: { defaultVis: 4, maxVis: 4 },
  eaoMember: { defaultVis: 4, maxVis: 4 },

  // Public by policy (answered by Daniel for the EAO, 2026-08-28; docs/rbac-architecture.md §3 question 2).
  // The phones are office lines on the same contact card as the emails, and carry the same policy.
  projectLeadEmail: { defaultVis: 4, maxVis: 4 },
  responsibleEPDEmail: { defaultVis: 4, maxVis: 4 },
  projectLeadPhone: { defaultVis: 4, maxVis: 4 },
  responsibleEPDPhone: { defaultVis: 4, maxVis: 4 },

  // Public only while the CAC is, which is what the predicate reads.
  cacEmail: { defaultVis: 2, maxVis: 4, when: 'cacPublished' },

  // Not in eagle-public's request list, so restricting them costs nothing public (§2 item 3).
  complianceLead: { defaultVis: 2, maxVis: 4 },
  execProjectDirector: { defaultVis: 2, maxVis: 4 },

  // Pinned documents and the pinned-proponent list, both stored top level in Mongo. They were only
  // ever reachable under `sources.eagle`, which is maxVis 0 — these entries are what publishes them.
  // `pins` rows are `{_id, name, province}`; `featuredDocuments` are Eagle document ids.
  //
  // `pins` is public only through its predicate: eagle-api publishes the pinned-proponent list per
  // project with `pinsRead[]` and ignores the organization's own `read` (controllers/pins.js), so
  // the project ACL that gates every other field here says nothing about this one.
  pins: { defaultVis: 2, maxVis: 4, when: 'pinsPublished' },
  featuredDocuments: { defaultVis: 4, maxVis: 4 },

  // Written by the boundary and wildfire jobs, not by the merge.
  regionalDistrict: { defaultVis: 4, maxVis: 4 },
  municipality: { defaultVis: 4, maxVis: 4 },
  electoralDistrict: { defaultVis: 4, maxVis: 4 },
  'sources.wildfire': { defaultVis: 4, maxVis: 4 },

  // Never public. `sources` is the raw upstream payload; only the dotted child above publishes.
  // `vis` does not exist yet — catalogued so a dial map can never leak which fields are restricted.
  read: { defaultVis: 0, maxVis: 0 },
  // The pins ACL. Stored because `pinsPublished` reads it, and withheld like every other ACL.
  pinsRead: { defaultVis: 0, maxVis: 0 },
  sources: { defaultVis: 0, maxVis: 0 },
  vis: { defaultVis: 0, maxVis: 0 },

  // Cosmos system fields.
  _rid: { defaultVis: 0, maxVis: 0 },
  _self: { defaultVis: 0, maxVis: 0 },
  _attachments: { defaultVis: 0, maxVis: 0 },
  _ts: { defaultVis: 0, maxVis: 0 },

  // Writers need it back for optimistic concurrency; every WRITE_ROLES holder is level 2 or lower.
  _etag: { defaultVis: 2, maxVis: 2 }
};
