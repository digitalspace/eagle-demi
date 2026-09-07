'use strict';

/**
 * Field visibility policy for a mirrored Update (Eagle `RecentActivity`). See catalog/projects.js
 * for the rules.
 *
 * Everything eagle-public renders on the home strip and the news page is 4/4 — an update is a
 * published announcement. The container has existed since the Eagle mirror shipped; it had no
 * catalog because it had no read route, and `catalogFor` throws rather than defaulting, so the
 * `/search?dataset=RecentActivity` branch could not redact a row without this file.
 */
module.exports = {
  // Structural / identity.
  id: { defaultVis: 4, maxVis: 4 },
  eagleId: { defaultVis: 4, maxVis: 4 },
  // The EAGLE project id, not the DEMI one — see repositories/updates.js SCOPE_FIELD.
  projectId: { defaultVis: 4, maxVis: 4 },
  isPublished: { defaultVis: 4, maxVis: 4 },

  // The update itself.
  headline: { defaultVis: 4, maxVis: 4 },
  content: { defaultVis: 4, maxVis: 4 },
  type: { defaultVis: 4, maxVis: 4 },
  pinned: { defaultVis: 4, maxVis: 4 },
  dateAdded: { defaultVis: 4, maxVis: 4 },
  dateUpdated: { defaultVis: 4, maxVis: 4 },
  // Eagle's own active flag, and the four references the news card renders. All public in
  // eagle-api's `/api/public/recentActivity` projection.
  active: { defaultVis: 4, maxVis: 4 },
  notificationName: { defaultVis: 4, maxVis: 4 },
  contentUrl: { defaultVis: 4, maxVis: 4 },
  documentUrl: { defaultVis: 4, maxVis: 4 },
  pcp: { defaultVis: 4, maxVis: 4 },
  projectNotification: { defaultVis: 4, maxVis: 4 },

  // Never public. Same entries, same reasons, as catalog/projects.js.
  read: { defaultVis: 0, maxVis: 0 },
  sources: { defaultVis: 0, maxVis: 0 },
  vis: { defaultVis: 0, maxVis: 0 },

  _rid: { defaultVis: 0, maxVis: 0 },
  _self: { defaultVis: 0, maxVis: 0 },
  _attachments: { defaultVis: 0, maxVis: 0 },
  _ts: { defaultVis: 0, maxVis: 0 },

  // Writer-visible only, same as `_etag`: `notifiedAt` is the eagle-notify claim this service
  // takes, not a property of the announcement.
  notifiedAt: { defaultVis: 2, maxVis: 2 },
  _etag: { defaultVis: 2, maxVis: 2 }
};
