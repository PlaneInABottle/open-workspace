import { randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { access, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { isIP } from 'node:net';
import { delimiter, isAbsolute, join } from 'node:path';
import { z } from 'zod';
import { boundedEnvironment, runBoundedCommand, verifyMessages, type CommandRunner } from './verify.js';

// Single-shot loopback text snapshot. One ephemeral agent-browser session per
// call: goto url, snapshot, read the final URL, then close. No profiles,
// screenshots, form-fill or multi-step orchestration in v1.
export const browserCheckTimeoutDefaultMs = 30_000;
export const browserCheckTimeoutMinMs = 5_000;
export const browserCheckTimeoutMaxMs = 60_000;
export const browserSocketTimeoutMs = 90_000;
export const browserOutputLimit = 64 * 1024;
export const browserSnapshotCap = 32 * 1024;
const browserCloseTimeoutMs = 10_000;

export const browserCheckSchema = z.object({
  url: z.string().min(1).max(2000),
  assertText: z.string().min(1).max(500).optional(),
  timeoutMs: z.number().int().min(browserCheckTimeoutMinMs).max(browserCheckTimeoutMaxMs).optional().default(browserCheckTimeoutDefaultMs),
}).strict();

export type BrowserCheckInput = z.infer<typeof browserCheckSchema>;

export interface BrowserCheckResult {
  ok: true;
  checkedAt: string;
  snapshotText: string;
  assertFound: boolean | null;
  durationMs: number;
  truncated: boolean;
}

export interface BrowserRunnerOptions {
  run?: CommandRunner;
  lookupHost?: (host: string) => Promise<string[]>;
  searchPath?: string;
  sessionId?: string;
}

async function defaultLookupHost(host: string): Promise<string[]> {
  return (await lookup(host, { all: true })).map(record => record.address);
}

function isLoopbackAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return address.startsWith('127.');
  if (family === 6) {
    const lower = address.toLowerCase();
    return lower === '::1' || lower === '::ffff:127.0.0.1' || /^::ffff:127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(lower);
  }
  return false;
}

// Every address a hostname resolves to must be loopback. A name that mixes
// loopback and public records is refused. DNS may change between this check
// and the browser navigation (rebind); that residual is documented, not
// bypassed — there is no allowlist flag.
async function requireLoopbackUrl(raw: string, lookupHost: (host: string) => Promise<string[]>): Promise<URL> {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(browserMessages.loopbackUrl);
  }
  if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || parsed.username || parsed.password) {
    throw new Error(browserMessages.loopbackUrl);
  }
  const host = parsed.hostname.replace(/^\[(.*)\]$/, '$1');
  if (!host) throw new Error(browserMessages.loopbackUrl);
  let addresses: string[];
  if (isIP(host)) {
    addresses = [host];
  } else {
    try {
      addresses = await lookupHost(host);
    } catch {
      throw new Error(browserMessages.loopbackUrl);
    }
  }
  if (!addresses.length || !addresses.every(isLoopbackAddress)) {
    throw new Error(browserMessages.loopbackUrl);
  }
  return parsed;
}

async function resolveAgentBrowser(searchPath: string): Promise<string | undefined> {
  for (const directory of searchPath.split(delimiter).filter(isAbsolute)) {
    const candidate = join(directory, 'agent-browser');
    try {
      if (!(await stat(candidate)).isFile()) continue;
      await access(candidate, constants.X_OK);
      return candidate;
    } catch { /* Availability is not runtime readiness. */ }
  }
  return undefined;
}

interface BatchEntry {
  command: unknown;
  error: unknown;
  result: unknown;
  success: unknown;
}

// Canonical browser-path messages. http.ts composes its allowlist from this
// object; the workspace-not-found throw below references verifyMessages
// instead (this module already imports verify.ts).
export const browserMessages = {
  loopbackUrl: 'Provide an http(s) loopback URL.',
  redirect: 'The page redirected outside loopback; refused.',
  unavailable: 'Browser check is unavailable.',
  timeout: 'The browser check did not finish within the bounded runtime.',
  navFailed: 'The browser navigation failed safely without a snapshot.',
} as const;

