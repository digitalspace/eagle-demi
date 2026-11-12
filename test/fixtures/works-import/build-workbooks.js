'use strict';

// Synthetic business workbooks: made-up projects, numbers and staff values only.
const path = require('path');
const ExcelJS = require('exceljs');

const day = iso => new Date(`${iso}T00:00:00Z`);

const STAFF_VALUES = ['Test Officer One', 'Test Lead One', 'fixture note one', '$12,000,000'];
const BI_SECRET_VALUES = ['BI-NOTE-NEVER-READ', 'BI-EPD-NEVER-READ'];
const PROJECT_NAMES = ['Alder Creek Mine', 'Birch Point Terminal', 'Cedar Ridge Wind'];
const REAL_IDS = [45, 7, 120];

const PROJECT_HEADER = [
  'ID', 'Project Name', 'Status', 'Region', 'Sub-Sector', 'CEAA', 'Intake Type', 'Intake Date',
  'Determination Type', 'Determination Date', 's.11/14 Order', 'Draft AIR', 'AIR Accepted', 'Start (30)',
  'Start (180)', 'Start (45)', 'Decision', 'Decision Date', 'F.A.R.', 'EPD', 'Lead', 'Investment', 'Notes',
  ...Array(7).fill(null), 'Substantially Started', 'Date', 'Expiry', null, 'Extension Date', 'Extension Expiry'
];

function projectRow(values) {
  const row = Array(PROJECT_HEADER.length).fill(null);
  for (const [index, value] of Object.entries(values)) row[Number(index)] = value;
  return row;
}

function addSheet(workbook, name, rows) {
  const ws = workbook.addWorksheet(name);
  rows.forEach(row => ws.addRow(row));
  return ws;
}

async function save(dir, file, sheets) {
  const workbook = new ExcelJS.Workbook();
  for (const [name, rows] of sheets) addSheet(workbook, name, rows);
  await workbook.xlsx.writeFile(path.join(dir, file));
}

/** Writes one workbook per source into `dir`. */
async function buildWorkbooks(dir) {
  const [epd, lead, notes, investment] = STAFF_VALUES;
  await save(dir, '01 Projects.xlsx', [
    ['1996', [
      PROJECT_HEADER,
      // The formula's own text differs from its cached result, so evaluating it would show.
      projectRow({ 0: '045', 1: { formula: '"evaluated"', result: PROJECT_NAMES[0] }, 3: '---', 5: 'n/a',
        6: 'Pre-EAO', 7: day('1995-06-30'), 16: 'EA Certificate Granted', 17: day('1999-03-01'),
        19: epd, 20: lead, 21: investment, 22: notes }),
      [],
      projectRow({ 0: 7, 1: PROJECT_NAMES[1], 7: day('2001-01-10'), 17: day('2000-05-05'),
        30: 'Yes', 31: day('2004-02-02'), 34: day('2009-01-01') })
    ]],
    ['2002', [PROJECT_HEADER, projectRow({ 0: 120, 1: PROJECT_NAMES[2], 7: day('2003-04-04') })]],
    ['2018', [['not', 'the', 'register'], [999, 'skipped']]],
    ['Assessment BI', [['not', 'read'], [998, 'skipped']]]
  ]);
  const band = ['Amendment', 'Complexity', 'Status', 'Start Date', 'End Date'];
  await save(dir, '02 Amendments.xlsx', [['Amendments', [
    ['ID', 'Project Name', 'Notes', ...band, ...band],
    [45, PROJECT_NAMES[0], null, 'Amend A', 'Moderate', 'Complete', day('2003-01-01'), day('2002-06-01'),
      'Amend B', 'Low', 'Open', day('2010-05-05'), '---'],
    [7, PROJECT_NAMES[1], null, 'Amend C', 'Low', 'Complete', day('2005-01-01'), day('2005-03-01')]
  ]]]);
  const dated = ['ID', 'Project Name', 'Applied To', 'Start Date', 'End Date'];
  await save(dir, '03 Suspensions.xlsx', [['Suspensions', [dated, [45, PROJECT_NAMES[0], 'Application Review', day('1998-01-01'), day('1998-02-01')]]]]);
  await save(dir, '04 Extensions.xlsx', [['Extensions', [dated, [7, PROJECT_NAMES[1], 'Pre-Application', day('2001-02-01'), day('2001-03-01')]]]]);
  await save(dir, '05 Section 13-15.xlsx', [['Orders', [
    ['ID', 'Project Name', 'Section', 'Date', 'Section', 'Date'],
    [45, PROJECT_NAMES[0], 's.13', day('1997-01-01'), 's.15', day('1997-06-01')]
  ]]]);
  await save(dir, '06 PCPs.xlsx', [['PCPs', [
    ['ID', 'Project Name', 'Type', 'Start Date', 'End Date'],
    [45, PROJECT_NAMES[0], 'Application', day('1998-03-01'), day('1998-04-01')],
    [120, PROJECT_NAMES[2], 'Draft AIR', day('2004-01-01'), day('2004-02-01')]
  ]]]);
  await save(dir, 'Timelines 2002.xlsx', [['Timelines', [
    ['ID', 'Project Name', 'Determination Date', 's.11/14 Order', 'Draft AIR', 'AIR Accepted', 'Start (30)',
      'Start (180)', 'Start (45)', 'Decision', 'Decision Date'],
    [120, PROJECT_NAMES[2], day('2003-05-05'), day('2003-06-06')]
  ]]]);
  const [biNote, biEpd] = BI_SECRET_VALUES;
  await save(dir, '01 Assess BI.xlsx', [
    ['EA Process Data', [
      ['ID', 'Project Name', 'Stage', 'Phase', 'Notes', 'EPD', 'Process', 'Date'],
      [120, PROJECT_NAMES[2], 'x', 'y', biNote, biEpd, 'Transition Order (2018)', day('2021-04-01')],
      [45, PROJECT_NAMES[0], 'x', 'y', biNote, biEpd, 'Transition Order (2018)', null],
      [7, PROJECT_NAMES[1], 'x', 'y', biNote, biEpd, 'IPD Accepted', day('2020-01-01')]
    ]],
    ['For BI', [['not', 'read']]]
  ]);
}

module.exports = { buildWorkbooks, STAFF_VALUES, BI_SECRET_VALUES, PROJECT_NAMES, REAL_IDS };
