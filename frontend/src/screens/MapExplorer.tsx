import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Layer, Map as MapGL, Marker, Popup, Source } from '@vis.gl/react-maplibre';
import type { MapLayerMouseEvent, MapRef } from '@vis.gl/react-maplibre';
import type { GeoJSONSource, MapSourceDataEvent } from 'maplibre-gl';
import type { Feature, FeatureCollection, Point } from 'geojson';
import { useNavigate } from 'react-router';
import { useProjects } from '../api/projects';
import { useDocuments } from '../api/documents';
import type { Project } from '../api/types';
import { trackException } from '../telemetry';
import { readPrefs } from '../shell/prefs';
import { useNarrow } from '../shell/useNarrow';
import {
  BC_CENTER,
  Basemaps,
  DEFAULT_BASEMAP,
  DEFAULT_ZOOM,
  EMPTY_STYLE,
  MapControls,
  ORIENTATION_THRESHOLD,
  ORIENTATION_ZOOM,
  WORKER_URL,
} from '../map/basemaps';
import {
  BOUNDARY_LAYERS,
  CAMERA_FIT,
  CAMERA_FLY,
  CAMERA_PAN,
  SOURCE_TABS,
  boundarySection,
  buildSections,
  coLocated,
  fieldRows,
  filterProjects,
  lassoGeometry,
  pillClass,
  projectMeta,
  resultCountLabel,
  searchProjects,
  sectorOptions,
  sortProjects,
  useMapExplorerState,
  type BoundaryGeometries,
  type FilterKey,
  type SortBy,
  type SourceTab,
} from '../map/map-state';
import {
  LASSO_FILL_LAYER_ID,
  LASSO_LINE_LAYER_ID,
  LassoShape,
  useLassoDraw,
} from '../map/lasso';
import { SaveAreaForm, SavedAreasPanel } from '../map/saved-areas';
import { takePendingLasso } from '../map/pending-lasso';
import { useDeleteLasso, useMyData, useSaveLasso, type SavedLasso } from '../api/me';
import { errorMessage } from '../api/client';
import { useSession } from '../session/session';
import {
  BoundaryOverlay,
  InvasivesRaster,
  LayersPanel,
  NAME_PROPERTY,
  OVERLAY_ROWS,
  WildfireMarkers,
  fillLayerId,
  invasivesMatchLabel,
  lineLayerId,
  wildfirePins,
  type OverlayLayer,
} from '../map/overlays';
import { toFeatureCollection, useBoundaries, type BoundaryRow } from '../api/boundaries';
import {
  INVASIVES_FILTER_DEBOUNCE_MS,
  createInvasiveCounter,
  fetchInvasiveObservation,
  useInvasiveSpecies,
  useRegionalBoundaries,
  useWildfires,
  type InvasiveMatches,
  type InvasiveObservation,
} from '../api/layers';
import { bboxOf, bboxOfPositions, type Geometry, type Position } from '../map/geojson';
import { highlightField } from '../map/highlight';
import { useEscapeLayer } from '../map/use-dismissable';
import '../map/map-explorer.css';

const SOURCE_ID = 'projects';
/** Match the public project map because the cluster art is sized for them. */
const CLUSTER_RADIUS = 60;
const CLUSTER_MAX_ZOOM = 9;
const SEARCH_DEBOUNCE_MS = 300;
/** How long "Copied" stays on the button. */
const COPIED_RESET_MS = 2000;
/** One ring on the pin a selection landed on; matches the arrival pulse in map-explorer.css. */
const MARKER_PULSE_MS = 700;
/** How long the card's exit takes; matches `demi-card-out` in map-explorer.css. */
const CARD_EXIT_MS = 140;
/** How long the card takes to grow or shrink; matches its `max-height` transition in map-explorer.css. */
const CARD_RESIZE_MS = 220;
/** Room left around a cluster's projects when the camera fits them, in pixels. */
const CLUSTER_FIT_PADDING = 80;
/** Six placeholder rows, sized like the real one, so the list does not resize when it lands. */
const SKELETON_ROWS = [1, 2, 3, 4, 5, 6];
/** Same breakpoint as the narrow rules in map-explorer.css: below it the list and the map take turns. */
export const MAP_NARROW_QUERY = '(max-width: 48rem)';

interface MapFeature {
  key: string;
  lng: number;
  lat: number;
  /** null for a single project pin. */
  clusterId: number | null;
  count: number;
  id: string;
}

/** The points a cluster stands for, as camera coordinates. */
function leafPositions(leaves: Feature[]): Position[] {
  return leaves
    .filter((leaf): leaf is Feature<Point> => leaf.geometry?.type === 'Point')
    .map((leaf) => [leaf.geometry.coordinates[0], leaf.geometry.coordinates[1]]);
}

function clusterSize(count: number): string {
  if (count < 10) return 's';
  if (count < 100) return 'm';
  return 'l';
}

