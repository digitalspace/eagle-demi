'use strict';

// Synthetic business workbooks in the real layout: title rows, merged band row over the header row,
// ids and slot numbers pre-filled below the data, '---' filler. Made-up projects and people only.
const path = require('path');
const ExcelJS = require('exceljs');

const day = iso => new Date(`${iso}T00:00:00Z`);
const pad = n => String(n).padStart(2, '0');
const FILL = '---';
const PREFILLED_TO = 30;

const STAFF_VALUES = ['Test Officer One', 'Test Lead One', 'fixture note one', 12000000];
const NEVER_READ_VALUES = ['BI-NOTE-NEVER-READ', 'BI-EPD-NEVER-READ', 'TEAM-NEVER-READ'];
const PROJECT_NAMES = ['Alder Creek Mine', 'Birch Point Terminal', 'Cedar Ridge Wind'];
const REAL_IDS = [45, 7, 120];

/** Writes [band, headers[]] groups left to right from column A; a band over several columns is merged. */
function layout(ws, bandRow, groups) {
  let col = 1;
  for (const [band, headers] of groups) {
    if (band) ws.getCell(bandRow, col).value = band;
    if (band && headers.length > 1) ws.mergeCells(bandRow, col, bandRow, col + headers.length - 1);
    headers.forEach((header, i) => { if (header) ws.getCell(bandRow + 1, col + i).value = header; });
    col += headers.length;
  }
}

function put(ws, rowNo, cells) {
  for (const [col, value] of Object.entries(cells)) ws.getCell(`${col}${rowNo}`).value = value;
}

/** `count` layout groups named "<band> 01", "<band> 02", ..., each over the same headers. */
const slots = (count, band, headers) => Array.from({ length: count }, (_, i) => [`${band} ${pad(i + 1)}`, headers]);

// Every block cell of every listed row gets its slot number or '---', as the real sheets do.
function fillBlocks(ws, firstCol, width, count, rows, numbered = true) {
  for (const rowNo of rows) {
    for (let s = 0; s < count; s += 1) {
      for (let i = 0; i < width; i += 1) {
        const cell = ws.getCell(rowNo, firstCol + s * width + i);
        if (cell.value == null) cell.value = numbered && i === 0 ? s + 1 : FILL;
      }
    }
  }
}

function prefill(ws, fromRow, idCol = 'A') {
  for (let r = fromRow; r <= PREFILLED_TO; r += 1) {
    if (ws.getCell(`${idCol}${r}`).value == null) ws.getCell(`${idCol}${r}`).value = r - 4;
  }
}

function mainSheet(workbook, tab, title, groups) {
  const ws = workbook.addWorksheet(tab);
  ws.getCell('A1').value = title;
  layout(ws, 3, groups);
  return ws;
}

async function save(dir, file, build) {
  const workbook = new ExcelJS.Workbook();
  build(workbook);
  await workbook.xlsx.writeFile(path.join(dir, file));
}

const junk = (workbook, ...tabs) => tabs.forEach(tab => workbook.addWorksheet(tab).addRow(['not', 'read']));

function projects(workbook) {
  const [epd, lead, notes, investment] = STAFF_VALUES;
  const ws = mainSheet(workbook, 'Projects', 'EAO Project Information', [
    ['ID', ['ID']],
    ['Project Information', ['Name', 'Proponent/Certificate Holder', 'Status', 'Work', 'CEAA', 'Subsector',
      'Region (ENV)', 'Region (FLNRO)', 'Investment $', 'Notes']],
    ['Team Information', ['EPD', 'Lead', 'Team', 'Admin', 'FN CAART']],
    ['Intake (Start)', ['Type', 'Date']], ['Determination', ['Type', 'Date']],
    ['Scope', ['s.11/14 Order', 'Draft AIR', 'AIR']], ['Evaluation', ['Start (30)']], ['Review', ['Start (180)']],
    ['Decision', ['Start (45)', 'Decision', 'Date', 'F.A.R.']], ['Duration', ['In Days']],
    ['Substantially Started', ['Status', 'Date', 'SS?']],
    ['Certificate Information', ['Expiry Date', 'Extension Date', 'Extension Expiry']], [null, [null, 'Expirery']]
  ]);
  // The formula's own text differs from its cached result, so evaluating it would show.
  put(ws, 5, { A: '045', B: { formula: '"evaluated"', result: PROJECT_NAMES[0] }, D: 'Active', F: 'n/a', H: FILL,
    J: investment, K: notes, L: epd, M: lead, N: NEVER_READ_VALUES[2], Q: 'Pre-EAO', R: day('1995-06-30'),
    U: FILL, AA: 'EA Certificate Granted', AB: day('1999-03-01'), AC: 'No', AD: { formula: 'AB5-R5', result: 1340 } });
  put(ws, 6, { A: 7, B: { richText: [{ text: 'Birch Point ' }, { font: { bold: true }, text: 'Terminal' }] },
    R: day('2001-01-10'), AB: day('2000-05-05'), AE: 'Substantially Started', AF: day('2004-02-02'), AG: 'Yes',
    AH: { formula: 'TODAY()+30', result: day('2026-12-01') }, AI: day('2009-01-01'), AL: day('2030-01-01') });
  put(ws, 7, { A: 120, B: PROJECT_NAMES[2], C: { error: '#N/A' }, G: { formula: '1/0', result: { error: '#DIV/0!' } },
    R: day('2003-04-04'), U: FILL, V: '1850-01-01', W: '2001-02-30', AB: 1e10 });
  ws.getCell('AB7').numFmt = 'yyyy-mm-dd';
  put(ws, 8, { A: 'x12', B: 'Unnumbered Project' });
  put(ws, 9, { A: 46, D: 'Active' });
  put(ws, 10, { A: 7, B: 'Birch Point Terminal' });
  put(ws, 11, { A: 44000, B: 'Date Formatted Id Project' });
  ws.getCell('A11').numFmt = 'yyyy-mm-dd';
  prefill(ws, 12);
  junk(workbook, 'Lookups', 'For BI');
}

