import { describe, expect, it } from 'vitest';
import { workTypeName } from './work-types';

describe('workTypeName', () => {
  it.each([
    ['ceao-designation', 'CEAO designation'],
    ['new_kind-of work', 'New kind of work'],
    [null, 'Work type not known'],
    ['--', 'Work type not known'],
  ])('names %s as %s, never the raw code', (code, name) => {
    expect(workTypeName(code)).toBe(name);
  });
});
