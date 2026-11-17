'use strict';

// Staff reads of a project's works: the staff entries in effect for each, and the sheet works.
// Level 2 and narrower only: the staff lists sit at level 2 or 3 and these routes return nothing else.

const projects = require('../../repositories/projects');
const works = require('../../repositories/works');
const { resolveAccess } = require('../../helpers/access-sql');
const { levelOf } = require('../../vis/level');
const { redactForAccess } = require('../../vis/redact');
const { inEffect, workRangeOf } = require('../../domain/work-model');
const { given, listOf } = require('../../domain/work-override');
const { sheetWorksOf } = require('../../domain/works-derive');
const { ENTRY_SCHEMAS, SERVER_KEYS, currentInvestment } = require('../../domain/project-staff-fields');
const { serverError } = require('../../helpers/response');

const STAFF_LEVEL = 2;
// DEMI project ids: a Track integer, `eagle-<ObjectId>` or a UUID.
const PROJECT_ID = /^(?:0|[1-9]\d{0,15}|eagle-[0-9a-f]{24}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

/** The keys a `field` entry returns; never `sheetKey`, which encodes the sheet's project number. */
const keysOf = (field, ...extra) => [...SERVER_KEYS, ...Object.keys(ENTRY_SCHEMAS[field]), ...extra, 'currentAsOf']
  .filter(key => key !== 'sheetKey');
const CONTACT_KEYS = keysOf('staffAssignments');
const INVESTMENT_KEYS = keysOf('capitalInvestments', 'amountCad');
const NOTE_KEYS = keysOf('staffNotes');

const pick = (entry, keys) => Object.fromEntries(keys.filter(key => Object.hasOwn(entry, key)).map(key => [key, entry[key]]));

/**
 * The entries of `list` for `work`: one tied to it by `workId` whatever its dates, marked as `inEffect`
 * marks an undated entry; else those `inEffect` gives.
 */
const entriesFor = (list, keys, work) => listOf(list).flatMap((entry) => {
  if (!given(entry?.workId)) return inEffect([entry], work);
  if (entry.workId !== work.id) return [];
  return [given(entry.effectiveFrom) ? entry : { ...entry, currentAsOf: entry.observedAt }];
}).map(entry => pick(entry, keys));

/** `{ access, project }` for a staff-level caller and a readable project; else sends 403, 400 or 404 and gives null. */
async function staffProjectOf(req, res) {
  const refuse = (status, error) => { res.status(status).json({ error }); return null; };
  const access = resolveAccess(req);
  if (levelOf(access) > STAFF_LEVEL) return refuse(403, 'Forbidden');
  const id = req.params && req.params.id;
  if (typeof id !== 'string' || !PROJECT_ID.test(id)) return refuse(400, 'Invalid project id');
  const project = await projects.getById(access, id);
  if (!project) return refuse(404, 'Project not found');
  return { access, project };
}

/** `GET /projects/:id/works-staff` */
exports.getWorksStaff = async (req, res) => {
  try {
    const found = await staffProjectOf(req, res);
    if (!found) return undefined;
    const { access, project } = found;
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

/** `GET /projects/:id/sheet-works` */
exports.getSheetWorks = async (req, res) => {
  try {
    const found = await staffProjectOf(req, res);
    if (!found) return undefined;
    const { project } = found;
    return res.json({ projectId: project.id, ...(await sheetWorksOf(project)) });
  } catch (err) {
    return serverError(res, err, 'sheet-works read failed');
  }
};
