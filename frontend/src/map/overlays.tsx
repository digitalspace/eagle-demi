/* eslint-disable react-refresh/only-export-components -- one overlay module: the layers the map
   draws and the paint they are drawn with are the same unit of change. */
import { useCallback, useRef, useState } from 'react';
import { Layer, Marker, Popup, Source } from '@vis.gl/react-maplibre';
import type {
  ExpressionSpecification,
  FillLayerSpecification,
  LineLayerSpecification,
} from 'maplibre-gl';
import type { FeatureCollection as GeoJsonCollection } from 'geojson';
import type { BoundaryLayer, BoundaryProperties } from '../api/boundaries';
import {
  INVASIVES_RASTER_OPACITY,
  invasivesTileUrl,
  wildfireCard,
  wildfireCoordinates,
  type WildfireCard,
} from '../api/layers';
import type { FeatureCollection } from './geojson';
import { useDismissable } from './use-dismissable';

/** The overlay rows of the Layers panel, labels as the Angular template had them. */
export const OVERLAY_ROWS: { id: string; label: string }[] = [
  { id: 'regions', label: 'Environmental regions' },
  { id: 'regionalDistricts', label: 'Regional districts' },
  { id: 'municipalities', label: 'Municipalities' },
  { id: 'electoralDistricts', label: 'Electoral districts' },
];

export type OverlayLayer = 'regions' | BoundaryLayer;

interface BoundaryStyle {
  colour: string;
  /** Fill opacity with nothing picked. */
  fill: number;
  fillSelected: number;
  fillHover: number;
  width: number;
  widthSelected: number;
  /** Line opacity with nothing picked. */
  lineOpacity: number;
}

/**
 * One entry per overlay. Environmental regions carry the public project map's values so the same
 * region reads the same on both sites; the other three are DEMI's own, drawn nowhere else.
 */
export const BOUNDARY_STYLES: Record<OverlayLayer, BoundaryStyle> = {
  regions: { colour: '#003366', fill: 0.08, fillSelected: 0.14, fillHover: 0.18, width: 1, widthSelected: 4.5, lineOpacity: 0.5 },
  regionalDistricts: { colour: '#6366f1', fill: 0.07, fillSelected: 0.22, fillHover: 0.2, width: 1.5, widthSelected: 3.5, lineOpacity: 1 },
  municipalities: { colour: '#0d9488', fill: 0.06, fillSelected: 0.21, fillHover: 0.18, width: 1.5, widthSelected: 3.5, lineOpacity: 1 },
  electoralDistricts: { colour: '#ec4899', fill: 0.07, fillSelected: 0.22, fillHover: 0.2, width: 1.5, widthSelected: 3.5, lineOpacity: 1 },
};

/** The feature property each overlay names its shapes with; also the feature-state key. */
export const NAME_PROPERTY: Record<OverlayLayer, string> = {
  regions: 'regionName',
  regionalDistricts: 'name',
  municipalities: 'name',
  electoralDistricts: 'name',
};

export const fillLayerId = (layer: OverlayLayer): string => `${layer}-fill`;
export const lineLayerId = (layer: OverlayLayer): string => `${layer}-line`;
export const INVASIVES_SOURCE_ID = 'invasives';
export const INVASIVES_LAYER_ID = 'invasives-raster';

const hover: ExpressionSpecification = ['boolean', ['feature-state', 'hover'], false];
const selected: ExpressionSpecification = ['boolean', ['feature-state', 'selected'], false];

/**
 * Four looks per shape, the way the Leaflet styles read: plain, picked, hovered, and dimmed when
 * something else in the same overlay is picked. `hasSelection` is known here, so it picks the
 * expression rather than riding inside it.
 */
export function fillPaint(style: BoundaryStyle, hasSelection: boolean): FillLayerSpecification['paint'] {
  const opacity: ExpressionSpecification = hasSelection
    ? [
        'case',
        selected,
        ['case', hover, style.fillHover, style.fillSelected],
        hover,
        style.fillHover / 2,
        style.fill / 2,
      ]
    : ['case', hover, style.fillHover, style.fill];

  return { 'fill-color': style.colour, 'fill-opacity': opacity };
}

