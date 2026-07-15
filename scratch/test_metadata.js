'use strict';

const mongoose = require('mongoose');
const mongoUri = 'mongodb://demi:demi_pass_123@localhost:27017/demi?authSource=admin';

async function run() {
  try {
    await mongoose.connect(mongoUri, { directConnection: true });
    console.log('Connected to MongoDB');
    
    const Project = mongoose.connection.db.collection('projects');
    const project = await Project.findOne({});
    console.log('Original DB Project:', JSON.stringify(project, null, 2));

    // Simulate search.js project mapping
    let rawMetadata = project.metadata || {};
    const description = project.description || rawMetadata?.trackAttributes?.description || '';
    const sector = project.sector || rawMetadata?.type_name || 'Other';
    const status = project.status || 'Active';
    const proponentName = 'Proponent Organization';

    const finalMetadata = {
      trackAttributes: {
        track_project_id: project.trackProjectId || 'N/A',
        lead_agency: 'BC Environmental Assessment Office',
        decision_date: null,
        name: project.name,
        description: description
      },
      eagleAttributes: {
        _id: project._id,
        name: project.name,
        responsibleEPD: 'Project Assessment Director',
        locationDescription: project.region || 'British Columbia',
        centroid: project.centroid ? project.centroid.coordinates : [-125.0, 54.0]
      }
    };

    const returnedProject = {
      _id: project._id.toString(),
      name: project.name,
      sector: sector,
      status: status,
      metadata: finalMetadata
    };

    console.log('Returned API Project Payload:', JSON.stringify(returnedProject, null, 2));
  } catch (err) {
    console.error('Error:', err);
  } finally {
    await mongoose.disconnect();
  }
}

run();
