/**
 * Task-start signals (feedback-loops M1).
 *
 * Pure read-path helpers: numeric/timestamp/enum/name inputs only. This module
 * never opens a transcript, log tail, excerpt, or activity free-text field —
 * callers pass pre-filtered metadata (durations, timestamps, counts) and get
 * back an advisory value or undefined. Fail-closed throughout: any unusable
 * input yields undefined, never an error.
 */

import { median } from './run-summaries.js';

/** Newest-first passed-local window examined for a golden reference. */
export const goldenWindow = 20;
/** Priors required before a fast run counts as notable. */
export const goldenMinPriors = 5;
/** A run counts as notably fast at or below this fraction of the priors median. */
export const goldenFastRatio = 0.5;

/** Setup-to-verify span that earns one advisory line, in minutes. */
export const detourChainMinutes = 20;
/** Failed/errored count in the recent local window that earns one advisory line. */
export const detourFailCount = 3;
/** Recent local window for the fail-count trigger. */
export const detourFailWindow = 20;
/** Queued-lease wait that earns one advisory line, in minutes. */
export const detourLeaseMinutes = 10;

const msPerMinute = 60_000;

/**
 * Golden predicate over newest-first passed local durations: the newest run
 * is notably fast (at or below half the priors median) with enough priors to
 * trust the median. Returns the newest duration plus the median, else
 * undefined.
 */
export function evaluateGoldenSignal(durationsNewestFirst: number[]): { durationMs: number; medianMs: number } | undefined {
  const window = durationsNewestFirst.slice(0, goldenWindow);
  if (window.length < goldenMinPriors + 1) return undefined;
  const [latest, ...priors] = window;
  if (!Number.isFinite(latest) || latest < 0) return undefined;
  if (!priors.every(value => Number.isFinite(value) && value >= 0)) return undefined;
  const reference = median(priors);
  if (!(reference > 0)) return undefined;
  if (latest > goldenFastRatio * reference) return undefined;
  return { durationMs: latest, medianMs: reference };
}

/** Short human span for a verify duration: `45ms`, `~9s`, `~3 min`. */
export function formatShortDuration(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs < 0) return '~unknown';
  if (durationMs < 1000) return `${Math.round(durationMs)}ms`;
  if (durationMs < msPerMinute) return `~${Math.round(durationMs / 1000)}s`;
  return `~${Math.round(durationMs / msPerMinute)} min`;
}

/** Whole human minutes for a setup/wait span: `~22 min`. */
export function formatWholeMinutes(spanMs: number): string {
  return `~${Math.max(1, Math.round(spanMs / msPerMinute))} min`;
}

/**
 * One-line golden reference for a notably fast run. Shared rendering helper:
 * the read path returns the golden object and agents shape the mention from
 * it (see the new-task skill); this formatter keeps that wording identical
 * everywhere, including tests. Advisory wording only — the reader judges
 * whether the coming work is similar.
 */
export function buildGoldenLine(input: { scriptName: string; durationMs: number; envName: string | null }): string {
  const place = input.envName ? ` (${input.envName})` : '';
  return `Last time ${input.scriptName} took ${formatShortDuration(input.durationMs)}${place}.`;
}

export interface DetourInputs {
  /** Verify-pass time minus the preceding environment-up time; null when either side is missing. */
  chainMs: number | null;
  /** Failed/errored count among the recent local runs. */
  recentFails: number;
  /** This workstream's queued-lease wait; null when not queued. */
  leaseWaitMs: number | null;
}

function usableSpan(value: number | null): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * At most one advisory nudge, first firing wins in chain → fails → lease
 * order. Every line stays well under 200B and names a concrete next read
 * (never a verdict on the work). Fail-closed: unusable inputs stay silent.
 */
export function evaluateDetourSignal(input: DetourInputs): string | undefined {
  const chainMs = usableSpan(input.chainMs);
  if (chainMs !== null && chainMs >= detourChainMinutes * msPerMinute) {
    return `Setup in this workspace took ${formatWholeMinutes(chainMs)} before the last verify pass — consider running learn-from-mistake if setup repeats.`;
  }
  if (Number.isInteger(input.recentFails) && input.recentFails >= detourFailCount) {
    return `${input.recentFails} of the last ${detourFailWindow} local verification runs failed or errored — consider running learn-from-mistake.`;
  }
  const leaseWaitMs = usableSpan(input.leaseWaitMs);
  if (leaseWaitMs !== null && leaseWaitMs >= detourLeaseMinutes * msPerMinute) {
    return `This workstream waited ${formatWholeMinutes(leaseWaitMs)} for a shared resource — check the lease state before end-to-end checks.`;
  }
  return undefined;
}
