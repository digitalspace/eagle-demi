import type { MarkStyle } from './chart-types';

/**
 * Empty px at each end of every Act's track, at every zoom: room for a jump link beside the first or last bar.
 * The plot is the track less these ends; marks, ticks, grid and the scroll window strip place dates on the plot.
 */
export const EDGE_PX = 84;

/** Sets `--wp-ov-edge` for the CSS plot layers, so CSS and scroll maths read one value. */
export const edgeStyle: MarkStyle = { '--wp-ov-edge': `${EDGE_PX}px` };

/** Plot width in px of a track `track` px wide. */
export const plotWidth = (track: number) => Math.max(1, track - 2 * EDGE_PX);

/** Px from the track start of `at`, a fraction of the plot. */
export const plotPx = (at: number, track: number) => EDGE_PX + at * plotWidth(track);

/** Fraction of the plot at `px` from the track start; below 0 or above 1 in the end buffers. */
export const plotAt = (px: number, track: number) => (px - EDGE_PX) / plotWidth(track);
