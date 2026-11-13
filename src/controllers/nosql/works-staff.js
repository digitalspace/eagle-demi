'use strict';

// Staff read of a project's works with the contacts, investment and notes in effect for each.
// Level 2 and narrower only: the staff lists sit at level 2 or 3 and this route returns nothing else.

const projects = require('../../repositories/projects');
const works = require('../../repositories/works');
const { resolveAccess } = require('../../helpers/access-sql');
const { levelOf } = require('../../vis/level');
const { redactForAccess } = require('../../vis/redact');
const { dayOf, inEffect } = require('../../domain/work-model');
const { currentInvestment } = require('../../domain/project-staff-fields');
const { serverError } = require('../../helpers/response');

const STAFF_LEVEL = 2;
// DEMI project ids: a Track integer, `eagle-<ObjectId>` or a UUID.
const PROJECT_ID = /^(?:0|[1-9]\d{0,15}|eagle-[0-9a-f]{24}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

/** `entry` without `sheetKey`, which encodes the sheet's project number. */
function shown(entry) {
  const { sheetKey, ...rest } = entry;
  return rest;
}

/** The entries of `list` in effect for `work`; one tied to another work is left out. */
const entriesFor = (list, work) => inEffect(list, work)
  .filter(entry => entry.workId === null || entry.workId === undefined || entry.workId === work.id)
  .map(shown);

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

    const body = (await works.listForRead(project.id)).map(work => ({
      workId: work.id,
      title: work.title ?? null,
      startDate: dayOf(work.startDate),
      endDate: dayOf(work.decisionDate),
      contacts: entriesFor(row.staffAssignments, work),
      investments: entriesFor(row.capitalInvestments, work),
      notes: entriesFor(row.staffNotes, work)
    }));
    const current = currentInvestment(row.capitalInvestments);
    return res.json({ projectId: project.id, currentInvestment: current && shown(current), works: body });
  } catch (err) {
    return serverError(res, err, 'works-staff read failed');
  }
};