export function linePaint(style: BoundaryStyle, hasSelection: boolean): LineLayerSpecification['paint'] {
  const width: ExpressionSpecification = hasSelection
    ? ['case', selected, ['case', hover, 3, style.widthSelected], hover, 2, 1]
    : ['case', hover, 3, style.width];
  // Dimming the unpicked shapes: MapLibre cannot data-drive `line-dasharray`, which is how Leaflet
  // drew the same recession.
  const opacity: ExpressionSpecification | number = hasSelection
    ? ['case', selected, 1, hover, 0.6, 0.4]
    : style.lineOpacity;

  return { 'line-color': style.colour, 'line-width': width, 'line-opacity': opacity };
}

interface BoundaryOverlayProps {
  layer: OverlayLayer;
  data: FeatureCollection | FeatureCollection<BoundaryProperties> | GeoJsonCollection;
  hasSelection: boolean;
}

/** One source and two layers per overlay: the fill answers clicks, the line draws the edge. */
export function BoundaryOverlay({ layer, data, hasSelection }: BoundaryOverlayProps) {
  const style = BOUNDARY_STYLES[layer];
  return (
    <Source
      id={layer}
      type="geojson"
      data={data as GeoJsonCollection}
      // Feature state needs an id, and these rows carry no stable one: the name is what is picked.
      promoteId={NAME_PROPERTY[layer]}
    >
      <Layer id={fillLayerId(layer)} type="fill" paint={fillPaint(style, hasSelection)} />
      <Layer id={lineLayerId(layer)} type="line" paint={linePaint(style, hasSelection)} />
    </Source>
  );
}

/**
 * The invasive-species tiles. Kept as one source: a species change re-tiles it, in place, which the
 * `<Source>` binding does itself once `tiles` is the prop that changed.
 */
export function InvasivesRaster({ species }: { species: string }) {
  return (
    <Source
      id={INVASIVES_SOURCE_ID}
      type="raster"
      tiles={[invasivesTileUrl(species)]}
      tileSize={256}
      attribution="Contains information licensed under the Open Government Licence – British Columbia."
    >
      <Layer
        id={INVASIVES_LAYER_ID}
        type="raster"
        paint={{ 'raster-opacity': INVASIVES_RASTER_OPACITY }}
      />
    </Source>
  );
}

interface Fire {
  key: string;
  lng: number;
  lat: number;
  card: WildfireCard;
}

/** DataBC rows the map can draw, as markers rather than a layer: the pill carries an icon. */
export function wildfirePins(collection: FeatureCollection | null | undefined): Fire[] {
  return (collection?.features || []).flatMap((feature, index) => {
    const props = (feature.properties || {}) as Record<string, unknown>;
    const point = wildfireCoordinates(feature.geometry, props);
    if (!point) return [];
    const card = wildfireCard(props);
    return [{ key: `${card.title}-${index}`, lng: point[0], lat: point[1], card }];
  });
}

export function WildfireMarkers({ fires }: { fires: Fire[] }) {
  // The key, not the row: a refetch replaces every row, and a fire that has gone takes its card.
  const [openKey, setOpenKey] = useState<string | null>(null);
  const open = fires.find((fire) => fire.key === openKey) ?? null;

  return (
    <>
      {fires.map((fire) => (
        <Marker key={fire.key} longitude={fire.lng} latitude={fire.lat} anchor="center">
          <button
            type="button"
            className={`wildfire-marker-pill${fire.card.fireOfNote ? ' fire-of-note' : ''}`}
            data-testid="wildfire-marker"
            style={{
              backgroundColor: fire.card.colour,
              width: `${fire.card.sizePx}px`,
              height: `${fire.card.sizePx}px`,
            }}
            aria-label={`${fire.card.title}, ${fire.card.status}`}
            onClick={() => setOpenKey(fire.key)}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M12 2c1 4 5 5 5 10a5 5 0 0 1-10 0c0-2 1-3 2-4 0 2 1 3 2 3 0-3-1-6 1-9z" />
            </svg>
          </button>
        </Marker>
      ))}

      {open && (
        // Every value below is a text node. The Angular popup built an HTML string out of these
        // third-party fields; nothing here goes in as markup.
        <Popup
          longitude={open.lng}
          latitude={open.lat}
          anchor="bottom"
          closeOnClick={false}
          onClose={() => setOpenKey(null)}
          maxWidth="260px"
        >
          <div className="demi-fire-card" data-testid="wildfire-popup">
            <h4>{open.card.title}</h4>
            {open.card.fireOfNote && <span className="pill pill--caps pill--danger">Fire of note</span>}
            <p>
              <strong>Status: </strong>
              {open.card.status}
            </p>
            {open.card.location && (
              <p>
                <strong>Location: </strong>
                {open.card.location}
              </p>
            )}
            <p>
              <strong>Current size: </strong>
              {open.card.area}
            </p>
            <p>
              <strong>Cause: </strong>
              {open.card.cause}
            </p>
            <p>
              <strong>Fire centre: </strong>
              {open.card.fireCentre}
            </p>
            {open.card.ignited && (
              <p>
                <strong>Ignited: </strong>
                {open.card.ignited}
              </p>
            )}
            {open.card.url && (
              <a href={open.card.url} target="_blank" rel="noopener noreferrer">
                View official BC Wildfire details
              </a>
            )}
          </div>
        </Popup>
      )}
    </>
  );
}