function amendments(workbook) {
  const band = ['No.', 'Complexity', 'Status', 'Start Date', 'End Date'];
  const ws = mainSheet(workbook, 'Amendments', 'EAO Project Amendment Information', [
    ['ID', ['ID']], ['Project Information', ['Name']], [null, ['Decision']], ...slots(15, 'Amendment', band),
    [null, [null]], ['Latest', ['Amenment Date']]
  ]);
  put(ws, 5, { A: 45, B: PROJECT_NAMES[0], E: 'Moderate', F: 'Complete', G: day('2003-01-01'), H: day('2002-06-01'),
    J: 'Low', K: 'Open', L: day('2010-05-05') });
  put(ws, 6, { A: 7, B: PROJECT_NAMES[1], E: 'Low', F: 'Complete', G: day('2005-01-01'), H: day('2005-03-01') });
  prefill(ws, 7);
  put(ws, 7, { A: null, E: 'Low' });
  fillBlocks(ws, 4, 5, 15, Array.from({ length: PREFILLED_TO - 4 }, (_, i) => i + 5));
  junk(workbook, 'Lookups', 'For BI');
}

function interruptions(workbook, tab, band, cells) {
  const ws = mainSheet(workbook, tab, `EAO Project ${band} Information`, [
    ['ID', ['ID']], ['Project Information', ['Name', 'Status']], ['Total Days', [null]],
    ...slots(10, band, ['No.', 'Type', 'Applied To', 'Start Date', 'End Date', 'Days'])
  ]);
  put(ws, 5, cells);
  prefill(ws, 6);
  fillBlocks(ws, 5, 6, 10, Array.from({ length: PREFILLED_TO - 4 }, (_, i) => i + 5));
  junk(workbook, 'Lookups', 'For BI');
}

function sectionThirteen(workbook) {
  const ws = mainSheet(workbook, 'Section 13', 'EAO Project Section 13/15 Information', [
    ['ID', ['ID']], ['Project Information', ['Name', 'Status']], ...slots(10, 'Variation', ['No.', 'Date'])
  ]);
  put(ws, 5, { A: 45, B: PROJECT_NAMES[0], E: day('1997-01-01'), G: day('1997-06-01') });
  prefill(ws, 6);
  fillBlocks(ws, 4, 2, 10, Array.from({ length: PREFILLED_TO - 4 }, (_, i) => i + 5));
}

function commentPeriods(workbook) {
  const ws = mainSheet(workbook, 'PCPs', 'EAO Project Public Comment Periods', [
    ['ID', ['ID']], ['Project Information', ['Name', 'Status']],
    ...slots(10, 'Public Comment Period', ['Type', 'Start Date', 'End Date'])
  ]);
  put(ws, 5, { A: 45, B: PROJECT_NAMES[0], D: 'Application', E: day('1998-03-01'), F: day('1998-04-01') });
  put(ws, 6, { A: 120, B: PROJECT_NAMES[2], D: 'Draft AIR', E: day('2004-01-01'), F: day('2004-02-01') });
  prefill(ws, 7);
  fillBlocks(ws, 4, 3, 10, Array.from({ length: PREFILLED_TO - 4 }, (_, i) => i + 5), false);
}

