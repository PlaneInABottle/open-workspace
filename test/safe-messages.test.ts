// Phase A Step 2 rename-proof guard: safeMessages is composed from owner
// exports (no hand-copied literals), each message has exactly one definition
// site, and every remaining literal throw is explicitly classified.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { httpTransportMessages, safeMessages } from '../src/http.js';
import { projectRootMessages } from '../src/project-roots.js';
import { verifyMessages } from '../src/verify.js';
import { workspaceMessages } from '../src/workspace.js';
import {
  checkpointBoundsMessage,
  checkpointEvidenceMessage,
  checkpointPatternMessage,
  completionBoundsMessage,
  completionEvidenceMessage,
  completionIdConflictMessage,
  completionPatternMessage,
  unknownWorkstreamMessage,
  unknownWorkstreamStatusMessage,
  workspaceAccessMessage,
  workstreamCheckoutCountMessage,
  workstreamCheckoutRootMessage,
  workstreamLimitMessage,
  workstreamNameMessage,
  workstreamReopenMessage,
} from '../src/workstreams.js';
import { leaseMessages } from '../src/leases.js';
import { datastoreMessages } from '../src/datastore.js';
import { browserMessages } from '../src/browser.js';
import { dockerLogMessages, dockerMetadataMessages } from '../src/services-docker.js';
import { externalImportClaimMessage, externalImportInvalidMessage } from '../src/run-summaries.js';
import { learningMessages } from '../src/rule-index.js';
import { localToolCallMessages, localToolGateMessages } from '../src/local-tools.js';
import { environmentMessages } from '../src/environment.js';

const workstreamMessages: readonly string[] = [
  unknownWorkstreamMessage,
  unknownWorkstreamStatusMessage,
  workstreamReopenMessage,
  workspaceAccessMessage,
  workstreamLimitMessage,
  workstreamNameMessage,
  workstreamCheckoutCountMessage,
  workstreamCheckoutRootMessage,
  checkpointBoundsMessage,
  checkpointPatternMessage,
  checkpointEvidenceMessage,
  completionBoundsMessage,
  completionPatternMessage,
  completionEvidenceMessage,
  completionIdConflictMessage,
];

// Owner export groups mirroring the http.ts composition (order-independent:
// the assertion below compares sorted sets).
const ownerGroups: ReadonlyArray<{ file: string; values: readonly string[] }> = [
  { file: 'project-roots.ts', values: Object.values(projectRootMessages) },
  { file: 'workspace.ts', values: Object.values(workspaceMessages) },
  { file: 'verify.ts', values: Object.values(verifyMessages) },
  { file: 'workstreams.ts', values: workstreamMessages },
  { file: 'leases.ts', values: Object.values(leaseMessages) },
  { file: 'datastore.ts', values: Object.values(datastoreMessages) },
  { file: 'browser.ts', values: Object.values(browserMessages) },
  { file: 'services-docker.ts', values: Object.values(dockerMetadataMessages) },
  { file: 'run-summaries.ts', values: [externalImportInvalidMessage, externalImportClaimMessage] },
  { file: 'rule-index.ts', values: Object.values(learningMessages) },
  { file: 'local-tools.ts', values: [...Object.values(localToolGateMessages), ...Object.values(localToolCallMessages)] },
  { file: 'environment.ts', values: Object.values(environmentMessages) },
  { file: 'http.ts', values: Object.values(httpTransportMessages) },
];

const ownerUnion: string[] = ownerGroups.flatMap(group => [...group.values]);

test('safeMessages composes exactly the owner-export union (rename-proof)', () => {
  assert.equal(new Set(safeMessages).size, safeMessages.length, 'duplicate allowlist entry');
  assert.equal(new Set(ownerUnion).size, ownerUnion.length, 'message owned by two modules');
  assert.deepEqual([...safeMessages].sort(), [...ownerUnion].sort());
});

const srcDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const srcTexts = new Map(
  readdirSync(srcDir).filter(name => name.endsWith('.ts')).map(name => [name, readFileSync(join(srcDir, name), 'utf8')]),
);

// Two project-roots messages are computed templates, so the interpolated
// runtime value never appears verbatim in source; probe the template instead.
function definitionPresent(fileText: string, message: string): boolean {
  if (fileText.includes(message)) return true;
  if (message === projectRootMessages.tooMany) return fileText.includes('Select no more than ${maxProjectRoots}');
  if (message === projectRootMessages.badPath) {
    return fileText.includes('Each repository folder must be an absolute path of ${maxProjectRootLength}');
  }
  return false;
}

function literalThrowSites(message: string): string[] {
  const hits: string[] = [];
  for (const [name, text] of srcTexts) {
    if (text.includes(`throw new Error('${message}')`) || text.includes(`throw new Error("${message}")`)) hits.push(name);
  }
  return hits;
}

test('each allowlist message has one definition site and no literal throw site', () => {
  for (const { file, values } of ownerGroups) {
    const ownerText = srcTexts.get(file);
    assert.ok(ownerText, `owner source missing: ${file}`);
    for (const message of values) {
      assert.ok(definitionPresent(ownerText, message), `no definition site for ${JSON.stringify(message)} in ${file}`);
      assert.deepEqual(literalThrowSites(message), [], `literal throw site for ${JSON.stringify(message)}`);
    }
  }
});

