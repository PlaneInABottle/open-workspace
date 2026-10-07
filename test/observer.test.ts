// Observer surface: read-model units plus dashboard-role route/denial/bound
// coverage against synthetic fixtures (no real tokens, paths or excerpts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../src/http.js';
import { Store } from '../src/store.js';
import { WorkspaceService } from '../src/workspace.js';
import { fixtureStaticAssets } from './helpers/static-assets.js';
import {
  buildTree,
  classifyMessage,
  costTable,
  displayTitle,
  filterTools,
  globalMistakes,
  globalStuck,
  groupByTask,
  groupByTaskForSessions,
  joinSession,
  knownSessionIDs,
  listSessions,
  loadTreeRecords,
  maxSidecarBytes,
  observerMessages,
  parseSince,
  readDigest,
  readSidecarLines,
  resolveSessionPrefix,
  resolveSince,
  sessionBriefings,
  sessionChildCounts,
  sessionFirstPrompts,
  sessionMessageCounts,
  sessionMeta,
  sessionPrompts,
  signature,
  stuckReport,
  treeDetails,
} from '../src/observer.js';

const PARENT = 'ses_aaaaaaaaaaaaaaaaaaaaaaaa';
const CHILD = 'ses_bbbbbbbbbbbbbbbbbbbbbbbb';

function record(sessionID: string, fields: Record<string, unknown>) {
  return JSON.stringify({
    timestamp: '2026-10-06T10:00:00.000Z',
    sessionID,
    agent: 'implementer',
    workdir: '/tmp/fixture-alpha',
    outcome: 'completed',
    durationMs: 12,
    ...fields,
  });
}

async function writeLog(dir: string, lines: string[]): Promise<string> {
  const path = join(dir, 'shell-events.jsonl');
  await writeFile(path, lines.join('\n') + '\n');
  return path;
}

function writeDb(dir: string): string {
  const path = join(dir, 'opencode.db');
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE session_v2 (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, slug TEXT NOT NULL, directory TEXT, title TEXT,
    version TEXT NOT NULL, cost REAL DEFAULT 0 NOT NULL,
    tokens_input INTEGER DEFAULT 0 NOT NULL, tokens_output INTEGER DEFAULT 0 NOT NULL,
    tokens_reasoning INTEGER DEFAULT 0 NOT NULL, tokens_cache_read INTEGER DEFAULT 0 NOT NULL,
    tokens_cache_write INTEGER DEFAULT 0 NOT NULL,
    summary_additions INTEGER, summary_deletions INTEGER, summary_files INTEGER,
    parent_id TEXT, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL
  )`);
  db.exec(`CREATE TABLE session_message (
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL, type TEXT NOT NULL, seq INTEGER NOT NULL,
    time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL
  )`);
  const session = db.prepare(`INSERT INTO session_v2
    (id, project_id, slug, directory, title, version, cost, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write, summary_additions, summary_deletions, summary_files, parent_id, time_created, time_updated)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  session.run(PARENT, 'proj-1', 'parent-slug', '/tmp/fixture-alpha', 'Parent fixture', 'v1', 1.5, 100, 50, 5, 10, 2, 3, 1, 1, null, 1000, 2000);
  session.run(CHILD, 'proj-1', 'child-slug', '/tmp/fixture-alpha', 'Child fixture', 'v1', 0.5, 40, 20, 0, 0, 0, null, null, null, PARENT, 1100, 1900);
  const message = db.prepare(`INSERT INTO session_message
    (id, session_id, type, seq, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?, ?)`);
  message.run('msg-user-1', PARENT, 'user', 1, 1000, 1000, JSON.stringify({ text: 'Fix the failing check' }));
  message.run('msg-asst-1', PARENT, 'assistant', 2, 1001, 1001, JSON.stringify({
    content: [{ type: 'text', text: 'Running the check now' }],
    model: { id: 'fixture-model', providerID: 'fixture-provider' },
  }));
  message.run('msg-asst-2', PARENT, 'assistant', 3, 1002, 1002, JSON.stringify({
    content: [{ type: 'text', text: 'The run was interrupted, retrying' }],
  }));
  db.close();
  return path;
}

async function fixture(t: { after: (cleanup: () => void | Promise<void>) => void }) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'openworkspace-observer-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const logPath = await writeLog(root, [
    record(PARENT, { command: 'pnpm test', outcome: 'failure', exitCode: 1, excerpt: 'FAIL example.test.ts\nAssertion failed', messageID: 'msg-asst-1' }),
    record(PARENT, { command: 'pnpm test', outcome: 'failure', exitCode: 1, excerpt: 'FAIL example.test.ts\nAssertion failed', messageID: 'msg-asst-1' }),
    record(PARENT, { command: 'pnpm test', outcome: 'failure', exitCode: 1, excerpt: 'FAIL other.test.ts\nTimeout', messageID: 'msg-asst-1' }),
    record(PARENT, { kind: 'tool-call', tool: 'subagent', args: JSON.stringify({ agent: 'explore', sessionID: CHILD, description: 'explore fixtures' }), outcome: 'completed', messageID: 'msg-asst-1' }),
    record(PARENT, { kind: 'tool-call', tool: 'read', args: JSON.stringify({ path: '/tmp/fixture-alpha/a.ts', offset: 10, limit: 20 }), outcome: 'completed', messageID: 'msg-asst-1' }),
    record(PARENT, { kind: 'tool-call', tool: 'read', args: JSON.stringify({ path: '/tmp/fixture-alpha/a.ts', offset: 12, limit: 20 }), outcome: 'completed', messageID: 'msg-asst-1' }),
    record(PARENT, { kind: 'tool-call', tool: 'read', args: JSON.stringify({ path: '/tmp/fixture-alpha/a.ts', offset: 14, limit: 20 }), outcome: 'completed', messageID: 'msg-asst-1' }),
    record(CHILD, { command: 'git status', workdir: '/tmp/fixture-beta', outcome: 'completed', messageID: null }),
    record(CHILD, { kind: 'file-edit', path: '/tmp/fixture-beta/b.ts', outcome: 'completed', messageID: null }),
  ]);
  const dbPath = writeDb(root);
  const store = new Store(join(root, 'state'));
  await store.initialize();
  return { root, logPath, dbPath, service: new WorkspaceService(store) };
}

