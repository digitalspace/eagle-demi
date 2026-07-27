if (typeof globalThis.crypto === 'undefined') {
  globalThis.crypto = require('node:crypto').webcrypto;
}
const { MongoClient } = require('mongodb');

async function run() {
  const uri = process.env.MONGODB_URI;
  console.log('Connecting to:', uri ? uri.replace(/:[^:@]+@/, ':****@') : 'NONE');
  const client = new MongoClient(uri);
  await client.connect();
  console.log('Connected successfully');
  
  const admin = client.db().admin();
  const dbs = await admin.listDatabases();
  console.log('Databases:', JSON.stringify(dbs.databases));
  
  for (const dbInfo of dbs.databases) {
    const db = client.db(dbInfo.name);
    const collections = await db.listCollections().toArray();
    console.log('DB:', dbInfo.name, 'Collections:', collections.map(c => c.name));
    for (const c of collections) {
      const count = await db.collection(c.name).countDocuments();
      console.log(`  Coll: ${c.name}, Count: ${count}`);
    }
  }
  await client.close();
}

run().catch(console.error);
