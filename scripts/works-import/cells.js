'use strict';

const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');
const { SOURCES, D, T } = require('./sources');

const SENTINEL_DATE = '1995-06-30';
const NULL_TEXT = new Set(['', '---', 'n/a']);
const MAX_INPUT_BYTES = 50 * 1024 * 1024;
const NOW_ONLY = /^=?\s*(NOW|TODAY)\s*\(\s*\)\s*$/i;
const VOLATILE = /\b(NOW|TODAY)\s*\(/i;
const YEARS = [1900, 2100];
const ERROR = Symbol('errorCell');

function cached(value) {
  if (value == null || value instanceof Date || typeof value !== 'object') return value ?? null;
  if ('error' in value) return ERROR;
  if ('formula' in value || 'sharedFormula' in value || 'result' in value) return cached(value.result);
  if (Array.isArray(value.richText)) return value.richText.map(r => r.text).join('');
  if ('text' in value) return cached(value.text);
  return null;
}

function isoDay(date) {
  const year = date.getUTCFullYear();
  return year >= YEARS[0] && year <= YEARS[1] ? date.toISOString().slice(0, 10) : null;
}

/** Cached value of one cell as {value, flag}; formulas are never evaluated. */
function typed(cell, type) {
  const formula = cell.formula || '';
  // A bare =NOW() means "still open"; its cached value is only the day the file was saved.
  if (NOW_ONLY.test(formula)) return { value: null, flag: 'nowFormula' };
  const flag = VOLATILE.test(formula) ? 'volatileFormula' : undefined;
  const value = cached(cell.value);
  if (value === ERROR) return { value: null, flag: 'errorCell' };
  if (value == null || (typeof value === 'string' && NULL_TEXT.has(value.trim().toLowerCase()))) return { value: null, flag };
  if (value instanceof Date) {
    const day = isoDay(value);
    return day ? { value: day, flag } : { value: null, flag: 'badDate' };
  }
  const text = String(value).trim();
  if (type === 'id') return /^\d+$/.test(text) ? { value: Number(text), flag } : { value: null, flag: 'badId' };
  if (type === D) return /^\d{4}-\d{2}-\d{2}$/.test(text) ? { value: text, flag } : { value: null, flag: 'badDate' };
  return { value: typeof value === 'string' ? text : value, flag };
}

function label(ws, rowNo, col) {
  const value = cached(ws.getRow(rowNo).getCell(col).value);
  return (value === ERROR || value == null ? '' : String(value)).replace(/\s+/g, ' ').trim().toLowerCase();
}

const columnNumber = letters => [...letters].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0);

/** [base columns, then one column list per block slot], each entry [column, field, band, header, type]. */
function columnsOf(source) {
  const b = source.blocks;
  const slot = s => b.columns.map(([offset, field, header, type = T]) =>
    [columnNumber(b.from) + (s - 1) * b.columns.length + offset, field, b.band(s), header, type]);
  return [source.columns, ...Array.from({ length: b ? b.count : 0 }, (_, i) => slot(i + 1))];
}

/** Refuses a sheet whose band or header labels differ from the map, before any row is read. */
function checkHeaders(ws, source, file) {
  for (const [col, , band, header] of columnsOf(source).flat()) {
    if (label(ws, source.bandRow, col) !== band.toLowerCase() || label(ws, source.headerRow, col) !== header.toLowerCase()) {
      throw new Error(`${file} / ${ws.name}: column ${ws.getColumn(col).letter} is not "${band}" / "${header}"`);
    }
  }
}

function pick(row, columns, ref, flags) {
  const out = {};
  for (const [col, field, , , type] of columns) {
    if (!field) continue;
    const { value, flag } = typed(row.getCell(col), type);
    out[field] = value;
    if (flag) flags.push({ ...ref, field, kind: flag });
    if (type === D && value === SENTINEL_DATE) flags.push({ ...ref, field, kind: 'sentinel' });
  }
  return out;
}

