import { useCallback, useEffect, useRef } from 'react';
import { Layer, Map as MapGL, Source } from '@vis.gl/react-maplibre';
import type { MapRef } from '@vis.gl/react-maplibre';
import {
  BC_CENTER,
  CreditControl,
  DEFAULT_BASEMAP,
  DEFAULT_ZOOM,
  EMPTY_STYLE,
  WORKER_URL,
  basemapSource,
} from './basemaps';
import { LassoShape } from './lasso';
import { bboxOf } from './geojson';
import { lassoGeometry } from './map-state';
import './mini-map.css';

const BASEMAP_SOURCE_ID = 'mini-basemap';

/**
 * A saved area on its own, with no controls and nothing to click: the list beside it is what the
 * reader acts on. Lazy-loaded, so the workspace does not carry the map library to show a list.
 * `<Map>` removes the WebGL map and its worker when this unmounts.
 */
export default function MiniMap({ ring }: { ring: number[][] }) {
  const mapRef = useRef<MapRef>(null);

  const fit = useCallback(() => {
    const map = mapRef.current;
    const box = bboxOf(lassoGeometry(ring));
    if (!map || !box) return;
    map.fitBounds(
      [
        [box[0], box[1]],
        [box[2], box[3]],
      ],
      { padding: 16, duration: 0 },
    );
  }, [ring]);

  // The shape follows the ring on its own; only the camera has to be told a different area is up.
  useEffect(fit, [fit]);

  return (
    <div className="demi-mini-map">
      <MapGL
        ref={mapRef}
        initialViewState={{ longitude: BC_CENTER[0], latitude: BC_CENTER[1], zoom: DEFAULT_ZOOM }}
        mapStyle={EMPTY_STYLE}
        workerUrl={WORKER_URL}
        interactive={false}
        attributionControl={false}
        style={{ width: '100%', height: '100%' }}
        onLoad={fit}
      >
        <Source
          id={BASEMAP_SOURCE_ID}
          type="raster"
          tileSize={256}
          {...basemapSource(DEFAULT_BASEMAP)}
        >
          <Layer id={`${BASEMAP_SOURCE_ID}-layer`} type="raster" />
        </Source>

        {/* Esri's terms want the tiles credited; the map screen's "i", as the preview is a thumbnail. */}
        <CreditControl />

        <LassoShape ring={ring} preview={false} />
      </MapGL>
    </div>
  );
}
