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

  const start = useCallback(async (documentId: string, projectId?: string) => {
    if (!documentId || busy.current) return;
    busy.current = true;
    setBusyId(documentId);
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
