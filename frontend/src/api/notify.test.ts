import { describe, expect, it } from 'vitest';
import { ApiError } from './client';
import { notifyMessage } from './notify';

const refused = (error: string, status = 400) => new ApiError(status, JSON.stringify({ error }));

describe('notifyMessage', () => {
  it('words a reason eagle-notify is known to send', () => {
    expect(notifyMessage(refused('send_budget_exhausted', 429))).toBe('Send budget exhausted, try later');
  });

  it('shows the status alone for a reason it has no wording for', () => {
    expect(notifyMessage(refused('quota_mismatch', 409))).toBe('eagle-notify returned HTTP 409');
  });

  it.each(['constructor', 'toString', '__proto__', 'hasOwnProperty'])(
    'shows the status alone when the server code is the object member name %s',
    code => {
      expect(notifyMessage(refused(code, 500))).toBe('eagle-notify returned HTTP 500');
    },
  );
});