export async function runBrowserCheck(
  workspaceRoots: string[],
  raw: unknown,
  options: BrowserRunnerOptions = {},
): Promise<BrowserCheckResult> {
  const input = browserCheckSchema.parse(raw);
  if (!workspaceRoots.length || typeof workspaceRoots[0] !== 'string' || !workspaceRoots[0]) {
    throw new Error(verifyMessages.notFoundRegister);
  }
  const anchor = workspaceRoots[0];
  const lookupHost = options.lookupHost ?? defaultLookupHost;
  await requireLoopbackUrl(input.url, lookupHost);
  const binary = await resolveAgentBrowser(options.searchPath ?? process.env.PATH ?? '');
  if (!binary) throw new Error(browserMessages.unavailable);
  const run = options.run ?? runBoundedCommand;
  const sessionId = options.sessionId ?? `ow-${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  const startedAt = Date.now();
  const batchInput = JSON.stringify([['open', input.url], ['snapshot'], ['get', 'url']]);
  const env = boundedEnvironment();
  let outcome;
  try {
    outcome = await run(binary, ['--session', sessionId, 'batch', '--bail', '--json'], {
      cwd: anchor,
      timeoutMs: input.timeoutMs ?? browserCheckTimeoutDefaultMs,
      outputLimit: browserOutputLimit,
      env,
      input: batchInput,
    });
  } catch {
    throw new Error(browserMessages.unavailable);
  } finally {
    // Owned session cleanup is best-effort and never masks the check result.
    try {
      await run(binary, ['--session', sessionId, 'close'], {
        cwd: anchor,
        timeoutMs: browserCloseTimeoutMs,
        outputLimit: 4096,
        env,
      });
    } catch { /* The ephemeral session is already gone or closing. */ }
  }
  if (outcome.spawnFailed) throw new Error(browserMessages.unavailable);
  if (outcome.timedOut) throw new Error(browserMessages.timeout);
  if (outcome.exitCode !== 0) throw new Error(browserMessages.navFailed);
  let entries: BatchEntry[];
  try {
    const parsed: unknown = JSON.parse(outcome.stdout);
    if (!Array.isArray(parsed)) throw new Error('unshaped');
    entries = parsed as BatchEntry[];
  } catch {
    throw new Error(browserMessages.navFailed);
  }
  const opened = entries[0];
  if (!opened || !Array.isArray(opened.command) || opened.command[0] !== 'open' || opened.success !== true) {
    throw new Error(browserMessages.navFailed);
  }
  const snapshotEntry = entries.find(entry => Array.isArray(entry.command) && entry.command[0] === 'snapshot');
  const urlEntry = entries.find(entry => Array.isArray(entry.command) && entry.command[0] === 'get');
  const finalUrl = urlEntry && typeof urlEntry.result === 'object' && urlEntry.result !== null
    ? (urlEntry.result as { url?: unknown }).url
    : undefined;
  if (typeof finalUrl !== 'string') throw new Error(browserMessages.navFailed);
  // The browser may follow redirects, so the landed URL is re-required to be
  // loopback. Observed agent-browser 0.38.1 aborts server-side 302s instead
  // (leaving about:blank), which this check also refuses.
  try {
    await requireLoopbackUrl(finalUrl, lookupHost);
  } catch {
    throw new Error(browserMessages.redirect);
  }
  const snapshot = snapshotEntry && typeof snapshotEntry.result === 'object' && snapshotEntry.result !== null
    ? String((snapshotEntry.result as { snapshot?: unknown }).snapshot ?? '')
    : '';
  const truncated = outcome.truncated || snapshot.length > browserSnapshotCap;
  const snapshotText = snapshot.slice(0, browserSnapshotCap);
  return {
    ok: true,
    checkedAt: new Date().toISOString(),
    snapshotText,
    assertFound: input.assertText === undefined ? null : snapshotText.includes(input.assertText),
    durationMs: Date.now() - startedAt,
    truncated,
  };
}
