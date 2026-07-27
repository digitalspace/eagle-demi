'use strict';

if (typeof globalThis.crypto === 'undefined') {
  globalThis.crypto = require('node:crypto').webcrypto;
}

const { MongoClient } = require('mongodb');

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/test';

async function main() {
  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  const db = client.db('test');
  const indexes = await db.collection('documents').indexes();
  console.log('Indexes on test.documents:', JSON.stringify(indexes, null, 2));
  await client.close();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