export interface LayersPanelProps {
  activeLayers: string[];
  onToggleLayer: (layer: string) => void;
  wildfires: boolean;
  onToggleWildfires: () => void;
  invasives: boolean;
  onToggleInvasives: () => void;
  species: string;
  onSpeciesChange: (value: string) => void;
  speciesList: string[];
  matchLabel: string;
}

/** Badge on the Layers button: boundary overlays plus the wildfire and invasives toggles. */
function activeLayersCount(props: {
  activeLayers: string[];
  wildfires: boolean;
  invasives: boolean;
}): number {
  return props.activeLayers.length + (props.wildfires ? 1 : 0) + (props.invasives ? 1 : 0);
}

export function LayersPanel(props: LayersPanelProps) {
  const [open, setOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const count = activeLayersCount(props);

  useDismissable(
    open,
    panelRef,
    toggleRef,
    useCallback(() => setOpen(false), []),
  );

  return (
    <div className="demi-map-layers" ref={panelRef}>
      <button
        type="button"
        ref={toggleRef}
        className="map-control-btn"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
          <polygon points="12,3 21,8 12,13 3,8" />
          <polyline points="3,13 12,18 21,13" />
        </svg>
        Layers
        {count > 0 && <span className="pill pill--info">{count}</span>}
      </button>

      {open && (
        <div className="demi-map-layers__panel">
          <div className="micro-label">Boundary overlays</div>
          {OVERLAY_ROWS.map((row) => (
            <label key={row.id}>
              <input
                type="checkbox"
                checked={props.activeLayers.includes(row.id)}
                onChange={() => props.onToggleLayer(row.id)}
              />
              {row.label}
            </label>
          ))}
          <label>
            <input type="checkbox" checked={props.wildfires} onChange={props.onToggleWildfires} />
            Active wildfires
          </label>
          <label>
            <input type="checkbox" checked={props.invasives} onChange={props.onToggleInvasives} />
            Invasive species observations
          </label>

          {props.invasives && (
            <div className="demi-map-layers__species">
              <p className="cell__sub demi-map-layers__legend">
                <span>
                  <span aria-hidden="true" className="demi-map-swatch demi-map-swatch--present" />
                  Present
                </span>
                <span>
                  <span aria-hidden="true" className="demi-map-swatch demi-map-swatch--absent" />
                  Confirmed absent
                </span>
              </p>
              <label htmlFor="demi-invasives-species" className="micro-label">
                Species
              </label>
              <input
                id="demi-invasives-species"
                type="text"
                list="demi-invasives-species-options"
                autoComplete="off"
                placeholder="e.g. Baby's breath"
                value={props.species}
                onChange={(event) => props.onSpeciesChange(event.target.value)}
              />
              <datalist id="demi-invasives-species-options">
                {props.speciesList.map((name) => (
                  <option key={name} value={name} />
                ))}
              </datalist>
              {props.matchLabel && <span className="cell__sub">{props.matchLabel}</span>}
            </div>
          )}

          <p className="cell__sub">Overlays change the map. Filters change the results.</p>
        </div>
      )}
    </div>
  );
}

/** What the species box reports underneath itself. Empty while the counts are still in flight. */
export function invasivesMatchLabel(
  species: string,
  matches: { present: number; absent: number } | null,
): string {
  if (!species.trim()) return 'All species';
  if (matches === null) return '';
  return `${matches.present.toLocaleString()} present, ${matches.absent.toLocaleString()} absent`;
}