function withObserverEnv(logPath: string, dbPath: string) {
  const previousLog = process.env.OPENWORKSPACE_OBSERVER_LOG;
  const previousDb = process.env.OPENWORKSPACE_OBSERVER_DB;
  process.env.OPENWORKSPACE_OBSERVER_LOG = logPath;
  process.env.OPENWORKSPACE_OBSERVER_DB = dbPath;
  return () => {
    if (previousLog === undefined) delete process.env.OPENWORKSPACE_OBSERVER_LOG;
    else process.env.OPENWORKSPACE_OBSERVER_LOG = previousLog;
    if (previousDb === undefined) delete process.env.OPENWORKSPACE_OBSERVER_DB;
    else process.env.OPENWORKSPACE_OBSERVER_DB = previousDb;
  };
}

// Open loopback: the dashboard needs no token. MCP and unknown bearers stay
// denied on observer routes (dashboard-only reads).

test('observer read model: windows, signatures, grouping, stuck, reads', async t => {
  const f = await fixture(t);
  const restore = withObserverEnv(f.logPath, f.dbPath);
  t.after(restore);

  assert.equal(parseSince('30m'), 30 * 60_000);
  assert.equal(parseSince('1w'), 7 * 86_400_000);
  assert.equal(parseSince('nope'), null);
  assert.equal(resolveSince(''), 86_400_000);
  assert.throws(() => resolveSince('nope'), { message: observerMessages.badSince });
  assert.throws(() => resolveSince('2w'), { message: observerMessages.sinceTooWide });

  assert.equal(signature('pnpm test'), 'pnpm test');
  assert.equal(signature('uv run pytest tests/a.py tests/b.py'), 'uv run pytest');
  assert.equal(signature(''), 'unknown');
  assert.equal(signature('cd /Users/me/proj && pnpm typecheck:backend'), 'pnpm typecheck:backend');
  assert.equal(signature('cd /tmp\nls -la'), 'ls -la');

  const { sessions } = await listSessions({ sinceMs: 7 * 86_400_000, now: Date.parse('2026-10-07T00:00:00.000Z') });
  assert.equal(sessions.length, 2);
  const parent = sessions.find(entry => entry.sessionID === PARENT);
  assert.equal(parent?.commands, 7);
  assert.equal(parent?.fileEdits, 0);
  assert.equal(parent?.fails, 3);
  // Titles come from the session database join; rows stay usable without it.
  assert.equal(parent?.title, 'Parent fixture');

  // Directory filter is a substring match (mirrors the dashboard label):
  // 'ixture-alp' is contained in /tmp/fixture-alpha but is not a prefix.
  const contained = await listSessions({ dir: 'ixture-alp', sinceMs: 7 * 86_400_000, now: Date.parse('2026-10-07T00:00:00.000Z') });
  assert.equal(contained.sessions.length, 2);
  const noDir = await listSessions({ dir: 'no-such-dir', sinceMs: 7 * 86_400_000, now: Date.parse('2026-10-07T00:00:00.000Z') });
  assert.equal(noDir.sessions.length, 0);

  // Session prefix resolution: full ids pass through, displayed short ids
  // resolve, ambiguous prefixes and dead ends throw (never silent empty).
  assert.equal(resolveSessionPrefix(PARENT, [PARENT, CHILD]), PARENT);
  assert.equal(resolveSessionPrefix(PARENT.slice(0, 13), [PARENT, CHILD]), PARENT);
  assert.throws(() => resolveSessionPrefix('ses_', [PARENT, CHILD]), { message: observerMessages.ambiguousSession });
  assert.throws(() => resolveSessionPrefix('ses_zzzz', [PARENT, CHILD]), { message: observerMessages.noSessionMatch });
  assert.throws(() => resolveSessionPrefix('   ', [PARENT, CHILD]), { message: observerMessages.badSession });
  const known = await knownSessionIDs();
  assert.ok(known.includes(PARENT) && known.includes(CHILD));

  const { records } = await joinSession({ sessionID: PARENT });
  assert.equal(records.length, 7);
  assert.ok(records.every(entry => entry.taskRef === 'Fix the failing check'));
  assert.ok(records.every(entry => entry.model?.id === 'fixture-model'));

  const groups = groupByTask(records);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].taskRefKind, 'user');
  assert.equal(groups[0].taskRefAgent, 'implementer');
  const testLine = groups[0].lines.find(line => line.signature === 'pnpm test');
  assert.equal(testLine?.runs, 3);
  assert.equal(groups[0].fails, 3);

  const shellOnly = filterTools(records, 'shell');
  assert.ok(shellOnly.length > 0 && shellOnly.every(entry => typeof entry.command === 'string'));

  const report = await stuckReport({ records, sessionID: PARENT });
  assert.equal(report.retries.length, 1);
  assert.equal(report.retries[0].signature, 'pnpm test');
  assert.equal(report.retries[0].runs, 3);
  assert.equal(report.rereads.length, 1);
  assert.equal(report.rereads[0].depth, 3);

  const reads = readDigest(records);
  assert.equal(reads.length, 1);
  assert.equal(reads[0].reads, 3);
  assert.deepEqual(reads[0].ranges, ['10-30', '12-32', '14-34']);
});

