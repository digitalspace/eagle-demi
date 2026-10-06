'use strict';

const IDENTITY = require.resolve('@azure/identity');

/** Swap @azure/identity in the require cache for classes that record their constructor options. */
function recordCredentials(t) {
  const original = require.cache[IDENTITY];
  const built = [];
  const recorder = (kind) => class { constructor(options) { built.push({ kind, options }); } };
  require.cache[IDENTITY] = {
    id: IDENTITY,
    filename: IDENTITY,
    loaded: true,
    exports: {
      ManagedIdentityCredential: recorder('managed'),
      DefaultAzureCredential: recorder('default')
    }
  };
  t.after(() => {
    if (original) require.cache[IDENTITY] = original;
    else delete require.cache[IDENTITY];
  });
  return built;
}

module.exports = { recordCredentials };
