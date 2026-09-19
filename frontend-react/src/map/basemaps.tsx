/* eslint-disable react-refresh/only-export-components -- one map module: the components and the
   constants they share (style, bounds, basemap list) are the same unit of change. */
import { useCallback, useRef, useState, type ReactNode } from 'react';
import {
  AttributionControl,
  Layer,
  NavigationControl,
  ScaleControl,
  Source,
} from '@vis.gl/react-maplibre';
import type { StyleSpecification } from 'maplibre-gl';
import mapWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import 'maplibre-gl/dist/maplibre-gl.css';
import { useDismissable } from './use-dismissable';

/**
 * Pass to every `<Map workerUrl>`: maplibre-gl derives its worker URL from its own module URL, and
 * neither Vite's dep pre-bundle nor the built chunk has a sibling worker file there.
 */
export const WORKER_URL = mapWorkerUrl;

/** Module constant so `<Map mapStyle>` keeps one identity; the basemaps are added as sources instead. */
export const EMPTY_STYLE: StyleSpecification = { version: 8, sources: {}, layers: [] };

/**
 * The BC-wide opening view. Leaflet counts zoom in 256 px tiles and MapLibre in 512 px ones, so
 * the same ground is one level lower here: every zoom ported from Angular is its Leaflet value
 * minus 1. This one comes from `setView([54.0, -125.0], 5)`.
 */
export const BC_CENTER: [number, number] = [-125.0, 54.0];
export const DEFAULT_ZOOM = 4;

/** Below this the map is showing the province, so reaching a project is worth a flight. */
export const ORIENTATION_THRESHOLD = 6;
/** Where a fly-in lands. */
export const ORIENTATION_ZOOM = 7;

export const DEFAULT_BASEMAP = 'World Topographic';

interface Basemap {
  name: string;
  path: string;
  maxzoom: number;
  attribution: string;
}

const BASEMAPS: Basemap[] = [
  {
    name: 'Light Gray',
    path: 'Canvas/World_Light_Gray_Base',
    maxzoom: 16,
    attribution: 'Tiles &copy; Esri',
  },
  {
    name: 'World Topographic',
    path: 'World_Topo_Map',
    maxzoom: 16,
    attribution: 'Tiles &copy; Esri',
  },
  {
    name: 'World Imagery',
    path: 'World_Imagery',
    maxzoom: 17,
    attribution: 'Tiles &copy; Esri',
  },
];

function slug(basemap: Basemap): string {
  return `basemap-${basemap.name.toLowerCase().replace(/\s+/g, '-')}`;
}

/** Keyless Esri raster tiles. One source of the URL template, for every map that draws ground. */
export function basemapSource(name: string): Omit<Basemap, 'name' | 'path'> & { tiles: string[] } {
  const entry = BASEMAPS.find((basemap) => basemap.name === name) ?? BASEMAPS[0];
  return {
    tiles: [
      `https://server.arcgisonline.com/ArcGIS/rest/services/${entry.path}/MapServer/tile/{z}/{y}/{x}`,
    ],
    maxzoom: entry.maxzoom,
    attribution: entry.attribution,
  };
}

export function activeBasemapName(stored: string): string {
  return BASEMAPS.some((basemap) => basemap.name === stored) ? stored : DEFAULT_BASEMAP;
}

export function Basemaps({ basemap }: { basemap: string }) {
  const active = activeBasemapName(basemap);

  return (
    <>
      {BASEMAPS.map((entry) => (
        <Source
          key={entry.name}
          id={slug(entry)}
          type="raster"
          tileSize={256}
          {...basemapSource(entry.name)}
        >
          <Layer
            id={`${slug(entry)}-layer`}
            type="raster"
            layout={{ visibility: entry.name === active ? 'visible' : 'none' }}
          />
        </Source>
      ))}
    </>
  );
}

interface MapControlsProps {
  basemap: string;
  onBasemapChange: (name: string) => void;
  /** Sits at the top of the same stack: the overlay Layers panel. */
  children?: ReactNode;
}

export function MapControls({ basemap, onBasemapChange, children }: MapControlsProps) {
  const active = activeBasemapName(basemap);
  const [layersOpen, setLayersOpen] = useState(false);
  const layersRef = useRef<HTMLDivElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);

  useDismissable(
    layersOpen,
    layersRef,
    toggleRef,
    useCallback(() => setLayersOpen(false), []),
  );

  return (
    <>
      <NavigationControl position="bottom-right" showCompass={false} />
      <ScaleControl position="bottom-right" />
      <AttributionControl position="bottom-right" />

      <div className="map-controls">
        {children}

        <div className="map-controls__layers" ref={layersRef}>
          <button
            type="button"
            ref={toggleRef}
            className="map-control-btn map-control-btn--icon"
            // "Layers" belongs to the overlay panel, as in the Angular screen; this picks the ground.
            aria-label="Base map"
            title="Base map"
            aria-expanded={layersOpen}
            onClick={() => setLayersOpen((open) => !open)}
          >
            <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M11.99 18.54l-7.37-5.73L3 14.07l9 7 9-7-1.63-1.27-7.38 5.74zM12 16l7.36-5.73L21 9l-9-7-9 7 1.63 1.27L12 16z" />
            </svg>
          </button>

          {layersOpen && (
            <div className="map-layers-menu">
              <div role="group" aria-label="Base map">
                {BASEMAPS.map((entry) => (
                  <label className="map-layers-menu__row" key={entry.name}>
                    <input
                      type="radio"
                      name="basemap"
                      value={entry.name}
                      checked={entry.name === active}
                      onChange={() => onBasemapChange(entry.name)}
                    />
                    <span>{entry.name}</span>
                  </label>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
