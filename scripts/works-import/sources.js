'use strict';

const D = 'date';
const T = 'text';
const TRANSITION_PROCESS = 'transition order (2018)';
const pad = n => String(n).padStart(2, '0');
const fileNamed = name => new RegExp(`^${name}( \\d+)?\\.xlsx$`, 'i');
// Entry: [letter, field (null: label checked, value not copied), band label on the row above, header label, type].
const under = (band, cols) => cols.map(([col, field, header, type = T]) => [col, field, band, header, type]);
const blocks = (from, count, band, columns) => ({ from, count, band: s => `${band} ${pad(s)}`, columns });
const ID_NAME = [...under('ID', [['A', 'id', 'ID', 'id']]), ...under('Project Information', [['B', 'name', 'Name']])];
const INTERRUPTION = [[0, null, 'No.'], [1, 'type', 'Type'], [2, 'appliedTo', 'Applied To'],
  [3, 'startDate', 'Start Date', D], [4, 'endDate', 'End Date', D], [5, null, 'Days']];
const START_END = [['startDate', 'endDate']];
const MAIN = { bandRow: 3, headerRow: 4 };

// The only workbooks, tabs and columns copied into the extract. exceljs still parses each whole
// workbook in memory; nothing from other tabs (For BI, Lookups, TEMP, ...) leaves it.
const SOURCES = [
  { key: 'projects', file: fileNamed('01 - Project Business Intelligence Data'), tab: 'Projects', ...MAIN,
    ranges: [['intakeDate', 'decisionDate']], uniqueId: true, columns: [...ID_NAME,
      ...under('Project Information', [['C', 'proponent', 'Proponent/Certificate Holder'], ['D', 'status', 'Status'],
        ['E', null, 'Work'], ['F', 'ceaa', 'CEAA'], ['G', 'subsector', 'Subsector'], ['H', 'regionEnv', 'Region (ENV)'],
        ['I', 'regionFlnro', 'Region (FLNRO)'], ['J', 'investment', 'Investment $'], ['K', 'notes', 'Notes']]),
      ...under('Team Information', [['L', 'epd', 'EPD'], ['M', 'lead', 'Lead']]),
      ...under('Intake (Start)', [['Q', 'intakeType', 'Type'], ['R', 'intakeDate', 'Date', D]]),
      ...under('Determination', [['S', 'determinationType', 'Type'], ['T', 'determinationDate', 'Date', D]]),
      ...under('Scope', [['U', 's11Order', 's.11/14 Order', D], ['V', 'draftAir', 'Draft AIR', D], ['W', 'airAccepted', 'AIR', D]]),
      ...under('Evaluation', [['X', 'start30', 'Start (30)', D]]), ...under('Review', [['Y', 'start180', 'Start (180)', D]]),
      ...under('Decision', [['Z', 'start45', 'Start (45)', D], ['AA', 'decision', 'Decision'],
        ['AB', 'decisionDate', 'Date', D], ['AC', 'far', 'F.A.R.']]),
      ...under('Substantially Started', [['AE', 'substantialStartStatus', 'Status'],
        ['AF', 'substantialStartDate', 'Date', D], ['AG', 'substantialStartFlag', 'SS?']]),
      ...under('Certificate Information', [['AH', 'expiryDate', 'Expiry Date', D],
        ['AI', 'extensionDate', 'Extension Date', D], ['AJ', 'extensionExpiry', 'Extension Expiry', D]])] },
  { key: 'amendments', file: fileNamed('02 - Project Amendment Data'), tab: 'Amendments', ...MAIN, columns: ID_NAME,
    ranges: START_END, blocks: blocks('D', 15, 'Amendment', [[0, null, 'No.'], [1, 'complexity', 'Complexity'],
      [2, 'status', 'Status'], [3, 'startDate', 'Start Date', D], [4, 'endDate', 'End Date', D]]) },
  { key: 'suspensions', file: fileNamed('03 - Project Suspension Data'), tab: 'Suspensions', ...MAIN, columns: ID_NAME,
    ranges: START_END, blocks: blocks('E', 10, 'Suspension', INTERRUPTION) },
  { key: 'extensions', file: fileNamed('04 - Project Extension Data'), tab: 'Extensions', ...MAIN, columns: ID_NAME,
    ranges: START_END, blocks: blocks('E', 10, 'Extension', INTERRUPTION) },
  { key: 'orderVariations', file: fileNamed('05 - Project Section 13 Data'), tab: 'Section 13', ...MAIN, columns: ID_NAME,
    blocks: blocks('D', 10, 'Variation', [[0, null, 'No.'], [1, 'date', 'Date', D]]) },
  { key: 'commentPeriods', file: fileNamed('06 - Project PCP Data'), tab: 'PCPs', ...MAIN, columns: ID_NAME,
    ranges: START_END, blocks: blocks('D', 10, 'Public Comment Period',
      [[0, 'type', 'Type'], [1, 'startDate', 'Start Date', D], [2, 'endDate', 'End Date', D]]) },
  // No ID column: these rows join to the register by project name.
  { key: 'timeline2002', file: fileNamed('Calculating Timelines for the 2002 Act'), tab: '2002', bandRow: 8, headerRow: 9,
    columns: [...under('Project Information', [['A', 'name', 'Project Name']]),
      ...under('Intake (A)', [['B', 'intakeDate', 'Intake (A)', D]]),
      ...under('s.10 / Det (B)', [['D', 'determinationDate', 'Determination', D]]),
      ...under('Scope (C)', [['F', 's11Order', 's.11/14 Order', D]]),
      ...under('AIR (D)', [['H', 'airAccepted', 'AIR Accepted', D]]),
      ...under('Evaluation (F)', [['N', 'start30', 'Start (30)', D]]),
      ...under('Review (H)', [['Q', 'start180', 'Start (180)', D]]),
      ...under('Referral (I)', [['S', 'start45', 'Start (45)', D]]),
      ...under('Decision (J)', [['U', 'decisionDate', 'Date', D], ['V', 'decision', 'Decision']])] },
  // Columns A, G and H only: the sheet's Notes (E) and EPD (F) columns are never copied.
  { key: 'transitions', file: fileNamed('01 - Project Assessment BI Sheet'), tab: 'EA Process Data', ...MAIN,
    columns: [...under('ID', [['A', 'id', 'No.', 'id']]), ...under('Intake', [['G', 'process', 'Type'], ['H', 'date', 'Date', D]])],
    keep: row => String(row.process || '').toLowerCase() === TRANSITION_PROCESS }
];

module.exports = { SOURCES, D, T };