test('message headers classify user instructions vs subagent briefings structurally', async t => {
  // classifyMessage never inspects wording: a literal "spawned subagent"
  // phrase with no session structure behind it is a plain user message.
  assert.equal(classifyMessage('Fix the failing check'), 'user');
  assert.equal(classifyMessage('You are a subagent spawned by another session'), 'user');
  assert.equal(classifyMessage(null), 'none');
  assert.equal(classifyMessage('   '), 'none');
  assert.equal(classifyMessage('(no task)'), 'none');

  const f = await fixture(t);
  const restore = withObserverEnv(f.logPath, f.dbPath);
  t.after(restore);

  // CHILD already carries parent_id = PARENT in the fixture db (see writeDb).
  // Every one of its user messages — with no special wording at all,
  // including a later continuation/resumption prompt — is structurally the
  // parent's briefing: the human never talks to a spawned session directly.
  // PARENT has no parent_id, so its own messages are never attributed as a
  // briefing no matter what they say.
  const briefingText = 'Explore the fixture tree and report what you find';
  const continuationText = 'Next milestone: tidy up the report you wrote';
  const briefDb = new DatabaseSync(f.dbPath);
  briefDb.prepare(`INSERT INTO session_message
    (id, session_id, type, seq, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run('msg-child-brief', CHILD, 'user', 1, 1000, 1000, JSON.stringify({ text: briefingText }));
  briefDb.prepare(`INSERT INTO session_message
    (id, session_id, type, seq, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run('msg-child-asst', CHILD, 'assistant', 2, 1001, 1001, JSON.stringify({
      content: [{ type: 'text', text: 'On it' }],
    }));
  // A later, same-session continuation prompt (no compaction in between) —
  // still from the parent, structurally indistinguishable in origin from
  // the opening message.
  briefDb.prepare(`INSERT INTO session_message
    (id, session_id, type, seq, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run('msg-child-brief-2', CHILD, 'user', 3, 1002, 1002, JSON.stringify({ text: continuationText }));
  briefDb.prepare(`INSERT INTO session_message
    (id, session_id, type, seq, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run('msg-child-asst-2', CHILD, 'assistant', 4, 1003, 1003, JSON.stringify({
      content: [{ type: 'text', text: 'Continuing' }],
    }));
  briefDb.prepare(`UPDATE session_v2 SET title = NULL WHERE id = ?`).run(CHILD);
  briefDb.close();

  // sessionBriefings: structural, DB-level — PARENT is excluded (no
  // parent_id) even though it also has a first user message. CHILD carries
  // both of its own user-row texts, not only the first.
  const db = new DatabaseSync(f.dbPath, { readOnly: true });
  t.after(() => db.close());
  const briefings = sessionBriefings(db as unknown as Parameters<typeof sessionBriefings>[0], [PARENT, CHILD]);
  assert.deepEqual([...briefings.keys()], [CHILD]);
  assert.deepEqual(briefings.get(CHILD), new Set([briefingText, continuationText]));

  // groupByTask: a taskRef matching any of the child's structural briefing
  // texts — including the later continuation prompt — groups as 'briefing'
  // (regardless of wording); the parent's unrelated taskRef stays 'user'.
  // Without a briefings map (default/no hints) the very same taskRefs never
  // classify as 'briefing' — there is nothing to match on text.
  const mixedRecords: Parameters<typeof groupByTask>[0] = [
    { sessionID: CHILD, agent: 'explore', command: 'git status', outcome: 'completed', intent: briefingText, taskRef: briefingText, model: null },
    { sessionID: CHILD, agent: 'explore', command: 'git log', outcome: 'completed', intent: continuationText, taskRef: continuationText, model: null },
    { sessionID: PARENT, agent: 'implementer', command: 'pnpm test', outcome: 'completed', intent: 'Fix the failing check', taskRef: 'Fix the failing check', model: null },
  ];
  const grouped = groupByTask(mixedRecords, briefings);
  const briefingGroup = grouped.find(g => g.taskRef === briefingText);
  const continuationGroup = grouped.find(g => g.taskRef === continuationText);
  const userGroup = grouped.find(g => g.taskRef === 'Fix the failing check');
  assert.equal(briefingGroup?.taskRefKind, 'briefing');
  assert.equal(briefingGroup?.taskRefAgent, 'explore');
  assert.equal(continuationGroup?.taskRefKind, 'briefing');
  assert.equal(userGroup?.taskRefKind, 'user');
  const ungrouped = groupByTask(mixedRecords);
  assert.equal(ungrouped.find(g => g.taskRef === briefingText)?.taskRefKind, 'user');
  assert.equal(ungrouped.find(g => g.taskRef === continuationText)?.taskRefKind, 'user');

  // groupByTaskForSessions resolves the briefings map itself from the db.
  const viaSessions = await groupByTaskForSessions(f.dbPath, mixedRecords);
  assert.equal(viaSessions.find(g => g.taskRef === briefingText)?.taskRefKind, 'briefing');
  assert.equal(viaSessions.find(g => g.taskRef === continuationText)?.taskRefKind, 'briefing');
  assert.equal(viaSessions.find(g => g.taskRef === 'Fix the failing check')?.taskRefKind, 'user');

  // The '(no task)' bucket carries no attribution.
  const empty = groupByTask([
    { sessionID: PARENT, command: 'git status', outcome: 'completed', intent: null, taskRef: null, model: null },
  ]);
  assert.equal(empty[0].taskRef, '(no task)');
  assert.equal(empty[0].taskRefKind, 'none');
  assert.equal(empty[0].taskRefAgent, null);

  // sessionPrompts: every one of the child's prompts is 'briefing' with no
  // special wording required; the parentless session's prompt stays 'user'.
  const childPrompts = await sessionPrompts({ sessionID: CHILD });
  assert.deepEqual(childPrompts, [
    { text: briefingText, kind: 'briefing' },
    { text: continuationText, kind: 'briefing' },
  ]);
  const parentPrompts = await sessionPrompts({ sessionID: PARENT });
  assert.deepEqual(parentPrompts, [{ text: 'Fix the failing check', kind: 'user' }]);

  // globalMistakes: a failure whose resolved taskRef byte-matches the
  // child's later continuation prompt (not its opening message) still
  // classifies as 'briefing'.
  await appendFile(f.logPath, `${record(CHILD, {
    command: 'pytest', outcome: 'failure', exitCode: 1, excerpt: 'FAIL', messageID: 'msg-child-asst-2',
  })}\n`);
  const { rows: mistakeRows } = await globalMistakes({
    sinceMs: 7 * 86_400_000, now: Date.parse('2026-10-07T00:00:00.000Z'), session: CHILD, limit: 10,
  });
  const childFailure = mistakeRows.find(row => row.signature === 'pytest');
  assert.equal(childFailure?.taskRef, continuationText);
  assert.equal(childFailure?.taskRefKind, 'briefing');

  // treeDetails: a prompt-fallback title on a spawned session inherits
  // 'briefing' structurally; the parent keeps its stored title ('other').
  const { by } = await loadTreeRecords({ sessionID: PARENT });
  const briefDetails = await treeDetails({ node: buildTree(PARENT, by), recordsBy: by });
  assert.equal(briefDetails.get(CHILD)?.titleKind, 'briefing');
  assert.equal(briefDetails.get(PARENT)?.titleKind, 'other');
});

test('sidecar tail read stays bounded: newest bytes win, callers warn on truncation', async t => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'openworkspace-sidecar-')));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const small = join(dir, 'small.jsonl');
  await writeFile(small, `${record(PARENT, { command: 'pnpm test' })}\n`);
  assert.deepEqual(await readSidecarLines(small), {
    lines: [record(PARENT, { command: 'pnpm test' })],
    truncated: false,
  });
  // A ring past the 8MB budget: only the newest window is read, the partial
  // head line is dropped, and newest records survive.
  const big = join(dir, 'big.jsonl');
  const newest = record(CHILD, { command: 'pnpm test:ui' });
  const filler = `{"sessionID":"ses_filler","padding":"${'x'.repeat(999)}"}\n`;
  // Whole filler lines past the budget (a real ring always ends lines with
  // \n); the byte window then cuts a head line, never the newest tail.
  const fillerLines = Math.ceil(maxSidecarBytes / Buffer.byteLength(filler, 'utf8')) + 10;
  await writeFile(big, filler.repeat(fillerLines));
  const { appendFile } = await import('node:fs/promises');
  await appendFile(big, `${newest}\n`);
  const tail = await readSidecarLines(big);
  assert.equal(tail.truncated, true);
  assert.ok(tail.lines.includes(newest), 'newest record survives the window');
  assert.ok(tail.lines.every(line => {
    try {
      JSON.parse(line);
      return true;
    } catch {
      return false;
    }
  }), 'every returned line is a whole record');
  // Callers surface the window cut instead of silently omitting history.
  const listed = await listSessions({ logPath: big, sinceMs: 7 * 86_400_000, now: Date.parse('2026-10-07T00:00:00.000Z') });
  assert.ok(listed.sessions.some(entry => entry.sessionID === CHILD));
  assert.ok(listed.warnings.some(warning => /truncated/.test(warning)));
});