function timelines(workbook) {
  junk(workbook, 'Method');
  const ws = workbook.addWorksheet('2002');
  ws.getCell('A1').value = 'EAO Project Information';
  ['Average:', 'Median:', 'Sample Size:'].forEach((text, i) => { ws.getCell(3 + i, 2).value = text; });
  const days = ['<-- Days -->', ['x']];
  layout(ws, 8, [
    ['Project Information', ['Project Name']], ['Intake (A)', ['Intake (A)']], days, ['s.10 / Det (B)', ['Determination']],
    days, ['Scope (C)', ['s.11/14 Order']], days, ['AIR (D)', ['AIR Accepted']], ['Act Subtotal', ['s.10-AIR']],
    ['Effort Subtotal', ['Intake-AIR']], [null, [null]], ['PropTime (E)', ['AIR-EVAL']], [null, [null]],
    ['Evaluation (F)', ['Start (30)']], ['Extra Time (G)', ['Start Extra']], days, ['Review (H)', ['Start (180)']], days,
    ['Referral (I)', ['Start (45)']], days, ['Decision (J)', ['Date', 'Decision']]
  ]);
  put(ws, 10, { A: PROJECT_NAMES[2], B: day('2002-11-01'), D: day('2003-05-05'), F: day('2003-06-06'), U: FILL,
    V: 'Incomplete/Inactive' });
  workbook.addWorksheet('2018').addRow(['not', 'the', '2002', 'tab']);
  junk(workbook, 'Slide');
}

function assessmentBi(workbook) {
  const ws = mainSheet(workbook, 'EA Process Data', 'Project Environmental Assessment Process Data', [
    ['ID', ['No.']], ['Project Information', ['Project Name', 'Phase', 'EA Act', 'Notes']], ['People', ['EPD']],
    ['Intake', ['Type', 'Date']]
  ]);
  const [biNote, biEpd] = NEVER_READ_VALUES;
  const row = (rowNo, id, name, type, date) => put(ws, rowNo, { A: id, B: name, E: biNote, F: biEpd, G: type, H: date });
  row(5, 120, PROJECT_NAMES[2], 'Transition Order (2018)', day('2021-04-01'));
  row(6, 45, PROJECT_NAMES[0], 'Transition Order (2018)', FILL);
  row(7, 7, PROJECT_NAMES[1], 'IPD Accepted', day('2020-01-01'));
  prefill(ws, 8);
  junk(workbook, 'Graphics', 'Lookups');
}

/** Writes the business folder into `dir`, with BI Sheet workbooks that must never be read. */
async function buildWorkbooks(dir) {
  await save(dir, '01 - Project Business Intelligence Data 4.xlsx', projects);
  await save(dir, '01 - Project Assessment BI Sheet 5.xlsx', assessmentBi);
  await save(dir, '02 - Project Amendment Data 1.xlsx', amendments);
  await save(dir, '02 - Project Amendment BI Sheet.xlsx', wb => junk(wb, 'EA Process Data'));
  for (const decoy of ['Copy of 02 - Project Amendment Data 1.xlsx', '02 - Project Amendment Data 1 old.xlsx']) {
    await save(dir, decoy, wb => junk(wb, 'Amendments'));
  }
  await save(dir, '03 - Project Suspension Data.xlsx', wb => interruptions(wb, 'Suspensions', 'Suspension', {
    A: 45, B: PROJECT_NAMES[0], F: 'Suspension', G: 'Application Review', H: day('1998-01-01'),
    I: { formula: 'NOW()', result: day('2026-11-01') }, L: 'Suspension', M: 'Pre-Application',
    N: day('1998-03-01'), O: day('1998-04-01')
  }));
  await save(dir, '04 - Project Extension Data.xlsx', wb => interruptions(wb, 'Extensions', 'Extension', {
    A: 7, B: PROJECT_NAMES[1], F: 'Extension', G: 'Pre-Application', H: day('2001-02-01'), I: day('2001-03-01')
  }));
  await save(dir, '05 - Project Section 13 Data.xlsx', sectionThirteen);
  await save(dir, '06 - Project PCP Data 1.xlsx', commentPeriods);
  await save(dir, '06 - Dispute Resolution BI Sheet.xlsx', wb => junk(wb, 'EA Process Data'));
  await save(dir, 'Calculating Timelines for the 2002 Act.xlsx', timelines);
}

module.exports = { buildWorkbooks, STAFF_VALUES, NEVER_READ_VALUES, PROJECT_NAMES, REAL_IDS };
