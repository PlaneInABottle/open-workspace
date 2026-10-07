import { describe, expect, it } from 'vitest';
import {
  formatChanges,
  formatCost,
  formatDurationMs,
  formatTime,
  formatTokens,
  isFailureOutcome,
  isOkOutcome,
  kindLabel,
  outcomeVariant,
  shortId,
} from './observer-labels';

describe('observer labels', () => {
  it('shortens session ids to 13 chars', () => {
    expect(shortId('ses_eeeab1762ffeJR5IHO8kcmOo1A')).toBe('ses_eeeab1762');
    expect(shortId('short')).toBe('short');
  });

  it('classifies outcomes', () => {
    expect(isFailureOutcome('failure')).toBe(true);
    expect(isFailureOutcome('error')).toBe(true);
    expect(isFailureOutcome('completed')).toBe(false);
    expect(isOkOutcome('completed')).toBe(true);
    expect(isOkOutcome('failure')).toBe(false);
    expect(outcomeVariant('failure')).toBe('destructive');
    expect(outcomeVariant('completed')).toBe('default');
    expect(outcomeVariant('unknown')).toBe('outline');
  });

  it('formats cost, tokens and changes honestly', () => {
    expect(formatCost(1.5)).toBe('$1.50');
    expect(formatCost(null)).toBe('—');
    expect(formatCost(NaN)).toBe('—');
    expect(formatTokens(null)).toBe('—');
    expect(formatTokens({ input: 1000, output: 50, reasoning: 0, cacheRead: 0, cacheWrite: 0 })).toContain('1,000');
    expect(formatChanges(null, null, null)).toBe('—');
    expect(formatChanges(3, 1, 2)).toBe('+3 −1 (2 files)');
  });

  it('formats durations and times', () => {
    expect(formatDurationMs(500)).toBe('500ms');
    expect(formatDurationMs(45_000)).toBe('45s');
    expect(formatDurationMs(90_000)).toBe('1m 30s');
    expect(formatTime(null)).toBe('—');
    expect(formatTime('not-a-date')).toBe('not-a-date');
  });

  it('labels record kinds', () => {
    expect(kindLabel('file-edit')).toBe('file edit');
    expect(kindLabel('tool-call')).toBe('tool');
    expect(kindLabel('shell')).toBe('shell');
  });
});