export function MapExplorer() {
  const perPage = readPrefs().perPage;
  const mapRef = useRef<MapRef>(null);
  const navigate = useNavigate();

  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [openSections, setOpenSections] = useState<string[]>(['sector']);
  const [basemap, setBasemap] = useState(DEFAULT_BASEMAP);
  const [detailsExpanded, setDetailsExpanded] = useState(false);
  /** After "Less", the fields stay while the card shrinks, so the close runs like the open. */
  const [fieldsClosing, setFieldsClosing] = useState(false);
  const fieldsShown = detailsExpanded || fieldsClosing;
  const [sourceTab, setSourceTab] = useState<SourceTab>('all');
  /** Bumped on every copy, so a second copy restarts the "Copied" timer; 0 shows "Copy id". */
  const [copies, setCopies] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [features, setFeatures] = useState<MapFeature[]>([]);
  /** Holds the control stack, a sibling of the map rather than a child of its clipped canvas. */
  const [controlsHost, setControlsHost] = useState<HTMLDivElement | null>(null);
  const signatureRef = useRef('');

  const narrow = useNarrow(MAP_NARROW_QUERY);
  /** The pane a narrow screen shows. Both show above the breakpoint, whatever this says. */
  const [view, setView] = useState<'list' | 'map'>('map');
  // Chosen during render, before the pane it hides turns inert and drops focus to the page.
  const [wasNarrow, setWasNarrow] = useState(narrow);
  if (wasNarrow !== narrow) {
    setWasNarrow(narrow);
    if (narrow) setView(document.activeElement?.closest('.demi-map-rail') ? 'list' : 'map');
  }
  const listButtonRef = useRef<HTMLButtonElement>(null);
  const cardTitleRef = useRef<HTMLHeadingElement>(null);
  /** The project a narrow list pick hid the row of, so its card takes focus once shown. */
  const focusCardFor = useRef<string | null>(null);

  /** The control each panel was opened from, so Escape hands focus back to it. */
  const openers = useRef<Record<string, HTMLElement | null>>({});
  const rememberOpener = (panel: string): void => {
    openers.current[panel] = document.activeElement as HTMLElement | null;
  };
  const returnFocus = (panel: string): void => {
    openers.current[panel]?.focus();
    openers.current[panel] = null;
  };

  const [wildfiresOn, setWildfiresOn] = useState(false);
  const [invasivesOn, setInvasivesOn] = useState(false);
  /** Read by the count callback, which outlives the render that started the count. */
  const invasivesOnRef = useRef(false);
  const [species, setSpecies] = useState('');
  /** What the tiles and the counts are actually filtered by: the typed value, after its pause. */
  const [appliedSpecies, setAppliedSpecies] = useState('');
  const [matches, setMatches] = useState<InvasiveMatches | null>(null);
  const [observation, setObservation] = useState<
    { lng: number; lat: number; data: InvasiveObservation | null; failed: boolean } | null
  >(null);
  /** Answers for an older click, or for an overlay since switched off, are dropped. */
  const observationSeq = useRef(0);
  const hovered = useRef<{ source: string; id: string } | null>(null);

  const [lassoArmed, setLassoArmed] = useState(false);
  const [savingOpen, setSavingOpen] = useState(false);
  const [savedOpen, setSavedOpen] = useState(false);
  /** Fits the camera to a handed-over area once, whenever the map finishes loading. */
  const fittedPending = useRef(false);

  const state = useMapExplorerState(perPage);
  const { filters, chips, selectedId, setSelectedId, visibleCount, setVisibleCount, activeLayers } =
    state;
  const { lasso, setLasso } = state;

  const { authenticated } = useSession();
  const myData = useMyData();
  const saveLasso = useSaveLasso();
  const deleteLasso = useDeleteLasso();
  const savedAreas = myData.data?.lassos ?? [];
  const savedError = saveLasso.error ?? deleteLasso.error ?? myData.error ?? null;

  // Names for the filter sections whatever is drawn; geometry once the overlay is on, which the
  // tier cache upgrades to without throwing the names away.
  const regionalDistricts = useBoundaries(
    'regionalDistricts',
    activeLayers.includes('regionalDistricts') ? 'simplified' : 'metadata',
  );
  const municipalities = useBoundaries(
    'municipalities',
    activeLayers.includes('municipalities') ? 'simplified' : 'metadata',
  );
  const electoralDistricts = useBoundaries(
    'electoralDistricts',
    activeLayers.includes('electoralDistricts') ? 'simplified' : 'metadata',
  );
  const regions = useRegionalBoundaries(activeLayers.includes('regions'));
  const wildfires = useWildfires(wildfiresOn);
  const fires = useMemo(() => wildfirePins(wildfires.data), [wildfires.data]);
  const speciesList = useInvasiveSpecies(invasivesOn);

  const boundaryRows = useMemo<BoundaryGeometries>(
    () => ({
      regionalDistricts: regionalDistricts.data,
      municipalities: municipalities.data,
      electoralDistricts: electoralDistricts.data,
      // The overlay is also the only polygon source the region section can fall back to.
      region: (regions.data?.features ?? []).map((feature) => ({
        name: String(
          (feature.properties as Record<string, unknown> | null)?.[NAME_PROPERTY.regions] ?? '',
        ),
        geometry: (feature.geometry ?? undefined) as Geometry | undefined,
      })),
    }),
    [regionalDistricts.data, municipalities.data, electoralDistricts.data, regions.data],
  );

  const boundaryCollections = useMemo(
    () =>
      Object.fromEntries(
        BOUNDARY_LAYERS.map((layer) => {
          const rows = boundaryRows[layer];
          // A boundary read that answered with anything but a list still leaves a drawable map.
          return [layer, toFeatureCollection(Array.isArray(rows) ? (rows as BoundaryRow[]) : [])];
        }),
      ),
    [boundaryRows],
  );

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(query), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query]);

  const projects = useProjects(debouncedQuery);
  const rows = projects.data?.projects ?? null;
  const total = projects.data?.matchCount ?? null;
  const loading = projects.isPending;
  /** A re-read behind an answer already on screen: the list dims rather than emptying. */
  const refreshing = projects.isFetching && !projects.isPending;
  // Same words as the project read, so the card's document count is served from cache on a repeat.
  const documents = useDocuments(debouncedQuery);

  // The server already answered these words; `searchProjects` is the client half of the same
  // search, narrowing what a stemming index returned to rows a reader would accept.
  const filtered = useMemo(
    () =>
      rows
        ? searchProjects(filterProjects(rows, filters, boundaryRows, lasso), debouncedQuery)
        : null,
    [rows, filters, boundaryRows, lasso, debouncedQuery],
  );
  const sorted = useMemo(
    () => (filtered ? sortProjects(filtered, state.sortBy) : null),
    [filtered, state.sortBy],
  );

  // A changed result set or sort order starts the list back at one page.
  useEffect(() => setVisibleCount(perPage), [sorted, perPage, setVisibleCount]);

  const paged = (sorted || []).slice(0, visibleCount);
  const canLoadMore = (sorted || []).length > visibleCount;
  const noResults = sorted?.length === 0;
  const { sectionQueries } = state;
  const sections = useMemo(
    () => [
      ...buildSections(rows || [], filters, sectionQueries['sector'] || '', boundaryRows, lasso),
      ...BOUNDARY_LAYERS.map((layer) =>
        boundarySection(layer, boundaryRows[layer], sectionQueries[layer] || '', filters),
      ),
    ],
    [rows, filters, sectionQueries, boundaryRows, lasso],
  );
  const suggestions = useMemo(
    () =>
      sectorOptions(rows || [], filters, boundaryRows, lasso)
        .slice(0, 3)
        .map((option) => option.value),
    [rows, filters, boundaryRows, lasso],
  );

  const byId = useMemo(
    () => new Map((filtered || []).map((project) => [String(project.id), project])),
    [filtered],
  );
  const selected = selectedId === null ? null : (byId.get(String(selectedId)) ?? null);
  // One ring on the pin a new selection landed on, so the eye is told where it went. Started here
  // rather than in a handler because a selection can also arrive from the URL or the lasso.
  const [arrivingId, setArrivingId] = useState<string | null>(null);
  // Previous selection kept in state, not a ref: a ref written during render survives a render
  // React throws away, and that selection would then never pulse.
  const [pulsedFor, setPulsedFor] = useState<string | null>(null);
  const selectionKey = selectedId === null ? null : String(selectedId);
  if (pulsedFor !== selectionKey) {
    setPulsedFor(selectionKey);
    setArrivingId(selectionKey);
  }
  // The project whose card is playing its exit. Held so a close fades out with its content still
  // on screen; a new selection takes over the card instead of replaying the exit.
  const [closing, setClosing] = useState<Project | null>(null);
  if (selected !== null && closing !== null) setClosing(null);
  const shown = selected ?? closing;
  /** Read by the deselect, which needs the project the card was showing. */
  const shownRef = useRef<Project | null>(null);
  useEffect(() => {
    shownRef.current = shown;
  }, [shown]);

  const twins = useMemo(() => coLocated(filtered || [], shown), [filtered, shown]);

  const fc = useMemo<FeatureCollection<Point, { id: string; staged: boolean }>>(
    () => ({
      type: 'FeatureCollection',
      features: (filtered || [])
        .filter((project) => project.centroid)
        .map((project) => ({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [project.centroid![0], project.centroid![1]] },
          properties: { id: String(project.id), staged: project.gatingState === 'staged' },
        })),
    }),
    [filtered],
  );

  const rowElement = (id: string | number): HTMLElement | null =>
    document.getElementById(`demi-row-${id}`);

  /**
   * The one deselect. Four doors reach it: the card's ✕, Escape, a click on the map background,
   * and re-clicking the selected rail row.
   */
  const clearSelection = useCallback(
    (returnFocus = true) => {
      setClosing(shownRef.current);
      setSelectedId((current) => {
        if (returnFocus && current !== null) {
          // A narrow map hides the list, and with it the row; its switch is the way back.
          (narrow && view === 'map' ? listButtonRef.current : rowElement(current))?.focus();
        }
        return null;
      });
      setDetailsExpanded(false);
      setFieldsClosing(false);
    },
    [setSelectedId, narrow, view],
  );

  function selectProject(project: Project) {
    if (selectedId !== null && String(selectedId) === String(project.id)) return clearSelection();
    setSelectedId(project.id);
    if (narrow) {
      setView('map');
      focusCardFor.current = String(project.id);
    }
  }

  useEffect(() => {
    if (focusCardFor.current === null) return;
    // Another selection (a pin, the URL, the lasso) took over before this one resolved.
    if (focusCardFor.current !== selectionKey) {
      focusCardFor.current = null;
      return;
    }
    if (!selected) return;
    focusCardFor.current = null;
    cardTitleRef.current?.focus();
  }, [selected, selectionKey]);

  /* ------------------------------------------------------------------------------- lasso */

  // Consumed during the first render, before the map exists: the workspace hands the area over on
  // the way here, and the map may still be loading when it arrives.
  const [pending] = useState(takePendingLasso);
  useEffect(() => {
    if (pending) setLasso({ ring: pending.ring, label: pending.label });
  }, [pending, setLasso]);

  useEffect(() => {
    const map = mapRef.current;
    if (!pending || !loaded || !map || fittedPending.current) return;
    fittedPending.current = true;
    const box = bboxOf(lassoGeometry(pending.ring));
    if (!box) return;
    map.fitBounds(
      [
        [box[0], box[1]],
        [box[2], box[3]],
      ],
      { padding: 30, ...CAMERA_FIT },
    );
  }, [pending, loaded]);

  const startStroke = useCallback(() => setLasso(null), [setLasso]);
  const commitStroke = useCallback((ring: number[][]) => setLasso({ ring, label: null }), [setLasso]);
  const stroke = useLassoDraw(mapRef, lassoArmed, loaded, startStroke, commitStroke);

  /** Putting the tool away keeps what was drawn; only Escape and the chip take the area off. */
  const escapeLasso = useCallback(() => {
    setLassoArmed(false);
    setLasso(null);
  }, [setLasso]);

  // Each panel hands focus back to the control it was opened from, not to the document.
  useEscapeLayer(savingOpen, () => {
    setSavingOpen(false);
    returnFocus('saving');
  });
  useEscapeLayer(filtersOpen, () => {
    setFiltersOpen(false);
    returnFocus('filters');
  });

  /**
   * Escape order: an open panel first, then an armed drawing tool, then the selection. Panels take
   * the key from the capture phase (`useEscapeLayer`), so an open one closes before this runs.
   */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (lassoArmed) return escapeLasso();
      if (selectedId !== null) clearSelection();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [lassoArmed, escapeLasso, selectedId, clearSelection]);

  /** Read on open rather than on arrival: most visits never touch this menu. */
  function toggleSaved(): void {
    const open = !savedOpen;
    setSavedOpen(open);
    if (open) void myData.refetch();
  }
  const closeSaved = useCallback(() => setSavedOpen(false), []);

  async function saveArea(name: string): Promise<void> {
    if (!lasso || saveLasso.isPending) return;
    try {
      await saveLasso.mutateAsync({ name, ring: lasso.ring });
    } catch {
      // A refusal reaches the reader through the error line below; the drawn area stays put.
      return;
    }
    setLasso({ ring: lasso.ring, label: name });
    setSavingOpen(false);
  }

  function applySavedArea(area: SavedLasso): void {
    setLasso({ ring: area.ring, label: area.name });
    setSavedOpen(false);
  }

  // Started here rather than in the copy handler, which resumes after its await and may do so after
  // the screen has gone: a timer started from an effect is always cleared with it.
  useEffect(() => {
    if (copies === 0) return;
    const timer = setTimeout(() => setCopies(0), COPIED_RESET_MS);
    return () => clearTimeout(timer);
  }, [copies]);

  // Read back what the clustering worker produced, once per painted frame so clusters split and
  // merge during a camera move rather than swapping all at once when it ends. maplibre paces
  // `render`, and the signature check below makes a frame that changed nothing free.
  const refreshFeatures = useCallback(() => {
    const map = mapRef.current;
    // `isSourceLoaded` throws for a source the style has not got yet (the first frames render before
    // React adds it), and a source still clustering answers with a partial set: wait for both.
    if (!map || !map.getSource(SOURCE_ID) || !map.isSourceLoaded(SOURCE_ID)) return;

    const seen = new Set<string>();
    const next: MapFeature[] = [];
    for (const feature of map.querySourceFeatures(SOURCE_ID)) {
      if (feature.geometry.type !== 'Point') continue;
      const properties = feature.properties;
      const clusterId = properties['cluster'] ? (properties['cluster_id'] as number) : null;
      const id = clusterId === null ? String(properties['id']) : '';
      const key = clusterId === null ? `p${id}` : `c${clusterId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const [lng, lat] = feature.geometry.coordinates;
      next.push({
        key,
        lng,
        lat,
        clusterId,
        count: clusterId === null ? 1 : (properties['point_count'] as number),
        id,
      });
    }

    // Sorted, so the same set answered in a different tile order is still the same frame.
    const signature = next
      .map((item) => `${item.key}@${item.lng.toFixed(4)},${item.lat.toFixed(4)}x${item.count}`)
      .sort()
      .join('|');
    if (signature === signatureRef.current) return;
    signatureRef.current = signature;
    setFeatures(next);
  }, []);

  /** Only the project source re-clusters; every other source data event is someone else's tiles. */
  const onSourceData = useCallback(
    (event: MapSourceDataEvent) => {
      if (event.sourceId === SOURCE_ID) refreshFeatures();
    },
    [refreshFeatures],
  );

  // The first set, and every set that a React-side data change produces.
  useEffect(() => {
    if (loaded) refreshFeatures();
  }, [loaded, fc, refreshFeatures]);

  /* ---------------------------------------------------------------------------- overlays */

  /** Names ticked in one overlay. Environmental regions are filtered by the region section. */
  const pickedNames = useCallback(
    (layer: OverlayLayer): string[] => (layer === 'regions' ? filters.region : filters[layer]),
    [filters],
  );

  const boundaryFillIds = useMemo(
    () =>
      OVERLAY_ROWS.filter((row) => activeLayers.includes(row.id)).map((row) =>
        fillLayerId(row.id as OverlayLayer),
      ),
    [activeLayers],
  );

  // The picked shapes, as feature state, so one paint expression draws every look a shape has.
  useEffect(() => {
    const map = mapRef.current;
    if (!loaded || !map) return;
    for (const row of OVERLAY_ROWS) {
      const layer = row.id as OverlayLayer;
      if (!activeLayers.includes(layer) || !map.getSource(layer)) continue;
      map.removeFeatureState({ source: layer });
      for (const name of pickedNames(layer)) {
        map.setFeatureState({ source: layer, id: name }, { selected: true });
      }
      // The wipe above takes hover with it, so the shape under the pointer gets it back.
      if (hovered.current?.source === layer) {
        map.setFeatureState(hovered.current, { hover: true });
      }
    }
  }, [loaded, activeLayers, pickedNames, regions.data, boundaryCollections]);

  /** A hover on a layer that has just been switched off has no source left to clear it from. */
  useEffect(() => {
    const layer = hovered.current?.source;
    if (layer && !activeLayers.includes(layer)) hovered.current = null;
  }, [activeLayers]);

  // Style order: basemap, invasives raster, boundaries, lasso and pins on top. An overlay switched
  // on last is added on top of the style, so the boundaries are lifted back over the raster here,
  // and put under the drawn area when there is one.
  useEffect(() => {
    const map = mapRef.current;
    if (!loaded || !map) return;
    const beforeId = [LASSO_FILL_LAYER_ID, LASSO_LINE_LAYER_ID].find((id) => map.getLayer(id));
    for (const row of OVERLAY_ROWS) {
      const layer = row.id as OverlayLayer;
      for (const id of [fillLayerId(layer), lineLayerId(layer)]) {
        if (map.getLayer(id)) map.moveLayer(id, beforeId);
      }
    }
  }, [loaded, activeLayers, invasivesOn, stroke, lasso]);

  // The typed species reaches the tiles and the counts after a pause, as one request rather than
  // one per keystroke.
  useEffect(() => {
    const timer = setTimeout(() => setAppliedSpecies(species), INVASIVES_FILTER_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [species]);

  const counter = useRef<ReturnType<typeof createInvasiveCounter> | null>(null);
  useEffect(() => {
    if (!invasivesOn) return;
    if (counter.current == null) {
      // A count that lands after the overlay is switched off must not put a label back on it.
      counter.current = createInvasiveCounter((next) => {
        if (invasivesOnRef.current) setMatches(next);
      });
    }
    void counter.current.count(appliedSpecies);
  }, [appliedSpecies, invasivesOn]);

  /** Nothing of the overlay survives it being switched off, including an answer still in flight. */
  function toggleInvasives(): void {
    const next = !invasivesOn;
    invasivesOnRef.current = next;
    setInvasivesOn(next);
    if (next) return;
    observationSeq.current += 1;
    setObservation(null);
    setMatches(null);
  }

  /** Ask the WMS what sits under the clicked pixel. */
  const askObservation = useCallback(
    async (point: { x: number; y: number }, lngLat: { lng: number; lat: number }) => {
      const map = mapRef.current;
      if (!map) return;
      const container = map.getContainer();
      const box = map.getBounds();
      const sequence = ++observationSeq.current;

      const view = {
        bounds: {
          west: box.getWest(),
          south: box.getSouth(),
          east: box.getEast(),
          north: box.getNorth(),
        },
        size: { width: container.clientWidth, height: container.clientHeight },
        pixel: { x: point.x, y: point.y },
      };

      try {
        const data = await fetchInvasiveObservation(view, appliedSpecies);
        if (sequence !== observationSeq.current) return;
        setObservation({ lng: lngLat.lng, lat: lngLat.lat, data, failed: false });
      } catch (error) {
        // A failed read must not read as a click that did nothing.
        if (sequence !== observationSeq.current) return;
        setObservation({ lng: lngLat.lng, lat: lngLat.lat, data: null, failed: true });
        trackException(error, { area: 'MapExplorer', action: 'invasivesGetFeatureInfo' });
      }
    },
    [appliedSpecies],
  );

  /** Ticking a boundary from the map: same toggle the drawer uses, then the camera follows. */
  const selectBoundary = useCallback(
    (layer: OverlayLayer, name: string): void => {
      if (!name) return;
      const section: FilterKey = layer === 'regions' ? 'region' : layer;
      const willSelect = !pickedNames(layer).includes(name);
      state.toggleValue(section, name);
      if (!willSelect) return;

      const map = mapRef.current;
      const features: { properties: object; geometry: Geometry | null }[] =
        layer === 'regions' ? (regions.data?.features ?? []) : (boundaryCollections[layer]?.features ?? []);
      const match = features.find(
        (feature) =>
          String((feature.properties as Record<string, unknown>)[NAME_PROPERTY[layer]] ?? '') ===
          name,
      );
      const box = bboxOf(match?.geometry);
      if (!map || !box) return;
      map.fitBounds(
        [
          [box[0], box[1]],
          [box[2], box[3]],
        ],
        { padding: 30, maxZoom: 9, ...CAMERA_FIT },
      );
    },
    [pickedNames, state, regions.data, boundaryCollections],
  );

  const setHover = useCallback((next: { source: string; id: string } | null) => {
    const map = mapRef.current;
    if (!map) return;
    if (hovered.current) map.setFeatureState(hovered.current, { hover: false });
    hovered.current = next;
    if (next) map.setFeatureState(next, { hover: true });
  }, []);

  /**
   * Always centres the selection, whichever door it came through — a rail row, a pin, the URL.
   * Only from a province-wide view is a fly-in worth it; any nearer and easing keeps the context.
   */
  useEffect(() => {
    const map = mapRef.current;
    if (!loaded || !map || !selected?.centroid) return;
    const center: [number, number] = [selected.centroid[0], selected.centroid[1]];
    if (map.getZoom() < ORIENTATION_THRESHOLD) {
      map.flyTo({ center, zoom: ORIENTATION_ZOOM, ...CAMERA_FLY });
    } else {
      map.easeTo({ center, ...CAMERA_PAN });
    }
    rowElement(selected.id)?.scrollIntoView({ block: 'nearest' });
  }, [selected, loaded]);

  /** Backstop for the fields' close: `transitionend` never arrives when the max height does not change. */
  useEffect(() => {
    if (!fieldsClosing) return;
    const timer = window.setTimeout(() => setFieldsClosing(false), CARD_RESIZE_MS);
    return () => window.clearTimeout(timer);
  }, [fieldsClosing]);

  /** Backstop for the card's exit: `animationend` never arrives where the animation never runs. */
  useEffect(() => {
    if (closing === null) return;
    const timer = window.setTimeout(() => setClosing(null), CARD_EXIT_MS);
    return () => window.clearTimeout(timer);
  }, [closing]);

  /** Drops the class once the ring has run. */
  useEffect(() => {
    if (arrivingId === null) return;
    const timer = window.setTimeout(() => setArrivingId(null), MARKER_PULSE_MS);
    return () => window.clearTimeout(timer);
  }, [arrivingId]);

  /** Opens a bubble onto everything it stands for, the way the Leaflet cluster plugin did. */
  async function expandCluster(feature: MapFeature): Promise<void> {
    const map = mapRef.current;
    if (!map || feature.clusterId === null) return;
    const source = map.getSource(SOURCE_ID) as GeoJSONSource | undefined;
    if (!source) return;
    try {
      const leaves = await source.getClusterLeaves(feature.clusterId, Infinity, 0);
      const box = bboxOfPositions(leafPositions(leaves));
      if (box && (box[0] !== box[2] || box[1] !== box[3])) {
        map.fitBounds(
          [
            [box[0], box[1]],
            [box[2], box[3]],
          ],
          { padding: CLUSTER_FIT_PADDING, maxZoom: CLUSTER_MAX_ZOOM + 2, ...CAMERA_FIT },
        );
        return;
      }
      // Projects stacked on one coordinate have no box to fit, so step down a zoom instead.
      const zoom = await source.getClusterExpansionZoom(feature.clusterId);
      map.easeTo({ center: [feature.lng, feature.lat], zoom, ...CAMERA_PAN });
    } catch (error) {
      trackException(error, { area: 'MapExplorer', action: 'expandCluster' });
    }
  }

  function selectPin(feature: MapFeature): void {
    const project = byId.get(feature.id);
    if (!project) return;
    setSelectedId(project.id);
  }

  const summary = `${resultCountLabel(sorted?.length, total)} projects`;
  const rowsForTab = useMemo(() => fieldRows(shown, sourceTab), [shown, sourceTab]);

  /** The selection is dimmed against, so nothing is dimmed while its own pin is inside a cluster. */
  const selectionOnMap =
    selected !== null && features.some((f) => f.clusterId === null && f.id === String(selected.id));

  // Through `String`: a document's `projectId` arrives as text where the project's id is a number.
  const docCount = (projectId: string | number): number =>
    (documents.data || []).filter((doc) => String(doc.projectId) === String(projectId)).length;

  /** Documents are listed on Search, which is where the project name goes as its keywords. */
  function openDocuments(project: Project): void {
    navigate(`/search?keywords=${encodeURIComponent(project.name)}`);
  }

  async function copyProjectId(): Promise<void> {
    if (!shown) return;
    try {
      await navigator.clipboard.writeText(String(shown.id));
      setCopies((count) => count + 1);
    } catch {
      // Clipboard refused (no permission, or an insecure context). The id is still on screen.
    }
  }

  return (
    <div className="demi-map-screen" data-view={narrow ? view : undefined}>
      <h1 className="visually-hidden">Map Explorer</h1>

      {narrow && (
        <div className="demi-map-views">
          <div className="demi-map-views__switch" role="group" aria-label="Show projects as">
            <button
              type="button"
              ref={listButtonRef}
              aria-pressed={view === 'list'}
              onClick={() => setView('list')}
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                aria-hidden="true"
              >
                <line x1="9" y1="6" x2="20" y2="6" />
                <line x1="9" y1="12" x2="20" y2="12" />
                <line x1="9" y1="18" x2="20" y2="18" />
                <circle cx="4.5" cy="6" r="1" />
                <circle cx="4.5" cy="12" r="1" />
                <circle cx="4.5" cy="18" r="1" />
              </svg>
              List{' '}
              {sorted && (
                <>
                  <span className="pill pill--info">{sorted.length}</span>{' '}
                  <span className="visually-hidden">projects</span>
                </>
              )}
            </button>
            <button type="button" aria-pressed={view === 'map'} onClick={() => setView('map')}>
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                aria-hidden="true"
              >
                <polygon points="3,6 9,3 15,6 21,3 21,18 15,21 9,18 3,21" />
                <line x1="9" y1="3" x2="9" y2="18" />
                <line x1="15" y1="6" x2="15" y2="21" />
              </svg>
              Map
            </button>
          </div>
        </div>
      )}

      <div className="demi-map-rail" inert={narrow && view === 'map'}>
        <div className="demi-map-rail__search">
          <div className="demi-map-rail__box">
            <svg
              className="demi-map-rail__magnifier"
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              aria-hidden="true"
            >
              <circle cx="11" cy="11" r="7" />
              <line x1="16.5" y1="16.5" x2="21" y2="21" />
            </svg>
            <input
              id="demi-search-map"
              type="text"
              placeholder="Search projects"
              aria-label="Search projects"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            {query && (
              <button type="button" aria-label="Clear search" onClick={() => setQuery('')}>
                ✕
              </button>
            )}
          </div>

          <div className="demi-map-rail__filterbar">
            <button
              type="button"
              aria-expanded={filtersOpen}
              onClick={() => {
                if (!filtersOpen) rememberOpener('filters');
                setFiltersOpen(!filtersOpen);
              }}
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                aria-hidden="true"
              >
                <line x1="4" y1="7" x2="20" y2="7" />
                <line x1="7" y1="12" x2="17" y2="12" />
                <line x1="10" y1="17" x2="14" y2="17" />
              </svg>
              Filters
              {chips.length > 0 && <span className="pill pill--info">{chips.length}</span>}
            </button>
            {chips.length > 0 && (
              <button type="button" onClick={state.clearFilters}>
                Clear all
              </button>
            )}
          </div>

          {chips.length > 0 && (
            <div className="demi-map-rail__chips">
              {chips.map((chip) => (
                <button
                  key={chip.id}
                  type="button"
                  aria-label="Remove filter"
                  onClick={() => state.clearFilter(chip.id)}
                >
                  <span>{chip.label}</span> ✕
                </button>
              ))}
            </div>
          )}

          {lasso && authenticated && (
            <div className="demi-lasso-save__slot">
              <SaveAreaForm
                open={savingOpen}
                onOpen={() => {
                  rememberOpener('saving');
                  setSavingOpen(true);
                }}
                onCancel={() => setSavingOpen(false)}
                saving={saveLasso.isPending}
                onSave={(name) => void saveArea(name)}
              />
              {savedError && (
                <div className="cell__sub demi-lasso-save__error">{errorMessage(savedError)}</div>
              )}
            </div>
          )}
        </div>

        {filtersOpen && (
          <div className="demi-map-filters">
            <div className="demi-map-filters__head">
              <h2 className="panel__title panel__title--inline">Filters</h2>
              <button type="button" aria-label="Close filters" onClick={() => setFiltersOpen(false)}>
                ✕
              </button>
            </div>

            <div className="demi-map-filters__body">
              {sections.map((section) => {
                const open = openSections.includes(section.id);
                return (
                  <div key={section.id}>
                    <button
                      type="button"
                      aria-expanded={open}
                      onClick={() =>
                        setOpenSections((current) =>
                          current.includes(section.id)
                            ? current.filter((id) => id !== section.id)
                            : [...current, section.id],
                        )
                      }
                    >
                      <span className="cell__title">{section.label}</span>
                      <span className="cell__sub">{open ? '▾' : '▸'}</span>
                    </button>

                    {open && (
                      <div>
                        {section.searchable && (
                          <input
                            type="text"
                            placeholder="Type to narrow"
                            aria-label="Narrow options"
                            value={section.searchValue}
                            onChange={(event) => state.setSectionQuery(section.id, event.target.value)}
                          />
                        )}
                        {section.options.map((option) => (
                          <label key={option.value}>
                            <input
                              type="checkbox"
                              checked={option.checked}
                              onChange={() =>
                                state.toggleValue(section.id as FilterKey, option.value)
                              }
                            />
                            <span>{option.label}</span>
                          </label>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            <div className="demi-map-filters__foot">
              <button type="button" onClick={state.clearFilters}>
                Clear all
              </button>
              <button type="button" onClick={() => setFiltersOpen(false)}>
                Show {sorted?.length ?? 0}
              </button>
            </div>
          </div>
        )}

        <div className="demi-map-rail__summary">
          <span className="cell__title">{summary}</span>
          <label>
            Sort
            <select
              aria-label="Sort results"
              value={state.sortBy}
              onChange={(event) => state.setSortBy(event.target.value as SortBy)}
            >
              <option value="relevance">Relevance</option>
              <option value="name">Name A–Z</option>
            </select>
          </label>
        </div>

        <div
          className={`demi-map-rail__list${refreshing ? ' demi-map-rail__list--refreshing' : ''}`}
          aria-busy={loading ? 'true' : undefined}
        >
          {loading && (
            <>
              <p className="visually-hidden">Loading projects…</p>
              {SKELETON_ROWS.map((row) => (
                <div key={row} className="demi-row demi-row--skeleton" aria-hidden="true">
                  <span>
                    <span className="cell__title">
                      <span className="skeleton skeleton--text" style={{ width: '70%' }} />
                    </span>
                    <span className="pill">
                      <span className="skeleton skeleton--text" style={{ width: '4.5rem' }} />
                    </span>
                  </span>
                  <span className="cell__sub">
                    <span className="skeleton skeleton--text" style={{ width: '55%' }} />
                  </span>
                  <span className="cell__sub">
                    <span className="skeleton skeleton--text" style={{ width: '40%' }} />
                  </span>
                </div>
              ))}
            </>
          )}

          <div role="listbox" aria-label="Projects">
            {paged.map((project) => (
              <button
                key={project.id}
                type="button"
                role="option"
                id={`demi-row-${project.id}`}
                aria-selected={selectedId !== null && String(selectedId) === String(project.id)}
                className={`demi-row${
                  selectedId !== null && String(selectedId) === String(project.id)
                    ? ' kv-row--selected'
                    : ''
                }`}
                onClick={() => selectProject(project)}
              >
                <span>
                  <span className="cell__title">
                    {highlightField(project.highlighted?.name, project.name, debouncedQuery)}
                  </span>
                  <span className={`pill pill--caps ${pillClass(project.gatingState)}`}>
                    {project.gatingState}
                  </span>
                </span>
                <span className="cell__sub">{projectMeta(project)}</span>
                <span className="cell__sub">{project.proponent}</span>
              </button>
            ))}
          </div>

          {/* The shell bar carries a failed corpus read. Only the searched read, which the shell
              never makes, would otherwise fail in silence. */}
          {projects.isError && debouncedQuery && (
            <div className="demi-map-rail__empty" role="alert">
              <div className="cell__title">{errorMessage(projects.error)}</div>
            </div>
          )}

          {noResults && (
            <div className="demi-map-rail__empty">
              {/* The live query, not the debounced one: the message must quote what is in the box. */}
              <div className="cell__title">No projects match “{query}”</div>
              <div className="cell__sub">Try fewer words, or one of these:</div>
              <div>
                {suggestions.map((suggestion) => (
                  <button key={suggestion} type="button" onClick={() => setQuery(suggestion)}>
                    {suggestion}
                  </button>
                ))}
              </div>
            </div>
          )}

          {canLoadMore && (
            <div className="demi-map-rail__more">
              <button type="button" onClick={() => setVisibleCount(visibleCount + perPage)}>
                Load {perPage} more
              </button>
            </div>
          )}
        </div>
      </div>

      <div className="demi-map-canvas" inert={narrow && view === 'list'}>
        <div
          id="demi-map"
          className={`demi-map${selectionOnMap ? ' demi-map--selection' : ''}`}
          role="region"
          aria-label="Map of B.C. showing environmental assessment projects"
        >
          <MapGL
            ref={mapRef}
            initialViewState={{ longitude: BC_CENTER[0], latitude: BC_CENTER[1], zoom: DEFAULT_ZOOM }}
            mapStyle={EMPTY_STYLE}
            workerUrl={WORKER_URL}
            attributionControl={false}
            style={{ width: '100%', height: '100%' }}
            onLoad={() => setLoaded(true)}
            onRender={refreshFeatures}
            onIdle={refreshFeatures}
            onSourceData={onSourceData}
            interactiveLayerIds={boundaryFillIds}
            onMouseMove={(event: MapLayerMouseEvent) => {
              const feature = event.features?.[0];
              const layer = String(feature?.layer?.id ?? '').replace(/-fill$/, '');
              const name = feature?.id;
              setHover(layer && name != null ? { source: layer, id: String(name) } : null);
            }}
            onMouseLeave={() => setHover(null)}
            onClick={(event: MapLayerMouseEvent) => {
              // Marker buttons live inside the canvas container, so their clicks reach the map too.
              if ((event.originalEvent?.target as Element)?.closest?.('.maplibregl-marker')) return;

              // A click that lands on a boundary picks it and nothing else, the way clicking a
              // Leaflet polygon never reached the map underneath.
              const feature = event.features?.[0];
              if (feature?.layer?.id?.endsWith('-fill')) {
                selectBoundary(
                  feature.layer.id.replace(/-fill$/, '') as OverlayLayer,
                  String(feature.id ?? ''),
                );
                return;
              }

              // A stroke ends in a map click; that must not clear the selection.
              if (lassoArmed) return;

              clearSelection(false);
              // Nothing is asked of the WMS while its overlay is off.
              if (invasivesOn) void askObservation(event.point, event.lngLat);
            }}
          >
            <Basemaps basemap={basemap} />

            {invasivesOn && <InvasivesRaster species={appliedSpecies} />}

            {activeLayers.includes('regions') && regions.data && (
              <BoundaryOverlay
                layer="regions"
                data={regions.data}
                hasSelection={filters.region.length > 0}
              />
            )}
            {BOUNDARY_LAYERS.filter((layer) => activeLayers.includes(layer)).map((layer) => (
              <BoundaryOverlay
                key={layer}
                layer={layer}
                data={boundaryCollections[layer]}
                hasSelection={filters[layer].length > 0}
              />
            ))}

            {wildfiresOn && <WildfireMarkers fires={fires} />}

            {observation && (
              <Popup
                longitude={observation.lng}
                latitude={observation.lat}
                anchor="bottom"
                closeOnClick={false}
                onClose={() => setObservation(null)}
                maxWidth="260px"
              >
                <div className="demi-observation-card" data-testid="invasives-popup">
                  {observation.failed ? (
                    <p>Could not load observation details.</p>
                  ) : !observation.data ? (
                    <p>No observation here.</p>
                  ) : (
                    <>
                      <h4>{observation.data.name}</h4>
                      {observation.data.scientific && <p><em>{observation.data.scientific}</em></p>}
                      {observation.data.observed && (
                        <p>
                          <strong>Observed: </strong>
                          {observation.data.observed}
                        </p>
                      )}
                      {observation.data.presence && (
                        <p>
                          <strong>Presence: </strong>
                          {observation.data.presence}
                        </p>
                      )}
                    </>
                  )}
                </div>
              </Popup>
            )}

            {/* Portalled, not nested: the stack has to sit beside the map, whose container clips
                its overflow, but the MapLibre controls in it still need the map from context. */}
            {controlsHost &&
              createPortal(
                <MapControls basemap={basemap} onBasemapChange={setBasemap}>
                  <LayersPanel
                    activeLayers={activeLayers}
                    onToggleLayer={state.toggleLayer}
                    wildfires={wildfiresOn}
                    onToggleWildfires={() => setWildfiresOn((on) => !on)}
                    invasives={invasivesOn}
                    onToggleInvasives={toggleInvasives}
                    species={species}
                    onSpeciesChange={setSpecies}
                    speciesList={speciesList.data || []}
                    matchLabel={invasivesMatchLabel(species, matches)}
                  />

                  <button
                    type="button"
                    className={`map-control-btn${lassoArmed ? ' map-control-btn--on' : ''}`}
                    aria-pressed={lassoArmed}
                    title="Hold and drag on the map to draw an area. Escape clears it."
                    onClick={() => setLassoArmed((armed) => !armed)}
                  >
                    <svg
                      width="14"
                      height="14"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      aria-hidden="true"
                    >
                      <ellipse cx="12" cy="9" rx="8" ry="5" />
                      <path d="M12 14v4" />
                      <path d="M12 22a2 2 0 1 0 0-4 2 2 0 0 0 0 4z" />
                    </svg>
                    Lasso
                  </button>

                  {authenticated && (
                    <SavedAreasPanel
                      open={savedOpen}
                      onToggle={toggleSaved}
                      onClose={closeSaved}
                      areas={savedAreas}
                      loading={myData.isFetching}
                      onApply={applySavedArea}
                      onDelete={(area) => deleteLasso.mutate(area.slug)}
                    />
                  )}
                </MapControls>,
                controlsHost,
              )}

            {(stroke || lasso) && (
              <LassoShape ring={stroke ?? lasso!.ring} preview={stroke !== null} />
            )}

            <Source
              id={SOURCE_ID}
              type="geojson"
              data={fc}
              cluster
              clusterRadius={CLUSTER_RADIUS}
              clusterMaxZoom={CLUSTER_MAX_ZOOM}
            >
              {/* Nothing renders this layer, but a source with no layer is never tiled and so has
                  no features to query. */}
              <Layer
                id="projects-hit"
                type="circle"
                paint={{ 'circle-opacity': 0, 'circle-radius': 1 }}
              />
            </Source>

            {/* Source order, never re-sorted: moving a marker's node re-inserts it, which replays
                its enter animation. The selected pin rises on z-index instead. */}
            {features.map((feature) => {
              const isSelected = selected !== null && String(selected.id) === feature.id;
              const project = feature.clusterId === null ? byId.get(feature.id) : undefined;
              return feature.clusterId === null ? (
                <Marker
                  key={feature.key}
                  longitude={feature.lng}
                  latitude={feature.lat}
                  anchor="bottom"
                  style={{ zIndex: isSelected ? 650 : 600 }}
                >
                  <button
                    type="button"
                    className={`demi-marker${
                      project?.gatingState === 'staged' ? ' demi-marker--staged' : ''
                    }${isSelected ? ' demi-marker--selected' : ''}${
                      isSelected && arrivingId === feature.id ? ' demi-marker--arriving' : ''
                    }`}
                    data-testid="map-marker"
                    data-project-id={feature.id}
                    tabIndex={-1}
                    aria-hidden="true"
                    onClick={() => (isSelected ? clearSelection(false) : selectPin(feature))}
                  >
                    {/* Named on hover, the way the public project map names its pins. The rail row
                        is what a screen reader reads; this span is decoration over the art. */}
                    <span className="demi-marker__label">{project?.name}</span>
                  </button>
                </Marker>
              ) : (
                <Marker
                  key={feature.key}
                  longitude={feature.lng}
                  latitude={feature.lat}
                  anchor="center"
                  style={{ zIndex: 600 }}
                >
                  <button
                    type="button"
                    className="demi-cluster"
                    data-testid="map-cluster"
                    data-size={clusterSize(feature.count)}
                    tabIndex={-1}
                    aria-hidden="true"
                    onClick={() => void expandCluster(feature)}
                  >
                    {feature.count}
                  </button>
                </Marker>
              );
            })}
          </MapGL>
        </div>

        <div ref={setControlsHost} />

        {shown && (
          <div
            className={`demi-map-card${selected ? '' : ' demi-map-card--closing'}`}
            role="region"
            aria-labelledby="demi-selected-title"
            data-expanded={detailsExpanded ? 'true' : fieldsClosing ? 'closing' : 'false'}
            onAnimationEnd={(event) => {
              if (event.target === event.currentTarget) setClosing(null);
            }}
            onTransitionEnd={(event) => {
              if (event.target === event.currentTarget && event.propertyName === 'max-height') {
                setFieldsClosing(false);
              }
            }}
          >
            <div className="demi-map-card__head">
              <h2
                id="demi-selected-title"
                ref={cardTitleRef}
                tabIndex={-1}
                className="panel__title panel__title--inline"
              >
                {shown.name}
              </h2>
              <span className={`pill pill--caps ${pillClass(shown.gatingState)}`}>
                {shown.gatingState}
              </span>
              <button type="button" aria-label="Clear selection" onClick={() => clearSelection()}>
                ✕
              </button>
            </div>
            <div className="cell__sub">{projectMeta(shown)}</div>

            <div className="demi-map-card__body">
              <div className="cell__sub">{shown.description}</div>

              {!fieldsShown ? (
                <div className="demi-map-card__facts">
                  <div>
                    <div className="micro-label">Sector</div>
                    <div className="cell__title">{shown.sector || '—'}</div>
                  </div>
                  <div>
                    <div className="micro-label">Status</div>
                    <div className="cell__title">{shown.status || '—'}</div>
                  </div>
                  <div>
                    <div className="micro-label">Track id</div>
                    <div className="cell__title">
                      <code className="cell__mono">{shown.trackProjectId || shown.id}</code>
                    </div>
                  </div>
                  {/* Absent on most projects, so no em-dash placeholder, and not monospaced: Track
                      puts certificate state in this column too, not only numbers like "E98-05". */}
                  {shown.eaCertificate && (
                    <div>
                      <div className="micro-label">EA Certificate</div>
                      <div className="cell__title">{shown.eaCertificate}</div>
                    </div>
                  )}
                </div>
              ) : (
                // Inert while it closes: on screen for the shrink, out of reach already.
                <div inert={fieldsClosing}>
                  <div className="demi-map-card__tabs" role="group" aria-label="Field source">
                    {SOURCE_TABS.map((tab) => (
                      <button
                        key={tab.id}
                        type="button"
                        aria-pressed={sourceTab === tab.id}
                        onClick={() => setSourceTab(tab.id)}
                      >
                        {tab.label}
                      </button>
                    ))}
                  </div>

                  <div className="kv-grid demi-map-card__fields">
                    {rowsForTab.map((row) => (
                      <div
                        key={`${row.source}${row.key}`}
                        className={`kv-row${row.long ? ' kv-row--stacked' : ''}`}
                      >
                        <span className="kv-row__key">
                          <span>{row.key}</span>
                          <span className="pill pill--neutral pill--caps">{row.source}</span>
                        </span>
                        <span className="kv-row__value">{row.value}</span>
                      </div>
                    ))}
                  </div>

                  <p className="footnote">
                    Track is the master registry. EPIC rows are the legacy Eagle values DEMI keeps
                    so old links resolve; DEMI rows are derived here.
                  </p>
                </div>
              )}

              {/* MapLibre clustering has no spiderfy, so a shared centroid is unpickable on the
                  map. The card names the neighbours instead. */}
              {twins.length > 0 && (
                <div className="demi-map-card__twins">
                  <div className="micro-label">Also at this location</div>
                  <ul>
                    {twins.map((twin) => (
                      <li key={twin.id}>
                        <button type="button" onClick={() => setSelectedId(twin.id)}>
                          {twin.name}
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>

            <div className="demi-map-card__foot">
              <button
                type="button"
                className="demi-map-card__documents"
                onClick={() => openDocuments(shown)}
              >
                Documents ({docCount(shown.id)})
              </button>
              <button type="button" className="demi-map-card__copy" onClick={copyProjectId}>
                {copies > 0 ? 'Copied' : 'Copy id'}
              </button>
              <button
                type="button"
                className="demi-map-card__toggle"
                aria-expanded={detailsExpanded}
                onClick={() => {
                  setFieldsClosing(detailsExpanded);
                  setDetailsExpanded(!detailsExpanded);
                }}
              >
                {detailsExpanded ? 'Less' : 'All fields'}
                {/* The fields open upward, as the card grows up from the map's foot: up to open, down to shut. */}
                <span
                  data-testid="card-fields-chevron"
                  style={{ display: 'inline-flex', transform: detailsExpanded ? 'none' : 'rotate(180deg)' }}
                >
                  <svg
                    width="12"
                    height="12"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.5"
                    aria-hidden="true"
                  >
                    <polyline points="6,9 12,15 18,9" />
                  </svg>
                </span>
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