// Literals intentionally outside the allowlist: internal validation,
// startup/persistence guards, and direct (non-throw) result bodies. Every
// `throw new Error('<literal>')` in src/ must be either allowlisted above or
// listed here — an unlisted literal fails the closed-world check below.
const outOfAllowlist: ReadonlyArray<{ file: string; message: string; reason: string }> = [
  { file: 'browser.ts', message: 'unshaped', reason: 'internal JSON-shape sentinel, always remapped to navFailed' },
  { file: 'connection.ts', message: 'Local connection must target the loopback service.', reason: 'companion-side guard, never thrown into the route catch' },
  { file: 'connection.ts', message: 'Local operation failed.', reason: 'client fallback default (expression throw), never allowlisted' },
  { file: 'dashboard-sessions.ts', message: 'Invalid dashboard session token source.', reason: 'server-constructed token invariant, surfaces as generic' },
  { file: 'discovery.ts', message: 'Package manifest is not a bounded regular file.', reason: 'manifest probe detail, surfaces as generic' },
  { file: 'http.ts', message: 'Operation could not complete safely. Check the directory and input, then retry.', reason: 'the generic fallback itself, not an allowlist entry' },
  { file: 'main.ts', message: 'Invalid port.', reason: 'CLI startup validation, process exits before serving' },
  { file: 'sea-entry.ts', message: 'Choose start or mcp.', reason: 'SEA CLI arg validation mirror of companion, exits before serving' },
  { file: 'sea-entry.ts', message: 'State directory must be absolute.', reason: 'SEA CLI arg validation mirror of companion, exits before serving' },
  { file: 'sea-entry.ts', message: 'Use --no-open only with start.', reason: 'SEA CLI arg validation mirror of companion, exits before serving' },
  { file: 'sea-entry.ts', message: 'Use a valid port only with start.', reason: 'SEA CLI arg validation mirror of companion, exits before serving' },
  { file: 'project-root-picker.ts', message: 'Invalid picker response.', reason: 'native picker protocol validation, surfaces as generic' },
  { file: 'project-root-picker.ts', message: 'Invalid picker roots.', reason: 'native picker protocol validation, surfaces as generic' },
  { file: 'services-docker.ts', message: 'Invalid Docker container IDs.', reason: 'internal spawn-output validation, surfaces as generic' },
  { file: 'services-docker.ts', message: 'Invalid Docker inspect result.', reason: 'internal spawn-output validation, surfaces as generic' },
  { file: 'services-docker.ts', message: 'Unexpected Docker container identity.', reason: 'internal spawn-output validation, surfaces as generic' },
  { file: 'services.ts', message: 'Invalid PM2 metadata.', reason: 'internal spawn-output validation, surfaces as generic' },
  { file: 'services.ts', message: 'Invalid PM2 cwd.', reason: 'internal spawn-output validation, surfaces as generic' },
  { file: 'store.ts', message: 'State directory ancestors must not be symlinks.', reason: 'startup/persistence guard, surfaces as generic' },
  { file: 'store.ts', message: 'State directory must be owned by you, private (0700), and not a symlink.', reason: 'startup/persistence guard, surfaces as generic' },
  { file: 'store.ts', message: 'Service lock ownership changed.', reason: 'startup/persistence guard, surfaces as generic' },
  { file: 'store.ts', message: 'Unsafe local state file.', reason: 'startup/persistence guard, surfaces as generic' },
  { file: 'store.ts', message: 'Private state exceeds the size limit.', reason: 'startup/persistence guard, surfaces as generic' },
  { file: 'store.ts', message: 'Unsafe local state destination.', reason: 'startup/persistence guard, surfaces as generic' },
  { file: 'store.ts', message: 'Local workspace state is invalid.', reason: 'fail-closed persistence guard, surfaces as generic' },
  // Direct (non-throw) result bodies that bypass the throw→allowlist path by design.
  { file: 'services-docker.ts', message: dockerLogMessages.logTimeout, reason: 'returned directly in log-result bodies, never thrown' },
  { file: 'services-docker.ts', message: dockerLogMessages.logInvalid, reason: 'returned directly in log-result bodies, never thrown' },
  { file: 'services-docker.ts', message: dockerLogMessages.logIncomplete, reason: 'returned directly in log-result bodies, never thrown' },
  { file: 'workspace.ts', message: 'This registered root is unavailable or its directory identity changed.', reason: 'per-root inspection payload field, not a thrown error' },
];

test('out-of-allowlist literals stay out, and no literal throw is unclassified', () => {
  for (const entry of outOfAllowlist) {
    assert.ok(!safeMessages.includes(entry.message), `must stay out of the allowlist: ${entry.message}`);
  }
  // Closed world: every pure-literal throw in src/ is classified above or allowlisted.
  const literalThrow = /throw new Error\(\s*(['"])(.*?)\1\s*\)/g;
  const found = new Set<string>();
  for (const text of srcTexts.values()) {
    for (const match of text.matchAll(literalThrow)) found.add(match[2]);
  }
  const classified = new Set([
    ...ownerUnion,
    ...outOfAllowlist.map(entry => entry.message),
  ]);
  for (const message of found) {
    assert.ok(classified.has(message), `unclassified literal throw: ${JSON.stringify(message)} (pin it to an owner export or record it above)`);
  }
});
