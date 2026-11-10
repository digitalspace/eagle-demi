'use strict';

const authMiddleware = require('../middleware/auth');
const { requireWrite, requireTrackWriter } = require('../middleware/require-roles');

const trackPushController = () => require('../controllers/nosql/track-push');

// Track push: one record per Track write. Pinned to DEMI_TRACK_PRINCIPALS, on the Eagle mirror's terms.
module.exports = [
  { method: 'post', path: '/track/projects', guards: [authMiddleware, requireWrite, requireTrackWriter], load: () => trackPushController().postTrackProject },
  { method: 'put', path: '/track/projects/:id', guards: [authMiddleware, requireWrite, requireTrackWriter], load: () => trackPushController().putTrackProject },
  { method: 'delete', path: '/track/projects/:id', guards: [authMiddleware, requireWrite, requireTrackWriter], load: () => trackPushController().deleteTrackProject },
  { method: 'post', path: '/track/projects/:pid/works', guards: [authMiddleware, requireWrite, requireTrackWriter], load: () => trackPushController().postTrackWork },
  { method: 'put', path: '/track/projects/:pid/works/:id', guards: [authMiddleware, requireWrite, requireTrackWriter], load: () => trackPushController().putTrackWork },
  { method: 'delete', path: '/track/projects/:pid/works/:id', guards: [authMiddleware, requireWrite, requireTrackWriter], load: () => trackPushController().deleteTrackWork },
  { method: 'post', path: '/track/projects/:pid/phases', guards: [authMiddleware, requireWrite, requireTrackWriter], load: () => trackPushController().postTrackPhase },
  { method: 'put', path: '/track/projects/:pid/phases/:id', guards: [authMiddleware, requireWrite, requireTrackWriter], load: () => trackPushController().putTrackPhase },
  { method: 'delete', path: '/track/projects/:pid/phases/:id', guards: [authMiddleware, requireWrite, requireTrackWriter], load: () => trackPushController().deleteTrackPhase },
  { method: 'post', path: '/track/projects/:pid/events', guards: [authMiddleware, requireWrite, requireTrackWriter], load: () => trackPushController().postTrackEvent },
  { method: 'put', path: '/track/projects/:pid/events/:id', guards: [authMiddleware, requireWrite, requireTrackWriter], load: () => trackPushController().putTrackEvent },
  { method: 'delete', path: '/track/projects/:pid/events/:id', guards: [authMiddleware, requireWrite, requireTrackWriter], load: () => trackPushController().deleteTrackEvent }
];
