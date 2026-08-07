'use strict';

const https = require('https');
const http = require('http');
const wildfiresRepo = require('../repositories/wildfires');
const projectsRepo = require('../repositories/projects');
const { systemAccess } = require('../helpers/access-sql');

const WFS_POINTS_URL = 'https://openmaps.gov.bc.ca/geo/pub/wfs?service=WFS&version=2.0.0&request=GetFeature&typeName=pub:WHSE_LAND_AND_NATURAL_RESOURCE.PROT_CURRENT_FIRE_PNTS_SP&outputFormat=json';
const WFS_POLYS_URL = 'https://openmaps.gov.bc.ca/geo/pub/wfs?service=WFS&version=2.0.0&request=GetFeature&typeName=pub:WHSE_LAND_AND_NATURAL_RESOURCE.PROT_CURRENT_FIRE_POLYS_SP&outputFormat=json';

function fetchJson(url) {
  return new Promise((resolve) => {
    const client = url.startsWith('https') ? https : http;
    client.get(url, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (err) {
          console.error(`[Wildfire Sync] Error parsing JSON from ${url}:`, err.message);
          resolve({ features: [] });
        }
      });
    }).on('error', err => {
      console.error(`[Wildfire Sync] HTTP error fetching ${url}:`, err.message);
      resolve({ features: [] });
    });
  });
}

function calculateDistanceKm(lat1, lon1, lat2, lon2) {
  const R = 6371; // Earth's radius in km
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

async function syncWildfiresData() {
  console.log('[Wildfire Sync] Fetching B.C. Wildfire data from DataBC OpenMaps WFS...');

  const [pointsData, polysData] = await Promise.all([
    fetchJson(WFS_POINTS_URL),
    fetchJson(WFS_POLYS_URL)
  ]);

  const points = pointsData?.features || [];
  const polys = polysData?.features || [];

  console.log(`[Wildfire Sync] Received ${points.length} incident points and ${polys.length} perimeters.`);

  const polyMap = new Map();
  for (const p of polys) {
    if (p.properties?.FIRE_NUMBER) {
      polyMap.set(p.properties.FIRE_NUMBER, p.geometry);
    }
  }

  let syncedWildfires = 0;
  for (const feat of points) {
    const props = feat.properties || {};
    const fireNumber = props.FIRE_NUMBER || `UNKNOWN_${Math.random()}`;
    const lng = props.LONGITUDE;
    const lat = props.LATITUDE;

    const fireDoc = {
      id: String(fireNumber),
      fireNumber,
      fireYear: props.FIRE_YEAR || new Date().getFullYear(),
      incidentName: props.INCIDENT_NAME || props.GEOGRAPHIC_DESCRIPTION || fireNumber,
      geographicDescription: props.GEOGRAPHIC_DESCRIPTION || '',
      fireStatus: props.FIRE_STATUS || 'Unknown',
      fireCause: props.FIRE_CAUSE || 'Unknown',
      currentSizeHectares: props.CURRENT_SIZE || 0,
      fireUrl: props.FIRE_URL || '',
      isFireOfNote: props.FIRE_OF_NOTE_IND === 'Y',
      location: { type: 'Point', coordinates: [lng, lat] },
      perimeterGeoJson: polyMap.get(fireNumber) || null,
      syncedAt: new Date().toISOString()
    };

    await wildfiresRepo.upsert(fireDoc);
    syncedWildfires++;
  }

  // --- Proximity Engine Calculation ---
  console.log('[Wildfire Proximity] Calculating distance between projects and active fires...');
  const activeFires = points.filter(f => f.properties?.FIRE_STATUS !== 'Out' && f.properties?.LATITUDE && f.properties?.LONGITUDE);
  // Only projects that HAVE a centroid, projected to id/name/centroid. A project without one
  // was skipped by the loop below anyway, so listing the rest was pure RU.
  const { items: projects } = await projectsRepo.listWithCentroid(systemAccess());

  let updatedProjects = 0;
  for (const proj of projects) {
    let pLng = null;
    let pLat = null;
    if (Array.isArray(proj.centroid) && proj.centroid.length >= 2) {
      pLng = proj.centroid[0];
      pLat = proj.centroid[1];
    } else if (proj.centroid?.coordinates && Array.isArray(proj.centroid.coordinates)) {
      pLng = proj.centroid.coordinates[0];
      pLat = proj.centroid.coordinates[1];
    } else if (proj.centroid?.longitude && proj.centroid?.latitude) {
      pLng = proj.centroid.longitude;
      pLat = proj.centroid.latitude;
    }
    if (pLng == null || pLat == null) continue;

    let activeCountWithin50km = 0;
    let minDistance = Infinity;
    let firesOfNoteCount = 0;

    for (const fire of activeFires) {
      const fLng = fire.properties.LONGITUDE;
      const fLat = fire.properties.LATITUDE;
      const dist = calculateDistanceKm(pLat, pLng, fLat, fLng);

      if (dist <= 50) {
        activeCountWithin50km++;
        if (fire.properties.FIRE_OF_NOTE_IND === 'Y') firesOfNoteCount++;
      }
      if (dist < minDistance) {
        minDistance = dist;
      }
    }

    // A PATCH of one path, not a whole-item upsert. listWithCentroid projects three fields, so
    // writing the item back would erase the project — but even with a full row it would be
    // wrong: a replace from this sync silently discards whatever the Track sync
    // wrote in between.
    await projectsRepo.patchWildfireStats(proj.id, {
      activeCountWithin50km,
      nearestDistanceKm: minDistance === Infinity ? null : parseFloat(minDistance.toFixed(1)),
      firesOfNoteNearby: firesOfNoteCount,
      lastCalculatedAt: new Date().toISOString()
    });
    updatedProjects++;
  }

  console.log(`[Wildfire Sync] Complete: ${syncedWildfires} wildfires synced, ${updatedProjects} projects updated with proximity metrics.`);
  return { syncedWildfires, updatedProjects };
}

module.exports = { syncWildfiresData };

if (require.main === module) {
  // No explicit client init — the NoSQL client connects lazily on first use, and Cosmos is
  // behind a private endpoint, so this only runs inside the network anyway.
  syncWildfiresData()
    .then((res) => {
      console.log('[Wildfire Sync CLI] Result:', res);
      process.exit(0);
    })
    .catch((err) => {
      console.error('[Wildfire Sync CLI] Error:', err.message);
      process.exit(1);
    });
}
