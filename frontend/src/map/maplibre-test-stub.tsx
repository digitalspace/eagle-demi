/* eslint-disable react-refresh/only-export-components -- test double: the fake map and the
   components that expose it are one unit. */
import {
  createContext,
  useContext,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type ReactNode,
  type Ref,
} from 'react';
import { vi } from 'vitest';
import type { Feature, FeatureCollection, Point } from 'geojson';

/**
 * Stand-in for `@vis.gl/react-maplibre` under jsdom, which has no WebGL. Specs mock the module
 * at the top level, where `vi.mock` is hoisted:
 *
 *   vi.mock('@vis.gl/react-maplibre', async () =>
 *     (await import('../map/maplibre-test-stub')).mapLibreStub());
 */

interface BoundsBox {
  north: number;
  south: number;
  east: number;
  west: number;
}

/** The whole of BC, so every fixture centroid is in view until a spec narrows it. */
const BC_BOX: BoundsBox = { north: 60, south: 48, east: -114, west: -139 };

let box: BoundsBox = { ...BC_BOX };
let zoom = 6;
let sourceLoaded = true;
/** Set by a spec to drive clusters; otherwise the rendered `<Source data>` supplies the features. */
let override: Feature<Point>[] | null = null;
/** What a cluster stands for, as the real source answers `getClusterLeaves`. */
let leaves: Feature<Point>[] = [];
// A plain record, not a `Map`: the stub's own `Map` component shadows the built-in in this module.
let sourceData: Record<string, FeatureCollection> = {};
/** The mounted map's `render` handler; the real map repaints whenever anything below changes. */
let notifyRender: (() => void) | null = null;
const fireRender = () => notifyRender?.();
/** Style contents, in insertion order, so a spec can assert what the map is drawing and in what order. */
let sources = new Set<string>();
let layers = new Set<string>();
let sourceTiles: Record<string, string[]> = {};
/** jsdom gives every element a zero-sized box, so the stub supplies the one `unproject` divides by. */
export const VIEWPORT_SIZE = 1000;

/** jsdom's own pointer capture rejects an id it never saw go down, so the stub keeps the set. */
function withPointerCapture(element: HTMLElement): HTMLElement {
  const held = new Set<number>();
  element.setPointerCapture = (id: number) => {
    held.add(id);
  };
  element.releasePointerCapture = (id: number) => {
    held.delete(id);
  };
  element.hasPointerCapture = (id: number) => held.has(id);
  return element;
}

/**
 * The map's container. The mounted map replaces it with its own rendered element, so a press on a
 * control really is a press on a child of the container, the way the browser reports it.
 */
let container = withPointerCapture(document.createElement('div'));

export const fakeMap = {
  getBounds: vi.fn(() => ({
    getNorth: () => box.north,
    getSouth: () => box.south,
    getEast: () => box.east,
    getWest: () => box.west,
  })),
  getZoom: vi.fn(() => zoom),
  fitBounds: vi.fn(),
  resize: vi.fn(),
  flyTo: vi.fn(),
  easeTo: vi.fn(),
  getClusterExpansionZoom: vi.fn(async (_clusterId: number) => 11),
  getClusterLeaves: vi.fn(async (_clusterId: number, _limit: number, _offset: number) => leaves),
  // A source the style has not got is not loaded, whatever the flag says.
  isSourceLoaded: vi.fn((sourceId: string) => sourceLoaded && sources.has(sourceId)),
  querySourceFeatures: vi.fn(
    (sourceId: string) => override ?? sourceData[sourceId]?.features ?? [],
  ),
  getLayer: vi.fn((id: string) => (layers.has(id) ? { id } : undefined)),
  moveLayer: vi.fn((id: string) => {
    // The real map lifts the layer to the top of the style; order here is insertion order.
    layers.delete(id);
    layers.add(id);
  }),
  setTiles: vi.fn(),
  getSource: vi.fn((id: string) =>
    sources.has(id)
      ? {
          id,
          getClusterExpansionZoom: fakeMap.getClusterExpansionZoom,
          getClusterLeaves: fakeMap.getClusterLeaves,
          setTiles: fakeMap.setTiles,
        }
      : undefined,
  ),
  setFeatureState: vi.fn(),
  removeFeatureState: vi.fn(),
  getContainer: vi.fn(() => container),
  dragPan: { disable: vi.fn(), enable: vi.fn() },
  /**
   * Container pixels back to coordinates. The fake viewport is the whole of BC over a 1000x1000
   * box, so a spec can name a pixel and know which fixture centroid it lands on.
   */
  unproject: vi.fn(([x, y]: [number, number]) => ({
    lng: box.west + ((box.east - box.west) * x) / VIEWPORT_SIZE,
    lat: box.north - ((box.north - box.south) * y) / VIEWPORT_SIZE,
  })),

  /** Style layer ids, in the order the map holds them. */
  layerIds(): string[] {
    return [...layers];
  },
  sourceIds(): string[] {
    return [...sources];
  },

  setBounds(next: BoundsBox): void {
    box = next;
  },
  setMapZoom(next: number): void {
    zoom = next;
  },
  /** False stands in for a source still being clustered, when a repaint must change nothing. */
  setSourceLoaded(next: boolean): void {
    sourceLoaded = next;
  },
  setFeatures(features: Feature<Point>[] | null): void {
    override = features;
    notifyRender?.();
  },
  /** The projects the next cluster click resolves to. */
  setClusterLeaves(features: Feature<Point>[]): void {
    leaves = features;
  },
  /** Repaint on demand, for a spec that changed the view without re-rendering React. */
  repaint(): void {
    notifyRender?.();
  },
  reset(): void {
    box = { ...BC_BOX };
    zoom = 6;
    sourceLoaded = true;
    override = null;
    leaves = [];
    sourceData = {};
    sources = new Set();
    layers = new Set();
    sourceTiles = {};
    container = withPointerCapture(document.createElement('div'));
    notifyRender = null;
    mapProps = null;
    for (const value of Object.values(fakeMap)) {
      if (typeof value === 'function' && 'mockClear' in value) value.mockClear();
    }
    fakeMap.dragPan.disable.mockClear();
    fakeMap.dragPan.enable.mockClear();
  },
};

