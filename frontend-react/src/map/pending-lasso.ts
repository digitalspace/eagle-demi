/**
 * A saved area handed from the account screen to Map Explorer, which draws whatever is here when
 * it opens.
 */

export interface PendingLasso {
  ring: number[][];
  label: string;
}

let pending: PendingLasso | null = null;

export function setPendingLasso(lasso: PendingLasso): void {
  pending = lasso;
}

/** Read once: the map screen consumes this on open, so a later visit does not redraw an old area. */
export function takePendingLasso(): PendingLasso | null {
  const lasso = pending;
  pending = null;
  return lasso;
}
