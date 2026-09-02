import { describe, expect, it } from 'vitest';
import { CLEARABLE_FILTER_KEYS, hasActiveInboxFilters } from './InboxPage';

function clearAll(params: URLSearchParams): URLSearchParams {
  const next = new URLSearchParams(params);
  for (const key of CLEARABLE_FILTER_KEYS) next.delete(key);
  return next;
}

describe('Clear all filters', () => {
  it('clears the status view when invoked from Archived', () => {
    const params = new URLSearchParams('status=archived&unread=1');
    expect(hasActiveInboxFilters(params)).toBe(true);

    const cleared = clearAll(params);
    expect(cleared.get('status')).toBeNull();
    expect(cleared.toString()).toBe('');
    expect(hasActiveInboxFilters(cleared)).toBe(false);
  });

  it('treats Snoozed/Archived alone as an active filter (button stays visible)', () => {
    // The reported repro: after other filters were cleared, ?status=archived
    // remained but the control disappeared, leaving no way to escape.
    expect(hasActiveInboxFilters(new URLSearchParams('status=archived'))).toBe(true);
    expect(hasActiveInboxFilters(new URLSearchParams('status=snoozed'))).toBe(true);
  });

  it('the default open inbox has no active filters', () => {
    expect(hasActiveInboxFilters(new URLSearchParams())).toBe(false);
    expect(hasActiveInboxFilters(new URLSearchParams('status=open'))).toBe(false);
  });
});
