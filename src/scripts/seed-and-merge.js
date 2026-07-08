'use strict';

const fs = require('fs');
const { MongoClient, ObjectId } = require('mongodb');

async function run() {
  // Source Credentials (from eagle-api-mongodb secret)
  const sourceUser = 'userFEC';
  const sourcePass = 'SApt6J5dyfDmKF7P';
  const sourceDbName = 'epic';
  const sourceUri = process.env.SOURCE_MONGODB_URI || 
    `mongodb://${sourceUser}:${sourcePass}@127.0.0.1:27019/${sourceDbName}?authSource=admin&directConnection=true`;

  // Target Credentials (from eagle-demi-mongodb secret)
  const targetUser = 'demi';
  const targetPass = 'demi_pass_123';
  const targetDbName = 'demi';
  const targetUri = process.env.TARGET_MONGODB_URI || 
    `mongodb://${targetUser}:${targetPass}@127.0.0.1:27018/${targetDbName}?authSource=admin&directConnection=true`;

  console.log(`Connecting to Authenticated Source MongoDB (legacy) at: mongodb://***:***@localhost:27019/${sourceDbName}`);
  const sourceClient = new MongoClient(sourceUri);
  await sourceClient.connect();
  const sourceDb = sourceClient.db(sourceDbName);
  const sourceEpicColl = sourceDb.collection('epic');

  console.log(`Connecting to Authenticated Target MongoDB (standalone DEMI) at: mongodb://***:***@localhost:27018/${targetDbName}`);
  const targetClient = new MongoClient(targetUri);
  await targetClient.connect();
  const targetDb = targetClient.db(targetDbName);
  const targetProjColl = targetDb.collection('projects');
  const targetDocColl = targetDb.collection('documents');

  try {
    // 1. Clear target collections for a clean seed
    console.log('Clearing existing Projects and Documents in target standalone DEMI collections...');
    await targetProjColl.deleteMany({});
    await targetDocColl.deleteMany({});
    console.log('Target collections cleared.');

    // 2. Load Track enriched metadata
    const jsonPath = '/root/repos/track_projects_enriched.json';
    console.log(`Reading Track projects from: ${jsonPath}`);
    if (!fs.existsSync(jsonPath)) {
      throw new Error(`Enriched JSON file not found at ${jsonPath}`);
    }
    const rawData = fs.readFileSync(jsonPath, 'utf8');
    const trackProjects = JSON.parse(rawData);
    console.log(`Loaded ${trackProjects.length} projects from Track JSON.`);

    // Map Track projects by epic_guid (as String) and track_project_id (as Number)
    const trackByGuid = new Map();
    const trackById = new Map();
    for (const tp of trackProjects) {
      if (tp.epic_guid) {
        trackByGuid.set(tp.epic_guid.toString(), tp);
      }
      if (tp.track_project_id) {
        trackById.set(Number(tp.track_project_id), tp);
      }
    }

    // 3. Fetch legacy projects from Source
    console.log('Fetching legacy projects from source "epic" collection...');
    const legacyProjects = await sourceEpicColl.find({ _schemaName: 'Project' }).toArray();
    console.log(`Found ${legacyProjects.length} legacy projects in source database.`);

    const projectsToInsert = [];
    const projectIds = new Set();
    const insertedTrackProjectIds = new Set();
    let syntheticId = 10000;
    let trackMergedCount = 0;

    for (const legProj of legacyProjects) {
      const legYears = ['legislation_2018', 'legislation_2002', 'legislation_1996'];
      let name = legProj.name || 'Unknown Project';
      let region = legProj.region || 'Unknown Region';
      let coords = [-123.3656, 48.4284]; // Default centroid: Victoria, BC

      // Resolve legacy coordinates, region, name
      const preferredYear = legProj.currentLegislationYear;
      if (preferredYear && legProj[preferredYear]) {
        const block = legProj[preferredYear];
        if (block.name) name = block.name;
        if (block.region) region = block.region;
        if (block.centroid && Array.isArray(block.centroid) && block.centroid.length === 2 && typeof block.centroid[0] === 'number') {
          coords = block.centroid;
        }
      } else {
        for (const year of legYears) {
          if (legProj[year] && (legProj[year].name || legProj[year].centroid)) {
            const block = legProj[year];
            if (block.name) name = block.name;
            if (block.region) region = block.region;
            if (block.centroid && Array.isArray(block.centroid) && block.centroid.length === 2 && typeof block.centroid[0] === 'number') {
              coords = block.centroid;
              break;
            }
          }
        }
      }

      // Handle trackProjectId resolution
      let trackProjId;
      if (legProj.trackProjectId && typeof legProj.trackProjectId === 'number') {
        trackProjId = legProj.trackProjectId;
      } else if (legProj.trackProjectId && !isNaN(Number(legProj.trackProjectId))) {
        trackProjId = Number(legProj.trackProjectId);
      } else {
        trackProjId = syntheticId++;
      }

      insertedTrackProjectIds.add(trackProjId);

      // Check if this project matches any Track project from JSON for metadata merging!
      let matchedTrack = trackByGuid.get(legProj._id.toString()) || trackById.get(trackProjId);
      let metadata = {};

      if (matchedTrack) {
        trackMergedCount++;
        trackProjId = Number(matchedTrack.track_project_id); // Ensure ID alignment
        insertedTrackProjectIds.add(trackProjId);
        metadata = {
          description: matchedTrack.description || '',
          address: matchedTrack.address || '',
          abbreviation: matchedTrack.abbreviation || '',
          proponent_name: matchedTrack.proponent_name || '',
          sub_type_name: matchedTrack.sub_type_name || '',
          type_name: matchedTrack.type_name || '',
          project_state_name: matchedTrack.project_state_name || '',
          is_active_in_track: matchedTrack.is_active
        };

        // If Track has valid lat/lng, swap coordinates to standard GeoJSON order: [longitude, latitude]
        if (matchedTrack.latitude && matchedTrack.longitude) {
          const lat = parseFloat(matchedTrack.latitude);
          const lng = parseFloat(matchedTrack.longitude);
          if (!isNaN(lat) && !isNaN(lng)) {
            coords = [lng, lat];
          }
        }
      }

      projectIds.add(legProj._id.toString());

      // Determine publication status based on presence of 'public' in read array
      const isPublished = Array.isArray(legProj.read) && legProj.read.includes('public');

      projectsToInsert.push({
        _id: legProj._id,
        trackProjectId: trackProjId,
        name: name,
        region: region,
        centroid: {
          type: 'Point',
          coordinates: coords
        },
        metadata: metadata,
        isPublished: isPublished,
        createdAt: legProj._createdDate || new Date(),
        updatedAt: legProj._updatedDate || new Date()
      });
    }

    // 3.5 Insert remaining Track-only projects (Drafts / pre-public phases where Track is a superset)
    console.log('Scanning for Track-only projects not present in legacy database...');
    let trackOnlyInsertedCount = 0;
    for (const tp of trackProjects) {
      const tpId = Number(tp.track_project_id);
      if (!insertedTrackProjectIds.has(tpId)) {
        let coords = [-123.3656, 48.4284]; // Default centroid: Victoria, BC
        if (tp.latitude && tp.longitude) {
          const lat = parseFloat(tp.latitude);
          const lng = parseFloat(tp.longitude);
          if (!isNaN(lat) && !isNaN(lng)) {
            coords = [lng, lat];
          }
        }

        projectsToInsert.push({
          _id: new ObjectId(),
          trackProjectId: tpId,
          name: tp.name || 'Unnamed Track Project',
          region: tp.region_name || 'Unknown Region',
          centroid: {
            type: 'Point',
            coordinates: coords
          },
          metadata: {
            description: tp.description || '',
            address: tp.address || '',
            abbreviation: tp.abbreviation || '',
            proponent_name: tp.proponent_name || '',
            sub_type_name: tp.sub_type_name || '',
            type_name: tp.type_name || '',
            project_state_name: tp.project_state_name || '',
            is_active_in_track: tp.is_active
          },
          isPublished: false, // Track-only projects are pre-public drafts by definition
          createdAt: new Date(),
          updatedAt: new Date()
        });

        insertedTrackProjectIds.add(tpId);
        trackOnlyInsertedCount++;
      }
    }

    console.log(`Inserting ${projectsToInsert.length} projects into standalone DEMI collection (with ${trackMergedCount} Track metadata merged and ${trackOnlyInsertedCount} Track-only projects added)...`);
    if (projectsToInsert.length > 0) {
      await targetProjColl.insertMany(projectsToInsert);
    }
    console.log('Projects seeding and merging completed successfully.');

    // 4. Stream and insert legacy documents
    console.log('Streaming documents from source "epic" collection...');
    const docCursor = sourceEpicColl.find({ _schemaName: 'Document' });

    const seenS3Keys = new Set();
    const seenEdrms = new Set();
    let docCount = 0;
    let skippedCount = 0;
    let batch = [];
    const BATCH_SIZE = 1000;

    while (await docCursor.hasNext()) {
      const legDoc = await docCursor.next();

      // Ensure the document belongs to an inserted project
      if (!legDoc.project || !projectIds.has(legDoc.project.toString())) {
        skippedCount++;
        continue;
      }

      // Generate unique S3 Key
      let s3Key = legDoc.internalURL;
      if (!s3Key) {
        s3Key = `legacy-docs/${legDoc.project.toString()}/${legDoc._id.toString()}.pdf`;
      }
      if (seenS3Keys.has(s3Key)) {
        s3Key = `${s3Key}_${legDoc._id.toString()}`;
      }
      seenS3Keys.add(s3Key);

      const displayName = legDoc.displayName || legDoc.documentFileName || 'Unnamed Document';

      // Compute document publication status based on presence of 'public' in read array
      const isPublished = Array.isArray(legDoc.read) && legDoc.read.includes('public');

      const newDoc = {
        _id: legDoc._id,
        project: legDoc.project,
        displayName: displayName,
        s3Key: s3Key,
        region: legDoc.region || '',
        orcsClassification: legDoc.orcsClassification || '',
        isPublished: isPublished,
        createdAt: legDoc._createdDate || new Date(),
        updatedAt: legDoc._updatedDate || new Date()
      };

      // Avoid edrmsRecordNumber sparse unique collisions
      if (legDoc.edrmsRecordNumber) {
        const edrmsStr = String(legDoc.edrmsRecordNumber).trim();
        if (edrmsStr && !seenEdrms.has(edrmsStr)) {
          newDoc.edrmsRecordNumber = edrmsStr;
          seenEdrms.add(edrmsStr);
        }
      }

      batch.push(newDoc);
      docCount++;

      if (batch.length >= BATCH_SIZE) {
        await targetDocColl.insertMany(batch);
        console.log(`Inserted batch of ${batch.length} documents. Total processed: ${docCount}...`);
        batch = [];
      }
    }

    // Insert remaining documents
    if (batch.length > 0) {
      await targetDocColl.insertMany(batch);
      console.log(`Inserted final batch of ${batch.length} documents. Total processed: ${docCount}.`);
    }

    console.log('\nSeeding and Merging complete!');
    console.log('=================================');
    console.log(`- Projects Seeded: ${projectsToInsert.length}`);
    console.log(`  - Legacy Projects Merged: ${legacyProjects.length}`);
    console.log(`  - Track-Only Projects Added: ${trackOnlyInsertedCount}`);
    console.log(`- Track Metadata Merged: ${trackMergedCount}`);
    console.log(`- Documents Seeded: ${docCount}`);
    console.log(`- Documents Skipped: ${skippedCount}`);
    console.log('=================================');

  } catch (err) {
    console.error('Fatal error during seed-and-merge:', err);
  } finally {
    await sourceClient.close();
    await targetClient.close();
    console.log('All database connections closed.');
  }
}

run();
