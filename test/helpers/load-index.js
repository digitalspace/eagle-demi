'use strict';

/**
 * Load `api/index.js` against a recording `app`, for the timer-registration tests.
 *
 * Nothing about a Functions timer runs outside Azure, so `@azure/functions` is replaced in the
 * require cache before the app loads and the assertions are on what it asked to register.
 */

const INDEX = require.resolve('../../api/index');
const FUNCTIONS = require.resolve('@azure/functions');

/** Every app setting that registers a trigger. The ones not under test are cleared: a value left
 *  in the environment registers a second trigger and breaks the caller's counts. */
const SCHEDULE_VARS = [
  'RECONCILE_SCHEDULE', 'SYNC_TEAMS_SCHEDULE', 'BULK_CLEANUP_SCHEDULE', 'BULK_DOWNLOADS_QUEUE'
];

const setEnv = (name, value) => {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
};

/**
 * @param {object} t         the node:test context, for restoring the cache and the environment
 * @param {string} name      the app setting under test, one of SCHEDULE_VARS
 * @param {string} [schedule] its value, or undefined for "the environment never set it"
 */
function loadIndex(t, name, schedule) {
  const registered = { timers: [], https: [], queues: [] };
  const cachedFunctions = require.cache[FUNCTIONS];
  const cachedIndex = require.cache[INDEX];
  const cachedEnv = SCHEDULE_VARS.map(v => [v, process.env[v]]);

  require.cache[FUNCTIONS] = {
    id: FUNCTIONS,
    filename: FUNCTIONS,
    loaded: true,
    exports: {
      app: {
        timer: (timerName, options) => registered.timers.push({ name: timerName, options }),
        http: (httpName, options) => registered.https.push({ name: httpName, options }),
        storageQueue: (queueName, options) => registered.queues.push({ name: queueName, options }),
        hook: { appTerminate: () => {} }
      }
    }
  };
  delete require.cache[INDEX];
  for (const v of SCHEDULE_VARS) setEnv(v, v === name ? schedule : undefined);

  t.after(() => {
    require.cache[FUNCTIONS] = cachedFunctions;
    require.cache[INDEX] = cachedIndex;
    for (const [v, value] of cachedEnv) setEnv(v, value);
  });

  return { registered, index: require(INDEX) };
}

module.exports = { loadIndex };