const blank = rec => Object.values(rec).every(v => v == null);

function rangeFlags(source, rec, ref, flags) {
  for (const [start, end] of source.ranges || []) {
    if (rec[start] && rec[end] && rec[end] < rec[start]) flags.push({ ...ref, field: end, kind: 'endBeforeStart' });
  }
}

// Ids and slot numbers are pre-filled far below the data, so a nameless row only counts when it holds more.
function unnamedWithData(base, row, slots, ref) {
  if ('id' in base && base.id == null) return false;
  const { id: _id, name: _name, ...rest } = base;
  return !blank(rest) || slots.some(columns => !blank(pick(row, columns, ref, [])));
}

function readSheet(ws, source, file, out) {
  checkHeaders(ws, source, file);
  const [, ...slots] = columnsOf(source);
  for (let r = source.headerRow + 1; r <= ws.rowCount; r += 1) {
    const row = ws.getRow(r);
    const ref = { file, sheet: ws.name, row: r };
    const flags = [];
    const base = pick(row, source.columns, ref, flags);
    if (source.keep ? !source.keep(base) : base.name == null) {
      if (!source.keep && unnamedWithData(base, row, slots, ref)) out.flags.push({ ...ref, field: 'name', kind: 'unnamedRow' });
      continue;
    }
    if ('id' in base && base.id == null) {
      out.flags.push({ ...ref, field: 'id', kind: 'badId' });
      continue;
    }
    if (!source.blocks) {
      rangeFlags(source, base, ref, flags);
      out.records[source.key].push({ ref, ...base });
    }
    slots.forEach((columns, i) => {
      const slotRef = { ...ref, slot: i + 1 };
      const slotFlags = [];
      const fields = pick(row, columns, slotRef, slotFlags);
      if (blank(fields)) return;
      rangeFlags(source, fields, slotRef, slotFlags);
      flags.push(...slotFlags);
      out.records[source.key].push({ ref: slotRef, id: base.id, name: base.name, ...fields });
    });
    out.flags.push(...flags);
  }
}

function duplicateFlags(rows) {
  const seen = new Set();
  return rows.filter(r => seen.has(r.id) || !seen.add(r.id)).map(r => ({ ...r.ref, field: 'id', kind: 'duplicateId' }));
}

function countsOf(records) {
  const counts = Object.fromEntries(Object.entries(records).map(([key, rows]) => [key, rows.length]));
  counts.projects = new Set(records.projects.map(r => r.id)).size;
  counts.transitionsDated = records.transitions.filter(r => r.date).length;
  return counts;
}

/** Reads one regular file, refusing a symbolic link or anything over the size cap. */
function readInput(dir, file) {
  let fd;
  try {
    fd = fs.openSync(path.join(dir, file), fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  } catch (err) {
    throw new Error(err.code === 'ELOOP' ? `${file} is a symbolic link` : `${file} cannot be opened`, { cause: err });
  }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw new Error(`${file} is not a regular file`);
    if (stat.size > MAX_INPUT_BYTES) throw new Error(`${file} is over ${MAX_INPUT_BYTES} bytes`);
    return fs.readFileSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/** Reads the mapped columns of every workbook in `dir`, in memory. */
async function readFolder(dir) {
  const files = fs.readdirSync(dir);
  const out = { records: {}, flags: [] };
  for (const source of SOURCES) {
    const matches = files.filter(f => source.file.test(f));
    if (matches.length !== 1) throw new Error(`${source.key}: expected one workbook, found ${matches.length}`);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(readInput(dir, matches[0]));
    const ws = workbook.getWorksheet(source.tab);
    if (!ws) throw new Error(`${matches[0]}: no tab "${source.tab}"`);
    out.records[source.key] = [];
    readSheet(ws, source, matches[0], out);
    if (source.uniqueId) out.flags.push(...duplicateFlags(out.records[source.key]));
  }
  return { ...out, counts: countsOf(out.records) };
}

module.exports = { readFolder };
