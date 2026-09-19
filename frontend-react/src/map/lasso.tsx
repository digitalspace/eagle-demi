/* eslint-disable react-refresh/only-export-components -- one lasso module: the shape the map draws
   and the pointer handling that produces it are the same unit of change. */
import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { Layer, Source } from '@vis.gl/react-maplibre';
import type { MapRef } from '@vis.gl/react-maplibre';
import type { FeatureCollection, Polygon } from 'geojson';
import { LASSO_MIN_POINTS } from './map-state';

export const LASSO_COLOUR = '#013366';
export const LASSO_SOURCE_ID = 'lasso';
export const LASSO_FILL_LAYER_ID = 'lasso-fill';
export const LASSO_LINE_LAYER_ID = 'lasso-line';

/**
 * Controls and markers are children of the map container, so the stroke listeners see their
 * presses too. A press on one of these is a button press, not the start of a draw.
 */
const CONTROL_SELECTOR = '.map-controls, .maplibregl-ctrl, .maplibregl-marker, .maplibregl-popup';

/** The server refuses a longer ring: `MAX_RING_POINTS` in `src/controllers/nosql/userdata.js`. */
export const LASSO_MAX_POINTS = 500;

/** GeoJSON polygons must close; a freehand stroke does not. Null when there is no line to close. */
export function closeRing(ring: number[][]): number[][] | null {
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (!first || ring.length < 2) return null;
  if (first[0] === last[0] && first[1] === last[1]) return ring;
  return [...ring, first];
}

/** Evenly spaced points from a long stroke: the shape survives, and the server will take it. */
export function decimate(ring: number[][], limit = LASSO_MAX_POINTS): number[][] {
  if (ring.length <= limit) return ring;
  const step = (ring.length - 1) / (limit - 1);
  return Array.from({ length: limit }, (_, index) => ring[Math.round(index * step)]);
}

interface LassoProperties {
  /** True while the stroke is still being drawn, which the fill paints against. */
  preview: boolean;
}

export function lassoCollection(
  ring: number[][],
  preview: boolean,
): FeatureCollection<Polygon, LassoProperties> {
  const closed = closeRing(ring);
  return {
    type: 'FeatureCollection',
    features: closed
      ? [
          {
            type: 'Feature',
            properties: { preview },
            geometry: { type: 'Polygon', coordinates: [closed] },
          },
        ]
      : [],
  };
}

/**
 * The drawn area, preview and committed alike. One source so the outline never disagrees with the
 * fill, and so the shape leaves the map the moment the ring goes.
 */
export function LassoShape({ ring, preview }: { ring: number[][]; preview: boolean }) {
  const data = useMemo(() => lassoCollection(ring, preview), [ring, preview]);

  return (
    <Source id={LASSO_SOURCE_ID} type="geojson" data={data}>
      <Layer
        id={LASSO_FILL_LAYER_ID}
        type="fill"
        paint={{
          'fill-color': LASSO_COLOUR,
          'fill-opacity': ['case', ['get', 'preview'], 0, 0.1],
        }}
      />
      <Layer
        id={LASSO_LINE_LAYER_ID}
        type="line"
        paint={{ 'line-color': LASSO_COLOUR, 'line-width': 3 }}
      />
    </Source>
  );
}

/**
 * Collects a freehand stroke off the map container while the tool is armed, and hands back the
 * points it has so far so the preview can be drawn. Pointer events, so a finger draws the same
 * shape a mouse does.
 */
export function useLassoDraw(
  mapRef: RefObject<MapRef | null>,
  armed: boolean,
  loaded: boolean,
  onStart: () => void,
  onCommit: (ring: number[][]) => void,
): number[][] | null {
  const [stroke, setStroke] = useState<number[][] | null>(null);
  const points = useRef<number[][]>([]);
  // Read at event time, so a re-rendered handler does not tear down and re-arm the whole tool.
  const handlers = useRef({ onStart, onCommit });
  useEffect(() => {
    handlers.current = { onStart, onCommit };
  });

  useEffect(() => {
    const map = mapRef.current;
    if (!armed || !map) return;
    const container = map.getContainer();

    const at = (event: PointerEvent): number[] => {
      const box = container.getBoundingClientRect();
      const point = map.unproject([event.clientX - box.left, event.clientY - box.top]);
      return [point.lng, point.lat];
    };

    let captured: number | null = null;
    let frame = 0;

    const release = () => {
      if (captured !== null && container.hasPointerCapture?.(captured)) {
        container.releasePointerCapture(captured);
      }
      captured = null;
    };

    // A stroke is hundreds of points; the preview only has to keep up with the screen.
    const publish = () => {
      frame = 0;
      setStroke([...points.current]);
    };

    const onPointerDown = (event: PointerEvent) => {
      if ((event.target as Element | null)?.closest?.(CONTROL_SELECTOR)) return;
      event.preventDefault();
      handlers.current.onStart();
      // Capture so pointerup still fires when the button is released outside the map.
      container.setPointerCapture?.(event.pointerId);
      captured = event.pointerId;
      points.current = [at(event)];
      publish();
    };

    const onPointerMove = (event: PointerEvent) => {
      if (!points.current.length) return;
      points.current.push(at(event));
      frame ||= requestAnimationFrame(publish);
    };

    const discard = () => {
      cancelAnimationFrame(frame);
      frame = 0;
      release();
      points.current = [];
      setStroke(null);
    };

    const onPointerUp = () => {
      const drawn = decimate(points.current);
      discard();
      if (drawn.length >= LASSO_MIN_POINTS) handlers.current.onCommit(drawn);
    };

    map.dragPan?.disable();
    container.style.cursor = 'crosshair';
    // Without this a touch drag scrolls the page and no pointermove ever reaches us.
    container.style.touchAction = 'none';
    container.addEventListener('pointerdown', onPointerDown);
    container.addEventListener('pointermove', onPointerMove);
    container.addEventListener('pointerup', onPointerUp);
    container.addEventListener('pointercancel', discard);

    return () => {
      container.removeEventListener('pointerdown', onPointerDown);
      container.removeEventListener('pointermove', onPointerMove);
      container.removeEventListener('pointerup', onPointerUp);
      container.removeEventListener('pointercancel', discard);
      map.dragPan?.enable();
      container.style.cursor = '';
      container.style.touchAction = '';
      discard();
    };
    // `loaded` is not read: it re-runs this once the map exists, which a ref change does not do.
  }, [mapRef, armed, loaded]);

  return stroke;
}
