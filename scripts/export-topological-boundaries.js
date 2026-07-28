const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const OUTPUT_DIR = path.join(__dirname, '../frontend/public/assets/geojson');
const TMP_DIR = path.join(__dirname, '../tmp_geo');

const LAYERS = [
  {
    type: 'regionalDistricts',
    filename: 'regional_districts.geojson',
    dbType: 'Regional District',
    url: 'https://openmaps.gov.bc.ca/geo/pub/wfs?service=WFS&version=1.1.0&request=GetFeature&typeName=pub:WHSE_LEGAL_ADMIN_BOUNDARIES.ABMS_REGIONAL_DISTRICTS_SP&outputFormat=application/json&srsName=EPSG:4326&maxFeatures=10000',
    getName: (f) => f.properties.ADMIN_AREA_NAME || f.properties.REGIONAL_DISTRICT_NAME || f.properties.REG_DIST_NAME || '',
    getCode: (f) => f.properties.LGL_ADMIN_AREA_ID || f.properties.REGIONAL_DISTRICT_NUM || f.properties.REG_DIST_ID || '',
    simplifyPct: '3%'
  },
  {
    type: 'municipalities',
    filename: 'municipalities.geojson',
    dbType: 'Municipality',
    url: 'https://openmaps.gov.bc.ca/geo/pub/wfs?service=WFS&version=1.1.0&request=GetFeature&typeName=pub:WHSE_LEGAL_ADMIN_BOUNDARIES.ABMS_MUNICIPALITIES_SP&outputFormat=application/json&srsName=EPSG:4326&maxFeatures=10000',
    getName: (f) => f.properties.ADMIN_AREA_NAME || f.properties.MUNICIPALITY_NAME || f.properties.MUN_NAME || '',
    getCode: (f) => f.properties.LGL_ADMIN_AREA_ID || f.properties.MUNICIPALITY_ID || f.properties.MUN_ID || '',
    simplifyPct: '6%'
  },
  {
    type: 'electoralDistricts',
    filename: 'electoral_districts.geojson',
    dbType: 'Electoral District',
    url: 'https://openmaps.gov.bc.ca/geo/pub/wfs?service=WFS&version=1.1.0&request=GetFeature&typeName=pub:WHSE_ADMIN_BOUNDARIES.EBC_PROV_ELECTORAL_DIST_SVW&outputFormat=application/json&srsName=EPSG:4326&maxFeatures=10000',
    getName: (f) => f.properties.ED_NAME || f.properties.ELECTORAL_DISTRICT_NAME || '',
    getCode: (f) => f.properties.ELECTORAL_DISTRICT_ID || f.properties.ED_CODE || '',
    simplifyPct: '3%'
  }
];

async function exportTopologicalBoundaries() {
  console.log('=== Exporting Topology-Preserving Boundary GeoJSON (Mapshaper Engine) ===');

  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }
  if (!fs.existsSync(TMP_DIR)) {
    fs.mkdirSync(TMP_DIR, { recursive: true });
  }

  for (const layer of LAYERS) {
    console.log(`\n[1/3] Fetching ${layer.type} (${layer.dbType}) from OpenMaps WFS...`);
    try {
      const response = await fetch(layer.url);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }
      const rawData = await response.json();

      if (!rawData.features || rawData.features.length === 0) {
        console.warn(`No features found for ${layer.type}`);
        continue;
      }

      console.log(`Fetched ${rawData.features.length} features. Writing raw file for Mapshaper...`);
      const rawFile = path.join(TMP_DIR, `raw_${layer.type}.json`);
      const topoFile = path.join(TMP_DIR, `topo_${layer.type}.json`);

      fs.writeFileSync(rawFile, JSON.stringify(rawData), 'utf8');

      console.log(`[2/3] Running Mapshaper topological simplification (${layer.simplifyPct} detail)...`);
      const cmd = `npx mapshaper -i "${rawFile}" -clean -simplify ${layer.simplifyPct} visvalingam keep-shapes -o "${topoFile}" format=geojson`;
      console.log(`Executing: ${cmd}`);
      execSync(cmd, { stdio: 'inherit' });

      if (!fs.existsSync(topoFile)) {
        throw new Error(`Mapshaper failed to produce output file ${topoFile}`);
      }

      console.log(`[3/3] Formatting topological GeoJSON output for frontend...`);
      const topoData = JSON.parse(fs.readFileSync(topoFile, 'utf8'));

      const boundaryObjects = topoData.features.map((f, index) => {
        if (!f.geometry || !f.geometry.coordinates) return null;
        const name = layer.getName(f);
        const code = String(layer.getCode(f));

        return {
          _id: `static_${layer.type}_${index}`,
          type: layer.dbType,
          name: name,
          code: code,
          simplifiedGeometry: f.geometry,
          geometry: f.geometry
        };
      }).filter(Boolean);

      const filePath = path.join(OUTPUT_DIR, layer.filename);
      fs.writeFileSync(filePath, JSON.stringify(boundaryObjects), 'utf8');

      const stats = fs.statSync(filePath);
      console.log(`✅ Successfully saved ${boundaryObjects.length} topologically aligned boundaries to ${layer.filename} (${(stats.size / 1024).toFixed(1)} KB)`);

    } catch (err) {
      console.error(`❌ Error processing ${layer.type}:`, err.message);
    }
  }

  // Cleanup temporary files
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
  console.log('\n=== Export Complete ===');
}

exportTopologicalBoundaries();
