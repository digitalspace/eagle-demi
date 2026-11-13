'use strict';

// Staff read of a project's works with the contacts, investment and notes in effect for each.
// Level 2 and narrower only: the staff lists sit at level 2 or 3 and this route returns nothing else.

const projects = require('../../repositories/projects');
const works = require('../../repositories/works');
const { resolveAccess } = require('../../helpers/access-sql');
const { levelOf } = require('../../vis/level');
const { redactForAccess } = require('../../vis/redact');
const { inEffect, workRangeOf } = require('../../domain/work-model');
const { currentInvestment } = require('../../domain/project-staff-fields');
const { serverError } = require('../../helpers/response');

const STAFF_LEVEL = 2;
// DEMI project ids: a Track integer, `eagle-<ObjectId>` or a UUID.
const PROJECT_ID = /^(?:0|[1-9]\d{0,15}|eagle-[0-9a-f]{24}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

// The keys each list returns; `sheetKey` is never one, as it encodes the sheet's project number.
const COMMON_KEYS = ['id', 'observedAt', 'source', 'recordedAt', 'currentAsOf'];
const CONTACT_KEYS = [...COMMON_KEYS, 'role', 'name', 'effectiveFrom', 'effectiveTo'];
const INVESTMENT_KEYS = [...COMMON_KEYS, 'amountCad', 'effectiveFrom', 'effectiveTo', 'workId'];
const NOTE_KEYS = [...COMMON_KEYS, 'text', 'workId'];

const pick = (entry, keys) => Object.fromEntries(keys.filter(key => Object.hasOwn(entry, key)).map(key => [key, entry[key]]));

/** The entries of `list` for `work`: one tied to it by `workId` whatever its dates, else those `inEffect` gives. */
const entriesFor = (list, keys, work) => (Array.isArray(list) ? list : []).flatMap((entry) => {
  const tiedTo = entry?.workId;
  if (tiedTo === null || tiedTo === undefined) return inEffect([entry], work);
  return tiedTo === work.id ? [entry] : [];
}).map(entry => pick(entry, keys));

/** `GET /projects/:id/works-staff` */
exports.getWorksStaff = async (req, res) => {
  try {
    const access = resolveAccess(req);
    if (levelOf(access) > STAFF_LEVEL) return res.status(403).json({ error: 'Forbidden' });
    const id = req.params && req.params.id;
    if (typeof id !== 'string' || !PROJECT_ID.test(id)) return res.status(400).json({ error: 'Invalid project id' });

    const project = await projects.getById(access, id);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    // The row's own dials can hold a staff list narrower than the caller's level.
    const row = redactForAccess('projects', project, access);

    const body = (await works.listForRead(project.id)).map(work => {
      const range = workRangeOf(work);
      return {
        workId: work.id,
        title: work.title ?? null,
        startDate: range.start,
        endDate: range.end,
        contacts: entriesFor(row.staffAssignments, CONTACT_KEYS, work),
        investments: entriesFor(row.capitalInvestments, INVESTMENT_KEYS, work),
        notes: entriesFor(row.staffNotes, NOTE_KEYS, work)
      };
    });
    const current = currentInvestment(row.capitalInvestments);
    return res.json({ projectId: project.id, currentInvestment: current && pick(current, INVESTMENT_KEYS), works: body });
  } catch (err) {
    return serverError(res, err, 'works-staff read failed');
  }
};