test('session list titles fall back to prompt, workdir, short id, with child counts', async t => {
  const TITLELESS = 'ses_cccccccccccccccccccccccc';
  const WORKDIR_ONLY = 'ses_dddddddddddddddddddddddd';
  const ID_ONLY = 'ses_eeeeeeeeeeeeeeeeeeeeeeee';
  const root = await realpath(await mkdtemp(join(tmpdir(), 'openworkspace-observer-titles-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const logPath = await writeLog(root, [
    record(TITLELESS, { command: 'pnpm test', workdir: '/tmp/fixture-alpha' }),
    record(WORKDIR_ONLY, { command: 'git status', workdir: '/tmp/fixture-gamma/' }),
    record(ID_ONLY, { command: 'git status', workdir: undefined }),
  ]);
  const dbPath = join(root, 'opencode.db');
  const db = new DatabaseSync(dbPath);
  db.exec(`CREATE TABLE session_v2 (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, slug TEXT NOT NULL, directory TEXT, title TEXT,
    version TEXT NOT NULL, cost REAL DEFAULT 0 NOT NULL,
    tokens_input INTEGER DEFAULT 0 NOT NULL, tokens_output INTEGER DEFAULT 0 NOT NULL,
    tokens_reasoning INTEGER DEFAULT 0 NOT NULL, tokens_cache_read INTEGER DEFAULT 0 NOT NULL,
    tokens_cache_write INTEGER DEFAULT 0 NOT NULL,
    summary_additions INTEGER, summary_deletions INTEGER, summary_files INTEGER,
    parent_id TEXT, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL
  )`);
  db.exec(`CREATE TABLE session_message (
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL, type TEXT NOT NULL, seq INTEGER NOT NULL,
    time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL
  )`);
  const session = db.prepare(`INSERT INTO session_v2
    (id, project_id, slug, directory, title, version, parent_id, time_created, time_updated)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  // NULL title + opening prompt; empty-string title behaves the same.
  session.run(TITLELESS, 'proj-1', 'no-title', '/tmp/fixture-alpha', null, 'v1', null, 1000, 2000);
  session.run(WORKDIR_ONLY, 'proj-1', 'workdir-only', '/tmp/fixture-gamma', '', 'v1', TITLELESS, 1000, 2000);
  session.run(ID_ONLY, 'proj-1', 'id-only', '/tmp/fixture-alpha', null, 'v1', null, 1000, 2000);
  const message = db.prepare(`INSERT INTO session_message
    (id, session_id, type, seq, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?, ?)`);
  message.run('msg-titleless-1', TITLELESS, 'user', 1, 1000, 1000, JSON.stringify({
    text: 'Fix the leaky faucet\nin the kitchen sink before the weekend guests arrive with extra words to clip',
  }));
  message.run('msg-titleless-2', TITLELESS, 'assistant', 2, 1001, 1001, JSON.stringify({
    content: [{ type: 'text', text: 'On it' }],
  }));
  db.close();

  const prompts = await sessionFirstPrompts({ dbPath, sessionIDs: [TITLELESS, WORKDIR_ONLY, ID_ONLY] });
  assert.equal(prompts.get(TITLELESS), 'Fix the leaky faucet in the kitchen sink before the weekend guests arrive with e');
  assert.equal(prompts.has(WORKDIR_ONLY), false);
  assert.equal((prompts.get(TITLELESS) ?? '').length, 80);
  assert.ok(!(prompts.get(TITLELESS) ?? '').includes('\n'), 'prompt fallback is single-line');

  const children = await sessionChildCounts({ dbPath, sessionIDs: [TITLELESS, WORKDIR_ONLY, ID_ONLY] });
  assert.equal(children.get(TITLELESS), 1);
  assert.equal(children.get(WORKDIR_ONLY) ?? 0, 0);

  const { sessions, warnings } = await listSessions({
    logPath, dbPath, sinceMs: 7 * 86_400_000, now: Date.parse('2026-10-07T00:00:00.000Z'),
  });
  assert.deepEqual(warnings, []);
  const byId = new Map(sessions.map(entry => [entry.sessionID, entry]));
  assert.equal(byId.get(TITLELESS)?.title, prompts.get(TITLELESS));
  assert.equal(byId.get(TITLELESS)?.childCount, 1);
  assert.equal(byId.get(WORKDIR_ONLY)?.title, 'fixture-gamma');
  assert.equal(byId.get(WORKDIR_ONLY)?.childCount, 0);
  assert.equal(byId.get(ID_ONLY)?.title, ID_ONLY.slice(0, 13));
  assert.equal(byId.get(ID_ONLY)?.childCount, 0);

  // Pure chain: stored title wins, blank titles are skipped, then prompt,
  // then workdir basename, then short id.
  assert.equal(displayTitle({ sessionID: TITLELESS, title: 'Stored', prompt: 'Prompt', workdir: '/tmp/x' }), 'Stored');
  assert.equal(displayTitle({ sessionID: TITLELESS, title: '  ', prompt: 'Prompt', workdir: '/tmp/x' }), 'Prompt');
  assert.equal(displayTitle({ sessionID: TITLELESS, title: null, prompt: 'Prompt', workdir: '/tmp/x' }), 'Prompt');
  assert.equal(displayTitle({ sessionID: TITLELESS, title: null, prompt: null, workdir: '/tmp/trailing/' }), 'trailing');
  assert.equal(displayTitle({ sessionID: TITLELESS, title: null, prompt: null, workdir: null }), TITLELESS.slice(0, 13));
});

test('observer tree, meta, prompts, mistakes, cost', async t => {
  const f = await fixture(t);
  const restore = withObserverEnv(f.logPath, f.dbPath);
  t.after(restore);

  const tree = await loadTreeRecords({ sessionID: PARENT });
  assert.equal(tree.childCount, 1);
  assert.ok(tree.by.has(CHILD));
  const node = buildTree(PARENT, tree.by);
  assert.equal(node.children.length, 1);
  assert.equal(node.children[0].sessionID, CHILD);
  assert.equal(node.children[0].link?.agent, 'explore');

  const { meta, warning } = await sessionMeta({ sessionID: PARENT });
  assert.equal(warning, null);
  assert.equal(meta?.title, 'Parent fixture');
  assert.equal(meta?.cost, 1.5);
  assert.equal(meta?.tokens?.input, 100);
  assert.equal(meta?.userTurns, 1);
  assert.equal(meta?.assistantTurns, 2);
  const missing = await sessionMeta({ sessionID: 'ses_zzzzzzzzzzzzzzzzzzzz' });
  assert.equal(missing.meta, null);

  const prompts = await sessionPrompts({ sessionID: PARENT });
  assert.deepEqual(prompts, [{ text: 'Fix the failing check', kind: 'user' }]);

  const { rows } = await globalMistakes({ sinceMs: 7 * 86_400_000, now: Date.parse('2026-10-07T00:00:00.000Z'), limit: 10 });
  assert.equal(rows.length, 3);
  assert.ok(rows.every(row => row.sessionID === PARENT));
  assert.equal(rows[0].signature, 'pnpm test');
  assert.equal(rows[0].taskRef, 'Fix the failing check');
  assert.equal(rows[0].taskRefKind, 'user');

  const { entries } = await globalStuck({ sinceMs: 7 * 86_400_000, now: Date.parse('2026-10-07T00:00:00.000Z') });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].session, PARENT);

  const cost = await costTable({ sinceMs: 7 * 86_400_000, now: Date.parse('2026-10-07T00:00:00.000Z'), limit: 10 });
  assert.equal(cost.rows.length, 2);
  assert.equal(cost.rows[0].sessionID, PARENT);
  assert.equal(cost.rows[0].cost, 1.5);
});

test('observer tree details resolve titles, agents, counts and orphan flags', async t => {
  const f = await fixture(t);
  const restore = withObserverEnv(f.logPath, f.dbPath);
  t.after(restore);

  const { by, parentLinked } = await loadTreeRecords({ sessionID: PARENT });
  assert.ok(parentLinked.includes(CHILD), 'DB parent_id walk explains the child');

  // Drop the spawn tool-call so the child is parent-linked with no spawn note.
  const parentRecords = (by.get(PARENT) ?? []).filter(record => record.tool !== 'subagent');
  assert.ok(parentRecords.length > 0);
  const ORPHAN = 'ses_oooooooooooooooooooooooo';
  const recordsBy = new Map(by);
  recordsBy.set(PARENT, parentRecords);
  recordsBy.set(ORPHAN, [{
    sessionID: ORPHAN,
    timestamp: '2026-10-06T10:00:00.000Z',
    agent: 'implementer',
    workdir: '/tmp/fixture-gamma',
    command: 'git status',
    outcome: 'completed',
    intent: null,
    taskRef: null,
    model: null,
  }]);

  const root = buildTree(PARENT, recordsBy, new Set(parentLinked));
  assert.equal(root.children.length, 2);
  const linked = root.children.find(node => node.sessionID === CHILD);
  const orphan = root.children.find(node => node.sessionID === ORPHAN);
  assert.equal(linked?.link, null);
  assert.equal(linked?.orphan, false);
  assert.equal(orphan?.link, null);
  assert.equal(orphan?.orphan, true);

  const details = await treeDetails({ node: root, recordsBy });
  assert.equal(details.get(CHILD)?.title, 'Child fixture');
  assert.equal(details.get(CHILD)?.titleKind, 'other');
  assert.equal(details.get(CHILD)?.agent, 'implementer');
  assert.equal(details.get(CHILD)?.records, 2);
  assert.equal(details.get(CHILD)?.hasMessages, false);
  assert.equal(details.get(ORPHAN)?.title, 'fixture-gamma');
  assert.equal(details.get(ORPHAN)?.titleKind, 'other');
  assert.equal(details.get(ORPHAN)?.agent, 'implementer');
  assert.equal(details.get(ORPHAN)?.records, 1);
  assert.equal(details.get(ORPHAN)?.hasMessages, false);

  const { treeIds } = await import('../src/observer.js');
  const ids = treeIds(root, details);
  const linkedIds = ids.children.find(node => node.sessionID === CHILD);
  const orphanIds = ids.children.find(node => node.sessionID === ORPHAN);
  assert.equal(linkedIds?.detail.title, 'Child fixture');
  assert.equal(linkedIds?.detail.records, 2);
  assert.equal(linkedIds?.detail.orphan, false);
  assert.equal(orphanIds?.detail.orphan, true);
});

test('observer tree details distinguish pre-recording children from empty sessions', async t => {
  const PRE = 'ses_pppppppppppppppppppppppp';
  const EMPTY = 'ses_qqqqqqqqqqqqqqqqqqqqqqqq';
  const root = await realpath(await mkdtemp(join(tmpdir(), 'openworkspace-observer-prerec-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dbPath = join(root, 'opencode.db');
  const db = new DatabaseSync(dbPath);
  db.exec(`CREATE TABLE session_v2 (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, slug TEXT NOT NULL, directory TEXT, title TEXT,
    version TEXT NOT NULL, cost REAL DEFAULT 0 NOT NULL,
    tokens_input INTEGER DEFAULT 0 NOT NULL, tokens_output INTEGER DEFAULT 0 NOT NULL,
    tokens_reasoning INTEGER DEFAULT 0 NOT NULL, tokens_cache_read INTEGER DEFAULT 0 NOT NULL,
    tokens_cache_write INTEGER DEFAULT 0 NOT NULL,
    summary_additions INTEGER, summary_deletions INTEGER, summary_files INTEGER,
    parent_id TEXT, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL
  )`);
  db.exec(`CREATE TABLE session_message (
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL, type TEXT NOT NULL, seq INTEGER NOT NULL,
    time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL
  )`);
  const session = db.prepare(`INSERT INTO session_v2
    (id, project_id, slug, directory, title, version, parent_id, time_created, time_updated)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  session.run(PARENT, 'proj-1', 'parent', '/tmp/fixture-alpha', 'Parent fixture', 'v1', null, 1000, 2000);
  session.run(PRE, 'proj-1', 'pre', '/tmp/fixture-alpha', 'Verify workspace dashboard flow', 'v1', PARENT, 1100, 1900);
  session.run(EMPTY, 'proj-1', 'empty', '/tmp/fixture-alpha', null, 'v1', PARENT, 1100, 1900);
  const message = db.prepare(`INSERT INTO session_message
    (id, session_id, type, seq, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?, ?)`);
  // Pre-recording child: real old work in session_message but no sidecar rows.
  message.run('msg-pre-1', PRE, 'user', 1, 1100, 1100, JSON.stringify({ text: 'Old work before recording' }));
  message.run('msg-pre-2', PRE, 'assistant', 2, 1101, 1101, JSON.stringify({
    content: [{ type: 'text', text: 'Did the old thing' }],
  }));
  db.close();

  const counts = await sessionMessageCounts({ dbPath, sessionIDs: [PARENT, PRE, EMPTY] });
  assert.equal(counts.get(PRE), 2);
  assert.equal(counts.has(EMPTY), false);
  assert.equal(counts.has(PARENT), false);

  const node = {
    sessionID: PARENT,
    link: null,
    orphan: false,
    children: [
      { sessionID: PRE, link: null, orphan: false, children: [] },
      { sessionID: EMPTY, link: null, orphan: false, children: [] },
    ],
  };
  // Neither child has sidecar records in this window.
  const recordsBy = new Map([[PARENT, []], [PRE, []], [EMPTY, []]]);
  const details = await treeDetails({ dbPath, node, recordsBy });
  assert.equal(details.get(PRE)?.records, 0);
  assert.equal(details.get(PRE)?.hasMessages, true);
  assert.equal(details.get(EMPTY)?.records, 0);
  assert.equal(details.get(EMPTY)?.hasMessages, false);

  const { treeIds: toIds } = await import('../src/observer.js');
  const ids = toIds(node, details);
  assert.equal(ids.children.find(entry => entry.sessionID === PRE)?.detail.hasMessages, true);
  assert.equal(ids.children.find(entry => entry.sessionID === EMPTY)?.detail.hasMessages, false);

  // Missing database degrades honestly: no message presence claimed.
  const missing = await treeDetails({ dbPath: join(root, 'no-db.db'), node, recordsBy });
  assert.equal(missing.get(PRE)?.hasMessages, false);
});

test('observer routes serve envelopes with warnings on the dashboard role', async t => {
  const f = await fixture(t);
  const restore = withObserverEnv(f.logPath, f.dbPath);
  t.after(restore);
  const app = createApp(f.service, { mcpToken: '0123456789abcdef'.repeat(4), assets: fixtureStaticAssets() });
  const origin = await app.listen(0);
  t.after(() => app.close());
  const auth = {};

  for (const path of ['/api/observer/doctor', '/api/observer/sessions', '/api/observer/mistakes', '/api/observer/stuck', '/api/observer/cost']) {
    const response = await fetch(`${origin}${path}?since=1w`, { headers: auth });
    assert.equal(response.status, 200, path);
    const body = await response.json() as Record<string, unknown>;
    assert.ok(Array.isArray(body.warnings), `${path} returns warnings[]`);
  }
  const picker = await (await fetch(`${origin}/api/observer/sessions?since=1w`, { headers: auth })).json() as { sessions: { sessionID: string }[] };
  assert.equal(picker.sessions.length, 2);

  const meta = await (await fetch(`${origin}/api/observer/sessions/${PARENT}/meta`, { headers: auth })).json() as { meta: { title: string } | null };
  assert.equal(meta.meta?.title, 'Parent fixture');

  const records = await (await fetch(`${origin}/api/observer/sessions/${PARENT}/records?since=1w&tree=1`, { headers: auth })).json() as {
    groups: unknown[]; tree: { children: { detail: { title: string; agent: string | null; records: number; orphan: boolean } }[] } | undefined; warnings: unknown[];
  };
  assert.ok(Array.isArray(records.groups));
  assert.equal(records.tree?.children.length, 1);
  assert.equal(records.tree?.children[0].detail.title, 'Child fixture');
  assert.equal(records.tree?.children[0].detail.agent, 'explore');
  assert.equal(records.tree?.children[0].detail.records, 2);
  assert.equal(records.tree?.children[0].detail.orphan, false);

  const fails = await (await fetch(`${origin}/api/observer/sessions/${PARENT}/records?since=1w&failsOnly=1`, { headers: auth })).json() as {
    groups: { lines: { outcome: string }[] }[];
  };
  assert.ok(fails.groups.length > 0);
  assert.ok(fails.groups.every(group => group.lines.every(line => line.outcome === 'failure' || line.outcome === 'error')));

  const stuck = await (await fetch(`${origin}/api/observer/sessions/${PARENT}/stuck?since=1w`, { headers: auth })).json() as {
    report: { retries: unknown[] };
  };
  assert.equal(stuck.report.retries.length, 1);

  const prompts = await (await fetch(`${origin}/api/observer/sessions/${PARENT}/prompts`, { headers: auth })).json() as { session: string; prompts: { text: string; kind: string }[] };
  assert.deepEqual(prompts.prompts, [{ text: 'Fix the failing check', kind: 'user' }]);

  const reads = await (await fetch(`${origin}/api/observer/sessions/${PARENT}/reads?since=1w`, { headers: auth })).json() as { reads: unknown[] };
  assert.equal(reads.reads.length, 1);
});

test('observer mistakes accept displayed short ids and reject dead ends loudly', async t => {
  const f = await fixture(t);
  const restore = withObserverEnv(f.logPath, f.dbPath);
  t.after(restore);
  const app = createApp(f.service, { mcpToken: '0123456789abcdef'.repeat(4), assets: fixtureStaticAssets() });
  const origin = await app.listen(0);
  t.after(() => app.close());
  const auth = {};

  const short = PARENT.slice(0, 13);
  const prefixed = await (await fetch(`${origin}/api/observer/mistakes?since=1w&session=${short}`, { headers: auth })).json() as { rows: { sessionID: string }[] };
  assert.equal(prefixed.rows.length, 3);
  assert.ok(prefixed.rows.every(row => row.sessionID === PARENT));

  const full = await (await fetch(`${origin}/api/observer/mistakes?since=1w&session=${PARENT}`, { headers: auth })).json() as { rows: unknown[] };
  assert.equal(full.rows.length, 3);

  // 'ses_' prefixes both fixture sessions: ambiguous, not a silent empty.
  const ambiguous = await fetch(`${origin}/api/observer/mistakes?since=1w&session=ses_`, { headers: auth });
  assert.equal(ambiguous.status, 400);
  assert.equal((await ambiguous.json() as { error: string }).error, observerMessages.ambiguousSession);

  // Well-formed but never observed: dead end, not an empty feed.
  const deadEnd = await fetch(`${origin}/api/observer/mistakes?since=1w&session=ses_zzzzzzzzzzzzzzzzzzzz`, { headers: auth });
  assert.equal(deadEnd.status, 400);
  assert.equal((await deadEnd.json() as { error: string }).error, observerMessages.noSessionMatch);

  // Garbage that is neither a full id nor a known prefix.
  const garbage = await fetch(`${origin}/api/observer/mistakes?since=1w&session=nope`, { headers: auth });
  assert.equal(garbage.status, 400);
  assert.equal((await garbage.json() as { error: string }).error, observerMessages.noSessionMatch);
});

test('observer routes deny MCP and unknown bearers, allow open loopback, and validate input', async t => {
  const f = await fixture(t);
  const restore = withObserverEnv(f.logPath, f.dbPath);
  t.after(restore);
  const mcpToken = '0123456789abcdef'.repeat(4);
  const app = createApp(f.service, { mcpToken, assets: fixtureStaticAssets() });
  const origin = await app.listen(0);
  t.after(() => app.close());
  const dashboard = {};
  const mcp = { Authorization: `Bearer ${mcpToken}` };
  const unknown = { Authorization: `Bearer ${'e'.repeat(64)}` };

  assert.equal((await fetch(`${origin}/api/observer/doctor`)).status, 200);
  assert.equal((await fetch(`${origin}/api/observer/sessions?since=1w`, { headers: mcp })).status, 403);
  assert.equal((await fetch(`${origin}/api/observer/sessions/${PARENT}/meta`, { headers: mcp })).status, 403);
  assert.equal((await fetch(`${origin}/api/observer/cost?since=1w`, { headers: mcp })).status, 403);
  assert.equal((await fetch(`${origin}/api/observer/doctor`, { headers: unknown })).status, 401);

  assert.equal((await fetch(`${origin}/api/observer/sessions?since=nope`, { headers: dashboard })).status, 400);
  assert.equal((await fetch(`${origin}/api/observer/sessions?since=2w`, { headers: dashboard })).status, 400);
  assert.equal((await fetch(`${origin}/api/observer/sessions/not-a-session/meta`, { headers: dashboard })).status, 400);
  assert.equal((await fetch(`${origin}/api/observer/sessions/${PARENT}/records?kind=bogus`, { headers: dashboard })).status, 400);
  assert.equal((await fetch(`${origin}/api/observer/cost?limit=500`, { headers: dashboard })).status, 400);
});

test('observer degrades honestly when the log and db are missing', async t => {
  const f = await fixture(t);
  const restore = withObserverEnv(join(f.root, 'no-log.jsonl'), join(f.root, 'no-db.db'));
  t.after(restore);
  const app = createApp(f.service, { mcpToken: '0123456789abcdef'.repeat(4), assets: fixtureStaticAssets() });
  const origin = await app.listen(0);
  t.after(() => app.close());
  const auth = {};

  const picker = await (await fetch(`${origin}/api/observer/sessions`, { headers: auth })).json() as { sessions: unknown[]; warnings: string[] };
  assert.equal(picker.sessions.length, 0);
  assert.deepEqual(picker.warnings, ['observer not enabled on this machine']);

  const meta = await (await fetch(`${origin}/api/observer/sessions/${PARENT}/meta`, { headers: auth })).json() as { meta: null; warnings: string[] };
  assert.equal(meta.meta, null);
  assert.ok(meta.warnings.length > 0);

  const model = await import('../src/observer.js');
  assert.deepEqual((await model.listSessions({ logPath: join(f.root, 'no-log.jsonl') })).warnings, ['observer not enabled on this machine']);
});
