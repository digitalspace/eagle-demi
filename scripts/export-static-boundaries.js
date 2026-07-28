const fs = require('fs');
const path = require('path');

const OUTPUT_DIR = path.join(__dirname, '../frontend/public/assets/geojson');

const LAYERS = [
  {
    type: 'regionalDistricts',
    filename: 'regional_districts.geojson',
    dbType: 'Regional District',
    url: 'https://openmaps.gov.bc.ca/geo/pub/wfs?service=WFS&version=1.1.0&request=GetFeature&typeName=pub:WHSE_LEGAL_ADMIN_BOUNDARIES.ABMS_REGIONAL_DISTRICTS_SP&outputFormat=application/json&srsName=EPSG:4326&maxFeatures=10000',
    getName: (f) => f.properties.ADMIN_AREA_NAME || f.properties.REGIONAL_DISTRICT_NAME || f.properties.REG_DIST_NAME || '',
    getCode: (f) => f.properties.LGL_ADMIN_AREA_ID || f.properties.REGIONAL_DISTRICT_NUM || f.properties.REG_DIST_ID || '',
    step: 10
  },
  {
    type: 'municipalities',
    filename: 'municipalities.geojson',
    dbType: 'Municipality',
    url: 'https://openmaps.gov.bc.ca/geo/pub/wfs?service=WFS&version=1.1.0&request=GetFeature&typeName=pub:WHSE_LEGAL_ADMIN_BOUNDARIES.ABMS_MUNICIPALITIES_SP&outputFormat=application/json&srsName=EPSG:4326&maxFeatures=10000',
    getName: (f) => f.properties.ADMIN_AREA_NAME || f.properties.MUNICIPALITY_NAME || f.properties.MUN_NAME || '',
    getCode: (f) => f.properties.LGL_ADMIN_AREA_ID || f.properties.MUNICIPALITY_ID || f.properties.MUN_ID || '',
    step: 5
  },
  {
    type: 'electoralDistricts',
    filename: 'electoral_districts.geojson',
    dbType: 'Electoral District',
    url: 'https://openmaps.gov.bc.ca/geo/pub/wfs?service=WFS&version=1.1.0&request=GetFeature&typeName=pub:WHSE_ADMIN_BOUNDARIES.EBC_PROV_ELECTORAL_DIST_SVW&outputFormat=application/json&srsName=EPSG:4326&maxFeatures=10000',
    getName: (f) => f.properties.ED_NAME || f.properties.ELECTORAL_DISTRICT_NAME || '',
    getCode: (f) => f.properties.ELECTORAL_DISTRICT_ID || f.properties.ED_CODE || '',
    step: 10
  }
];

function simplifyRing(ring, step = 10) {
  if (!Array.isArray(ring) || ring.length <= 4) return ring;
  const result = [
    [Math.round(ring[0][0] * 10000) / 10000, Math.round(ring[0][1] * 10000) / 10000]
  ];
  for (let i = 1; i < ring.length - 1; i += step) {
    const pt = [
      Math.round(ring[i][0] * 10000) / 10000,
      Math.round(ring[i][1] * 10000) / 10000
    ];
    // Avoid duplicate adjacent points
    const prev = result[result.length - 1];
    if (prev[0] !== pt[0] || prev[1] !== pt[1]) {
      result.push(pt);
    }
  }
  const lastPt = [
    Math.round(ring[ring.length - 1][0] * 10000) / 10000,
    Math.round(ring[ring.length - 1][1] * 10000) / 10000
  ];
  const prev = result[result.length - 1];
  if (prev[0] !== lastPt[0] || prev[1] !== lastPt[1]) {
    result.push(lastPt);
  }
  return result;
}

function filterPolygons(polygons, step = 10) {
  return polygons
    .map(poly => poly.map(ring => simplifyRing(ring, step)).filter(ring => ring.length >= 4))
    .filter(poly => poly.length > 0);
}

function simplifyGeometry(geom, step = 10) {
  if (!geom || !geom.coordinates) return geom;
  if (geom.type === 'Polygon') {
    const rings = geom.coordinates.map(ring => simplifyRing(ring, step)).filter(r => r.length >= 4);
    return { type: 'Polygon', coordinates: rings };
  }
  if (geom.type === 'MultiPolygon') {
    const polys = filterPolygons(geom.coordinates, step);
    return { type: 'MultiPolygon', coordinates: polys };
  }
  return geom;
}

async function exportStaticBoundaries() {
  console.log('=== Exporting Ultra-Optimized Static Boundary GeoJSON Assets ===');
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  for (const layer of LAYERS) {
    console.log(`Fetching ${layer.type} (${layer.dbType}) from OpenMaps WFS...`);
    try {
      const response = await fetch(layer.url);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }
      const data = await response.json();

      if (!data.features || data.features.length === 0) {
        console.warn(`No features found for ${layer.type}`);
        continue;
      }

      console.log(`Processing & downsampling ${data.features.length} features for ${layer.type}...`);

      const boundaryObjects = data.features.map((f, index) => {
        if (!f.geometry || !f.geometry.coordinates) return null;
        const name = layer.getName(f);
        const code = String(layer.getCode(f));
        const simplifiedGeom = simplifyGeometry(f.geometry, layer.step);

        return {
          _id: `static_${layer.type}_${index}`,
          type: layer.dbType,
          name: name,
          code: code,
          simplifiedGeometry: simplifiedGeom,
          geometry: simplifiedGeom
        };
      }).filter(Boolean);

      const filePath = path.join(OUTPUT_DIR, layer.filename);
      fs.writeFileSync(filePath, JSON.stringify(boundaryObjects), 'utf8');

      const stats = fs.statSync(filePath);
      console.log(`✅ Saved ${boundaryObjects.length} boundaries to ${layer.filename} (${(stats.size / 1024).toFixed(1)} KB)`);

    } catch (err) {
      console.error(`❌ Error exporting ${layer.type}:`, err.message);
    }
  }

  console.log('=== Export Complete ===');
}

exportStaticBoundaries();
