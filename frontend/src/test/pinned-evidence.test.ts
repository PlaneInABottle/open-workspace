import { describe, expect, it } from 'vitest';
import { buildTimeline } from '../features/records/timeline';
import type { RunListEntry } from '../api';

const workspaceId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function run(id: string, at: string, pinnedByNote: boolean): RunListEntry {
  return {
    id,
    workspaceId,
    scriptName: 'check',
    outcome: 'passed',
    durationMs: 120,
    at,
    failingNames: [],
    failingTruncated: false,
    excerptPreview: 'ok',
    excerptTruncated: false,
    outputTruncated: false,
    source: 'openworkspace-run',
    sourceLabel: 'Executed here — context-stamped',
    pinnedByNote,
  };
}

describe('pinned evidence correlation', () => {
  it('keeps note→run link flags on merged rows newest-first without rebuilding the merge', () => {
    const runs = [
      run('2000-new', '2026-10-02T00:04:00.000Z', true),
      run('1000-old', '2026-10-02T00:01:00.000Z', false),
    ];
    const rows = buildTimeline([], [], runs, workspaceId);
    expect(rows.map(row => row.run?.id)).toEqual(['2000-new', '1000-old']);
    expect(rows.map(row => row.run?.pinnedByNote)).toEqual([true, false]);
    expect(rows[0].kind).toBe('verify');
  });
});
