'use strict';

/**
 * The write-body allowlist every domain module checks first.
 *
 * A SCHEMA maps each writable key to a spec: `{ type, required, nullable, ... }`. Types:
 * `string` (`max` length, required on the spec), `boolean`, `enum` (`values`), `isoDate`, `id`,
 * `idArray` (optional `max` items). A key the SCHEMA does not name is a field error, so a body
 * cannot reach a field nobody decided was writable. Every field error comes back in one result.
 */

// An Eagle ObjectId or a UUID, the two id shapes rows carry.
const ID = /^(?:[0-9a-f]{24}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2}))?$/;

const isId = (value) => typeof value === 'string' && ID.test(value);

/** Why `value` fails `spec`, or null when it passes. */
function fieldError(spec, value) {
  switch (spec.type) {
    case 'string':
      if (typeof value !== 'string') return 'must be a string';
      return value.length > spec.max ? `must be at most ${spec.max} characters` : null;
    case 'boolean':
      return typeof value === 'boolean' ? null : 'must be true or false';
    case 'enum':
      return spec.values.includes(value) ? null : `must be one of ${spec.values.join(', ')}`;
    case 'isoDate':
      return typeof value === 'string' && ISO_DATE.test(value) && Number.isFinite(Date.parse(value))
        ? null : 'must be an ISO 8601 date';
    case 'id':
      return isId(value) ? null : 'must be an id';
    case 'idArray':
      if (!Array.isArray(value) || !value.every(isId)) return 'must be an array of ids';
      return spec.max !== undefined && value.length > spec.max ? `must hold at most ${spec.max} ids` : null;
    default:
      throw new TypeError(`unknown schema type ${spec.type}`);
  }
}

/** A SCHEMA mistake is a programming error, so it throws instead of blaming the caller's body. */
function assertSpec(key, spec) {
  if (spec.type === 'string' && !Number.isInteger(spec.max)) {
    throw new TypeError(`schema field ${key}: string needs an integer max`);
  }
  if (spec.type === 'enum' && !Array.isArray(spec.values)) {
    throw new TypeError(`schema field ${key}: enum needs values`);
  }
}

/**
 * @param {object} schema key -> spec
 * @param {*} input the request body
 * @param {{partial?: boolean}} [options] `partial` skips `required`, for an update
 * @returns {{status: 'ok', value: object} | {status: 'invalid', fields: object}} `fields` maps
 *   each failing key to its message
 */
function check(schema, input, { partial = false } = {}) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return { status: 'invalid', fields: { body: 'must be a JSON object' } };
  }

  const fields = {};
  const value = {};

  for (const [key, spec] of Object.entries(schema)) {
    assertSpec(key, spec);
    if (!Object.hasOwn(input, key)) {
      if (spec.required && !partial) fields[key] = 'is required';
      continue;
    }
    const given = input[key];
    const error = given === null && spec.nullable ? null : fieldError(spec, given);
    if (error) fields[key] = error;
    else value[key] = given;
  }

  for (const key of Object.keys(input)) {
    if (!Object.hasOwn(schema, key)) fields[key] = 'is not a writable field';
  }

  return Object.keys(fields).length ? { status: 'invalid', fields } : { status: 'ok', value };
}

/** `input` minus `keys`, so a body can carry fields a route ignores. Anything not an object passes through. */
const without = (input, keys) => (input && typeof input === 'object' && !Array.isArray(input)
  ? Object.fromEntries(Object.entries(input).filter(([key]) => !keys.includes(key)))
  : input);

module.exports = { check, without };
