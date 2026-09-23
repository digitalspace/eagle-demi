import { useCallback, useRef, useState } from 'react';
import { getDownloadUrl } from '../api/documents';

/**
 * The presigned-download press, shared by every screen that offers a file.
 *
 * `busyId` names the row being prepared so a list can disable just that control. The guard is a
 * ref, not `busyId`, because two presses in one tick both read the state before React re-renders.
 */
export function useDownload() {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);

  // `rowId` names the row when it is not the document: two citations can cite one document, and
  // keying on the document would mark both rows busy.
  const start = useCallback(async (documentId: string, projectId?: string, rowId?: string) => {
    if (!documentId || busy.current) return;
    busy.current = true;
    setBusyId(rowId ?? documentId);
    setError(null);
    try {
      const url = await getDownloadUrl(documentId, projectId);
      window.open(url, '_blank', 'noopener');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not prepare the download.');
    } finally {
      busy.current = false;
      setBusyId(null);
    }
  }, []);

  return { busyId, error, start };
}
