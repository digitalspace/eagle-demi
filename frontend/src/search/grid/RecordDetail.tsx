import { Fragment, useEffect, useRef } from 'react';
import type { ListRowAttachment } from '../grid-types';
import { RecordLink, type ListRowField, type ListRowMeta } from './parts';
import './record-detail.css';

/** The record's own page, offered at the foot of the sheet. */
export interface RecordDetailLink {
  href: string;
  label: string;
  /** Leaves the app, so it opens as a plain anchor in its own tab. */
  external?: boolean;
}

/**
 * One record as the dialog reads it. Built by whoever owns the record type's columns, so the
 * dialog itself knows nothing about projects, documents, updates or notifications.
 */
export interface RecordDetail {
  title: string;
  /** Unlabelled parts, as the list row draws them: date · kind · project. */
  meta: ListRowMeta[];
  fields: ListRowField[];
  /** The record's own words, in full rather than excerpted. */
  body?: string;
  attachments?: ListRowAttachment[];
  link?: RecordDetailLink;
  /** A presigned file: the id the page asks the API for on the press. */
  documentId?: string;
}

function attachmentMeta(attachment: ListRowAttachment): string {
  return [attachment.type, attachment.size].filter(Boolean).join(' · ');
}

/**
 * One record read in place, rather than by leaving the result set for its own page. A native
 * `<dialog>` opened with `showModal()`, so Escape, the top layer and an inert background are the
 * browser's own. `onClose` fires for Escape, the Close button and a link that navigates alike.
 */
export function RecordDetailSheet({
  detail,
  onClose,
  onDownload,
}: {
  detail: RecordDetail | null;
  onClose: () => void;
  onDownload: (documentId: string) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);

  // showModal() only once the contents are written, or the sheet opens empty.
  useEffect(() => {
    const element = dialog.current;
    if (detail && element && !element.open) element.showModal();
  }, [detail]);

  const close = () => dialog.current?.close();

  return (
    <dialog ref={dialog} className="record-detail" aria-labelledby="record-detail-title" onClose={onClose}>
      {detail && (
        <div className="record-detail__sheet">
          <div className="record-detail__head">
            <h2 id="record-detail-title" className="record-detail__title">
              {detail.title}
            </h2>
            <button type="button" className="record-detail__close" aria-label="Close" onClick={close}>
              ×
            </button>
          </div>

          <div className="record-detail__body">
            {detail.meta.length > 0 && (
              <p className="record-detail__meta">
                {detail.meta.map((part, index) => (
                  <Fragment key={index}>
                    {index > 0 && <span aria-hidden="true"> · </span>}
                    {part.href ? (
                      // A meta link leaves the result set, so the sheet goes with it.
                      <RecordLink href={part.href} onClick={close}>
                        {part.text}
                      </RecordLink>
                    ) : (
                      part.text
                    )}
                  </Fragment>
                ))}
              </p>
            )}

            {detail.fields.length > 0 && (
              <dl className="record-detail__fields">
                {detail.fields.map((field) => (
                  <div key={field.label}>
                    <dt>{field.label}</dt>
                    <dd>{field.value}</dd>
                  </div>
                ))}
              </dl>
            )}

            {detail.body && <p className="record-detail__prose">{detail.body}</p>}

            {!!detail.attachments?.length && (
              <div className="record-detail__docs">
                <p className="record-detail__docs-count">Attachments</p>
                <ul aria-label="Attachments">
                  {detail.attachments.map((attachment) => (
                    <li key={attachment.href}>
                      <a href={attachment.href} download>
                        {attachment.name}
                      </a>
                      {attachmentMeta(attachment) && (
                        <span className="record-detail__docs-meta">{attachmentMeta(attachment)}</span>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>

          <div className="record-detail__actions">
            {detail.documentId && (
              <button
                type="button"
                className="record-detail__button record-detail__button--primary"
                onClick={() => onDownload(detail.documentId as string)}
              >
                Download
              </button>
            )}
            {detail.link && (
              <RecordLink
                href={detail.link.href}
                external={!!detail.link.external}
                className="record-detail__button"
                onClick={close}
              >
                {detail.link.label}
              </RecordLink>
            )}
          </div>
        </div>
      )}
    </dialog>
  );
}
