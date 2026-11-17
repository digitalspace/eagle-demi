import { useState } from 'react';
import { RECORD_KINDS, useNrptiForProject, type NrptiMine, type NrptiRecord, type NrptiTruncation } from '../api/nrpti';
import { dayMonthYear } from '../dates';

// A record type with more rows than this starts folded; big mines hold a few hundred inspections.
const OPEN_UP_TO = 10;
const KIND_ORDER = Object.values(RECORD_KINDS);
const kindRank = (kind: string) => (KIND_ORDER.includes(kind) ? KIND_ORDER.indexOf(kind) : KIND_ORDER.length);

/** Groups in RECORD_KINDS order; a kind NRPTI added later goes last. */
function groupByKind(records: NrptiRecord[]): [string, NrptiRecord[]][] {
  const groups = new Map<string, NrptiRecord[]>();
  for (const record of records) {
    const group = groups.get(record.kind);
    if (group) group.push(record);
    else groups.set(record.kind, [record]);
  }
  return [...groups].sort(([a], [b]) => kindRank(a) - kindRank(b));
}

function truncationNote({ what, read, total }: NrptiTruncation) {
  const count = total === null ? `${read}` : `${read} of ${total}`;
  return what === 'records'
    ? `NRPTI returned its newest ${count} record matches; older ones are not shown.`
    : `NRPTI returned ${count} matching mines; the rest are not shown.`;
}

function mineCard(mine: NrptiMine) {
  const lines = [
    [mine.status, mine.commodities.join(', ')].filter(Boolean).join(' · '),
    mine.permittee && `Permittee: ${mine.permittee}`,
    mine.region && `Region: ${mine.region}`,
    mine.permitNumber && `Permit ${mine.permitNumber}`,
  ].filter(Boolean);
  return (
    <div key={mine.id} className="ps-card">
      <span className="micro-label ps-card__category">Mine</span>
      <span className="ps-card__title">{mine.name}</span>
      {lines.map((line) => (
        <span key={line} className="ps-card__text">
          {line}
        </span>
      ))}
    </div>
  );
}

function recordRow(record: NrptiRecord) {
  return (
    <li key={record.id} className="ps-list__row">
      <span className="ps-list__date">{dayMonthYear(record.dateIssued) || '—'}</span>
      <span>
        <span className="ps-list__title">{record.title}</span>
        <span className="ps-list__text">{[record.kind, record.agency].filter(Boolean).join(' · ')}</span>
        {record.documents.map((doc) => (
          <span key={doc.id} className="ps-list__text">
            <a className="ps-card__link" href={doc.url} target="_blank" rel="noopener noreferrer">
              {doc.fileName}
              <span className="visually-hidden"> (opens in a new tab)</span>
            </a>
          </span>
        ))}
      </span>
    </li>
  );
}

/** NRPTI mines and compliance records linked to one project; each part shows as soon as it lands. */
export function NrptiPanel({ eagleId }: { eagleId: string }) {
  const { mines, records, truncated, minesLoading, recordsLoading, isError } = useNrptiForProject(eagleId);
  const loading = minesLoading || recordsLoading;
  const settled = !loading && !isError;
  const groups = groupByKind(records);

  // Open or folded is decided once per kind when the records finish, so a group never snaps shut on later rows.
  const [openKinds, setOpenKinds] = useState<Record<string, boolean>>({});
  const undecided = recordsLoading ? [] : groups.filter(([kind]) => !(kind in openKinds));
  if (undecided.length) {
    setOpenKinds({ ...openKinds, ...Object.fromEntries(undecided.map(([kind, group]) => [kind, group.length <= OPEN_UP_TO])) });
  }

  const body = !eagleId ? (
    <p className="ps-note">This project has no EPIC id, so no NRPTI records are linked to it.</p>
  ) : (
    <>
      {isError && (
        <p className="ps-note" role="alert">
          NRPTI could not be reached for some or all of this project. The rest of this page is unaffected.
        </p>
      )}
      {mines.length > 0 && <div className="ps-cards">{mines.map(mineCard)}</div>}
      {truncated.map((item, i) => (
        <p key={i} className="ps-note">
          {truncationNote(item)}
        </p>
      ))}
      {groups.map(([kind, group]) => (
        <details
          key={kind}
          className="ps-sources"
          open={openKinds[kind] ?? false}
          onToggle={(event) => {
            const open = event.currentTarget.open;
            setOpenKinds((prev) => (prev[kind] === open ? prev : { ...prev, [kind]: open }));
          }}
        >
          <summary className="ps-sources__summary">
            {kind} ({group.length})
          </summary>
          <ul className="ps-list">{group.map(recordRow)}</ul>
        </details>
      ))}
      <div role="status">
        {loading && (
          <p className="ps-list__text">
            {minesLoading || !records.length ? 'Loading NRPTI records…' : 'Loading more NRPTI records…'}
          </p>
        )}
        {settled && records.length > 0 && (
          <p className="visually-hidden">
            {records.length} NRPTI {records.length === 1 ? 'record' : 'records'} loaded
          </p>
        )}
        {settled && !records.length && (
          <p className="ps-note">
            {mines.length
              ? 'No NRPTI records beyond those already published on EPIC.'
              : 'NRPTI has no mine or compliance records linked to this project beyond what EPIC already publishes.'}
          </p>
        )}
      </div>
    </>
  );

  return (
    <section className="ps-section" aria-labelledby="ps-nrpti-h">
      <h2 id="ps-nrpti-h" className="ps-section__title">
        NRPTI (CORE stand-in)
      </h2>
      <p className="ps-section__lede">
        Read live from the public NRPTI service and not stored in DEMI. Records that came from EPIC are left out.
      </p>
      {body}
    </section>
  );
}
