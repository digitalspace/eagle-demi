'use strict';

if (typeof globalThis.crypto === 'undefined') {
  globalThis.crypto = require('node:crypto').webcrypto;
}

const { MongoClient, ObjectId } = require('mongodb');

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/test';
const DB_NAME = process.env.MONGODB_DATABASE || 'test';

async function seed() {
  const client = new MongoClient(MONGODB_URI);
  await client.connect();

  let db = client.db(DB_NAME);
  let projectsColl = db.collection('projects');
  let projects = await projectsColl.find({}).limit(50).toArray();

  if (projects.length === 0) {
    console.log(`0 projects in '${DB_NAME}', checking 'test' DB...`);
    db = client.db('test');
    projectsColl = db.collection('projects');
    projects = await projectsColl.find({}).limit(50).toArray();
  }

  console.log(`Found ${projects.length} projects in '${db.databaseName}' to associate documents with.`);

  if (projects.length === 0) {
    console.error('No projects found in collection!');
    await client.close();
    return;
  }

  const docsColl = db.collection('documents');
  const chunksColl = db.collection('document_chunks');

  // Define realistic environmental assessment documents
  const documentTemplates = [
    {
      title: "Northern Red-legged Frog & Amphibian Baseline Survey",
      fileName: "frog_amphibian_baseline_survey_2024.pdf",
      description: "Environmental assessment baseline study on Northern Red-legged Frog (Rana aurora) habitats, breeding ponds, and wetland migration corridors.",
      type: "Assessment / Study",
      milestone: "Environmental Assessment Report",
      chunks: [
        "The Northern Red-legged Frog (Rana aurora) is a blue-listed species of special concern in British Columbia. Field surveys conducted across wetland polygons identified active breeding locations in slow-moving stream habitats.",
        "Amphibian mitigation measures include constructing amphibian-friendly culverts, establishing 30-meter vegetated buffer zones around breeding ponds, and timing construction outside the egg-laying season to minimize mortality.",
        "Monitoring results confirmed egg mass clusters for Northern Red-legged Frog in the southern drainage area. Water quality testing showed acceptable pH and low turbidity suitable for tadpole development."
      ]
    },
    {
      title: "Pacific Water Shrew and Wetland Ecological Evaluation",
      fileName: "pacific_water_shrew_evaluation.pdf",
      description: "Detailed habitat suitability assessment for Pacific Water Shrew and coastal amphibian populations within project boundary.",
      type: "Baseline Study",
      milestone: "Application Phase",
      chunks: [
        "Trapping and camera trap studies targeted riparian corridors for the endangered Pacific Water Shrew. Co-occurring species noted include Oregon Spotted Frog and Western Toad.",
        "To mitigate impacts to wetland micro-habitats, the proponent will implement strict erosion and sediment control plans during site clearing."
      ]
    },
    {
      title: "Wildlife Habitat Management Plan & Grizzly Bear Assessment",
      fileName: "wildlife_management_plan_grizzly_frog.pdf",
      description: "Comprehensive wildlife management plan covering Grizzly Bear corridors, ungulate winter ranges, and amphibian breeding sites.",
      type: "Management Plan",
      milestone: "Post-Decision / Compliance",
      chunks: [
        "Section 4.2 focuses on small vertebrate species, specifically the Oregon Spotted Frog and Northern Red-legged Frog. Construction crews must receive environmental orientation regarding amphibian identification.",
        "Bear-aware protocols and garbage containment facilities will be installed at all camp locations to eliminate wildlife attractants."
      ]
    },
    {
      title: "Water Quality & Aquatic Ecosystem Monitoring Report",
      fileName: "water_quality_aquatic_monitoring.pdf",
      description: "Quarterly water quality monitoring report evaluating dissolved oxygen, metals, nutrients, and aquatic organism health.",
      type: "Monitoring Report",
      milestone: "Post-Decision / Compliance",
      chunks: [
        "Aquatic sampling stations upstream and downstream of construction activities showed temperature and pH levels remaining within CCME guidelines for the protection of aquatic life.",
        "Benthic macroinvertebrate sampling indicated healthy stream communities. No elevated levels of heavy metals were detected in surface water runoff."
      ]
    },
    {
      title: "Indigenous Consultation & Traditional Knowledge Assessment",
      fileName: "aboriginal_consultation_tk_report.pdf",
      description: "Documentation of First Nations engagement, traditional land use, and indigenous knowledge contributions to project design.",
      type: "Indigenous Engagement",
      milestone: "Evaluation / Review",
      chunks: [
        "Community meetings and site visits with First Nations elders identified traditional hunting, fishing, and medicinal plant gathering areas within the project footprint.",
        "Commitments include joint environmental monitoring, traditional plant harvesting relocation programs, and protection of culturally sensitive heritage sites."
      ]
    },
    {
      title: "Air Quality & Dust Control Management Strategy",
      fileName: "air_quality_dust_management_2024.pdf",
      description: "Air emissions baseline and dust suppression guidelines for heavy vehicle haul roads and processing facilities.",
      type: "Management Plan",
      milestone: "Post-Decision / Compliance",
      chunks: [
        "Air dispersion modeling indicates particulate matter (PM2.5 and PM10) ground-level concentrations will remain below provincial air quality objectives with watering of unpaved roads.",
        "Real-time particulate monitors will operate continuously at project property boundaries with automated alerts triggered if dust thresholds are exceeded."
      ]
    }
  ];

  console.log('Clearing old sample documents and chunks...');
  await docsColl.deleteMany({ seedDoc: true });
  await chunksColl.deleteMany({ seedDoc: true });

  const docsToInsert = [];
  const chunksToInsert = [];

  let count = 0;
  for (let i = 0; i < projects.length; i++) {
    const proj = projects[i];
    // Assign 2 to 3 documents per project
    const tpl1 = documentTemplates[i % documentTemplates.length];
    const tpl2 = documentTemplates[(i + 3) % documentTemplates.length];
    const tpls = [tpl1, tpl2];

    for (const tpl of tpls) {
      count++;
      const docId = new ObjectId();
      const uniqueSuffix = `${i}_${count}`;
      const docRecord = {
        _id: docId,
        displayName: `${proj.name} - ${tpl.title} (${uniqueSuffix})`,
        documentFileName: `${proj.trackProjectId || 'PRJ'}_${uniqueSuffix}_${tpl.fileName}`,
        s3Key: `documents/${docId.toString()}/${tpl.fileName}`,
        edrmsRecordNumber: `EDRMS_${docId.toString()}`,
        description: tpl.description,
        project: proj._id,
        projectName: proj.name,
        type: tpl.type,
        milestone: tpl.milestone,
        documentAuthorType: 'Proponent',
        projectPhase: 'Assessment',
        legislation: 2018,
        region: proj.region || 'British Columbia',
        internalExt: 'pdf',
        datePosted: new Date(),
        dateUploaded: new Date(),
        isFeatured: i < 5,
        documentSource: 'EAGLE Registry',
        read: ['public'],
        isPublished: true,
        read: ['public', 'sysadmin', 'staff', 'demi-admin'],
        seedDoc: true,
        createdAt: new Date(),
        updatedAt: new Date()
      };
      docsToInsert.push(docRecord);

      for (let pageIdx = 0; pageIdx < tpl.chunks.length; pageIdx++) {
        const chunkRecord = {
          _id: new ObjectId(),
          documentId: docId,
          document: docId,
          projectId: proj._id,
          project: proj._id,
          projectName: proj.name,
          content: `${tpl.chunks[pageIdx]} (Project: ${proj.name}, Document: ${tpl.title})`,
          pageNumber: pageIdx + 1,
          read: ['public'],
          isPublished: true,
          read: ['public', 'sysadmin', 'staff', 'demi-admin'],
          seedDoc: true,
          createdAt: new Date(),
          updatedAt: new Date()
        };
        chunksToInsert.push(chunkRecord);
      }
    }
  }

  console.log(`Inserting ${docsToInsert.length} documents...`);
  try {
    await docsColl.insertMany(docsToInsert, { ordered: false });
  } catch (e) {
    console.log(`Docs inserted with some warnings/duplicates skipped: ${e.message}`);
  }

  console.log(`Inserting ${chunksToInsert.length} document chunks...`);
  try {
    await chunksColl.insertMany(chunksToInsert, { ordered: false });
  } catch (e) {
    console.log(`Chunks inserted with some warnings/duplicates skipped: ${e.message}`);
  }

  console.log('Seeding complete successfully!');
  await client.close();
}

seed().catch(err => {
  console.error('Seeding failed:', err);
  process.exit(1);
});