/**
 * One freehand stroke over the map container, in container pixels. Pointer events, because that is
 * what the screen listens for: the same call stands in for a mouse drag and for a finger.
 */
export function drawStroke(points: [number, number][]): void {
  const event = (type: string, [x, y]: [number, number]) =>
    container.dispatchEvent(
      new PointerEvent(type, { bubbles: true, pointerId: 1, clientX: x, clientY: y }),
    );

  event('pointerdown', points[0]);
  for (const point of points.slice(1)) event('pointermove', point);
  event('pointerup', points[points.length - 1]);
}

/** Aborts a stroke the way a system gesture does, leaving nothing committed. */
export function cancelStroke(): void {
  container.dispatchEvent(new PointerEvent('pointercancel', { bubbles: true, pointerId: 1 }));
}

type FakeMap = typeof fakeMap;

const RenderContext = createContext<(() => void) | undefined>(undefined);

/** The parts of a MapLibre pointer event a spec has to supply. */
interface FakeMouseEvent {
  features?: (Feature & { layer?: { id: string }; id?: string | number })[];
  point: { x: number; y: number };
  lngLat?: { lng: number; lat: number };
  originalEvent?: { target: EventTarget | null };
}

interface MapProps {
  children?: ReactNode;
  onLoad?: () => void;
  onRender?: () => void;
  onMoveEnd?: () => void;
  onClick?: (event: FakeMouseEvent) => void;
  onMouseMove?: (event: FakeMouseEvent) => void;
  onMouseLeave?: (event: FakeMouseEvent) => void;
  ref?: Ref<FakeMap>;
  [key: string]: unknown;
}

/** The mounted map's props, so a spec can fire a handler the real map only fires from a pointer. */
export let mapProps: MapProps | null = null;

