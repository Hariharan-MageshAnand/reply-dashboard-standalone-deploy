import { describe, expect, it } from 'vitest';
import { buildGraphSyncPath } from './sync.service.js';

// The exclusion of old/non-inbox records is Graph's contract given correct
// request bounds — these tests pin the bounds themselves, which is what the
// prior defect was missing (no cutoff, no folder restriction).
describe('Microsoft Graph sync request bounds', () => {
  it('initial sync is inbox-only with an encoded 90-day receivedDateTime cutoff', () => {
    const now = new Date('2026-09-01T12:00:00.000Z');
    const path = buildGraphSyncPath('initial', now);

    expect(path.startsWith('/me/mailFolders/inbox/messages?')).toBe(true);
    // 90 days before `now`, ISO-formatted and URL-encoded inside $filter.
    expect(path).toContain(
      `$filter=${encodeURIComponent('receivedDateTime ge 2026-06-03T12:00:00.000Z')}`,
    );
    expect(path).toContain('$top=100');
    // Everything is URL-encoded — no raw spaces anywhere in the request path.
    expect(path).not.toContain(' ');
  });

  it('incremental sync stays mailbox-wide, newest first, no filter', () => {
    const path = buildGraphSyncPath('incremental');
    expect(path.startsWith('/me/messages?')).toBe(true);
    expect(path).toContain('$top=50');
    expect(path).not.toContain('$filter');
    expect(path).not.toContain(' ');
  });
});
