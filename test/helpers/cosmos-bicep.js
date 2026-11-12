'use strict';

const fs = require('fs');
const path = require('path');

const COSMOS_MODULE = fs.readFileSync(path.join(__dirname, '..', '..', 'azure', 'modules', 'cosmos-nosql.bicep'), 'utf8');

/** The `resource` block in cosmos-nosql.bicep that declares the SQL container `name`, or undefined. */
function cosmosContainer(name) {
  return COSMOS_MODULE.split(/^resource /m)
    .find(b => /^\w+ 'Microsoft\.DocumentDB\/databaseAccounts\/sqlDatabases\/containers@/.test(b)
      && b.includes(`\n  name: '${name}'\n`));
}

module.exports = { COSMOS_MODULE, cosmosContainer };