function Map(props: MapProps) {
  const { children, onLoad, onRender, ref } = props;
  const host = useRef<HTMLDivElement>(null);
  useImperativeHandle(ref, () => fakeMap, []);
  // After commit, so a spec never fires a handler from a render that was thrown away.
  useEffect(() => {
    mapProps = props;
  });
  // Once, on mount: the real map fires `load` when its style and canvas are ready, then repaints.
  useEffect(() => {
    if (host.current) container = withPointerCapture(host.current);
    notifyRender = () => onRender?.();
    onLoad?.();
    notifyRender();
    return () => {
      notifyRender = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <RenderContext value={fireRender}>
      <div data-testid="map" ref={host}>
        {children}
      </div>
    </RenderContext>
  );
}

interface SourceProps {
  children?: ReactNode;
  id?: string;
  data?: FeatureCollection;
  tiles?: string[];
}

function Source({ children, id, data, tiles }: SourceProps) {
  const notify = useContext(RenderContext);
  // By value, as the real binding compares them: the same URLs in a new array are not a re-tile.
  const tileKey = tiles?.join('|');

  useEffect(() => {
    if (!id) return;
    sources.add(id);
    return () => {
      sources.delete(id);
      delete sourceTiles[id];
      delete sourceData[id];
    };
  }, [id]);

  // A raster source is created holding its first tiles; a later change goes through `setTiles`.
  useEffect(() => {
    if (!id || tileKey === undefined) return;
    const next = tileKey.split('|');
    if (sourceTiles[id]) fakeMap.setTiles(next);
    sourceTiles[id] = next;
  }, [id, tileKey]);

  // A real source re-tiles when its data changes, and the map repaints once it has.
  useEffect(() => {
    if (!data || !id) return;
    sourceData[id] = data;
    notify?.();
  }, [data, id, notify]);

  return <>{children}</>;
}

/** The tile templates a raster source is holding now. */
export function sourceTilesFor(id: string): string[] | undefined {
  return sourceTiles[id];
}

/** What a GeoJSON source is currently holding, or undefined once it has left the style. */
export function sourceDataFor(id: string): FeatureCollection | undefined {
  return sourceData[id];
}

interface MarkerProps {
  children?: ReactNode;
  longitude: number;
  latitude: number;
  style?: Record<string, unknown>;
}

function Marker({ children, longitude, latitude, style }: MarkerProps) {
  return (
    <div
      data-testid="marker"
      data-lng={longitude}
      data-lat={latitude}
      data-z={String(style?.['zIndex'] ?? '')}
    >
      {children}
    </div>
  );
}

interface LayerProps {
  id?: string;
  filter?: unknown;
  paint?: Record<string, unknown>;
  layout?: { visibility?: string };
}

/** Rendered, not dropped: specs assert on a layer's paint, filter and visibility. */
function Layer({ id, filter, paint, layout }: LayerProps) {
  useEffect(() => {
    if (!id) return;
    layers.add(id);
    return () => {
      layers.delete(id);
    };
  }, [id]);

  return (
    <div
      data-testid="layer"
      data-id={id}
      data-filter={JSON.stringify(filter ?? null)}
      data-paint={JSON.stringify(paint ?? null)}
      data-visibility={layout?.visibility ?? 'visible'}
    />
  );
}

interface PopupProps {
  children?: ReactNode;
  longitude: number;
  latitude: number;
  onClose?: () => void;
}

function Popup({ children, longitude, latitude, onClose }: PopupProps) {
  return (
    <div data-testid="popup" data-lng={longitude} data-lat={latitude}>
      <button type="button" aria-label="Close popup" onClick={() => onClose?.()} />
      {children}
    </div>
  );
}

type ControlPosition = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';

/** Each corner's controls, top to bottom, as MapLibre stacks them in the DOM. */
const corners: Record<string, string[]> = {};

export function cornerControls(position: ControlPosition): string[] {
  return [...(corners[position] ?? [])];
}

/** Mounted in effect order, like the real `useControl`; MapLibre puts each new bottom control on top. */
function useCornerControl(name: string, position: ControlPosition = 'top-right') {
  useEffect(() => {
    const stack = (corners[position] ??= []);
    if (position.startsWith('bottom')) stack.unshift(name);
    else stack.push(name);
    return () => {
      stack.splice(stack.indexOf(name), 1);
    };
  }, [name, position]);
}

function NavigationControl({ position }: { position?: ControlPosition }) {
  useCornerControl('navigation', position);
  return null;
}

function ScaleControl({ position }: { position?: ControlPosition }) {
  useCornerControl('scale', position);
  return null;
}

/** Stands in for `mapLib` in `useControl` factories; only the controls the app builds itself. */
const fakeMapLib = {
  AttributionControl: class {
    readonly corner = 'attribution';
    _container = document.createElement('details');
    _updateCompact = vi.fn();
    _updateCompactMinimize = vi.fn();
  },
};

function useControl(
  onCreate: (context: { map: typeof fakeMap; mapLib: typeof fakeMapLib }) => { corner?: string },
  opts?: { position?: ControlPosition },
) {
  const [control] = useState(() => onCreate({ map: fakeMap, mapLib: fakeMapLib }));
  useCornerControl(control.corner ?? 'control', opts?.position);
  return control;
}

export function mapLibreStub() {
  return {
    Map,
    Source,
    Layer,
    Marker,
    Popup,
    NavigationControl,
    ScaleControl,
    useMap: () => ({ current: fakeMap }),
    useControl,
  };
}
