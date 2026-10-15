'use strict';

// The swagger side of a native list route, for tests that hold swagger to the route's kind spec.

const fs = require('node:fs');
const path = require('node:path');

const { CONTROL_PARAMS } = require('../../src/helpers/native-query');

/**
 * Query name -> its swagger parameter block, for the GET on `route`. A `$ref` entry is read from
 * `components.parameters`. Text-scanned like config-public.test.js: there is no YAML parser in
 * this project's dependencies.
 */
function swaggerParams(route) {
  const yaml = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'swagger', 'swagger.yaml'), 'utf8');
  const start = yaml.indexOf(`\n  ${route}:\n`);
  const block = yaml.slice(start, yaml.indexOf('      responses:', start));
  return new Map(block.split('\n        - ').slice(1).map(entry => {
    const ref = entry.match(/^\$ref: '#\/components\/parameters\/(\w+)'/);
    const param = ref ? yaml.slice(yaml.indexOf(`\n    ${ref[1]}:\n`)).split(/\n {4}(?! )/)[1] : entry;
    return [param.match(/name: (\S+)/)[1], param];
  }));
}

/**
 * The query names a kind spec takes several values for: an alias where one renames the field, and
 * every `wrapperParams` name, which the route's own wrapper takes as a list.
 */
function repeatableNames(spec) {
  const renamedBy = new Map(Object.entries(spec.aliases || {}).map(([name, field]) => [field, name]));
  return [...(spec.multiValueFilters || []).map(field => renamedBy.get(field) || field), ...(spec.wrapperParams || [])];
}

/**
 * Every query name a list on `spec` answers to; `parseNativeQuery` 400s any other, and the route's
 * wrapper takes `wrapperParams` out first. A filter an alias renames answers to the alias only.
 */
function queryNames(spec) {
  const renamed = Object.values(spec.aliases || {});
  return [
    ...CONTROL_PARAMS,
    ...(spec.filters || []).filter(field => !renamed.includes(field)),
    ...Object.keys(spec.aliases || {}),
    ...Object.keys(spec.ranges || {}),
    ...Object.keys(spec.contains || {}),
    ...Object.keys(spec.presence || {}),
    ...Object.keys(spec.flags || {}),
    ...(spec.wrapperParams || [])
  ].sort();
}

module.exports = { swaggerParams, repeatableNames, queryNames };
