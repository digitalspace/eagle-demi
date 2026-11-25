import { describe, expect, it } from 'vitest';
import { outcomeText } from './chart-words';

describe('outcomeText', () => {
  it('marks an outcome taken from the Track copy', () => {
    expect(outcomeText({ outcome: 'Amendment Granted', outcomeFrom: 'track' })).toBe('Amendment approved (from Track)');
  });

  it('leaves the work’s own outcome unmarked, and gives null for none', () => {
    expect(outcomeText({ outcome: 'Amendment Granted', outcomeFrom: null })).toBe('Amendment approved');
    expect(outcomeText({ outcome: null, outcomeFrom: 'track' })).toBeNull();
  });
});
