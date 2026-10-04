import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DashboardSessions, dashboardSessionAbsoluteCapMs, dashboardSessionLifetimeMs, maximumDashboardSessions } from '../src/dashboard-sessions.js';

test('dashboard sessions expire after a fixed 12 hours, revoke, and prune before enforcing capacity', () => {
  let now = 1_800_000_000_000;
  let tokenCounter = 0;
  const sessions = new DashboardSessions(() => now, () => (++tokenCounter).toString(16).padStart(64, '0'));
  const issued = Array.from({ length: maximumDashboardSessions }, () => sessions.issue());

  assert.ok(issued.every(session => session !== null));
  const first = issued[0]!;
  assert.equal(first.expiresAt, new Date(now + dashboardSessionLifetimeMs).toISOString());
  assert.equal(/^[a-f0-9]{64}$/.test(first.dashboardToken), true);
  assert.equal(sessions.issue(), null);

  now += dashboardSessionLifetimeMs - 1;
  assert.equal(sessions.isActive(first.dashboardToken), true);
  assert.equal(sessions.issue(), null);
  now++;
  assert.equal(sessions.isActive(first.dashboardToken), false);
  const afterExpiry = sessions.issue();
  assert.ok(afterExpiry);
  assert.equal(sessions.isActive(afterExpiry.dashboardToken), true);
  assert.equal(sessions.revoke(afterExpiry.dashboardToken), true);
  assert.equal(sessions.isActive(afterExpiry.dashboardToken), false);
  assert.equal(sessions.revoke(afterExpiry.dashboardToken), false);
});

test('dashboard session credentials are distinct from the MCP credential', () => {
  const mcpToken = 'a'.repeat(64);
  let calls = 0;
  const sessions = new DashboardSessions(() => 1_800_000_000_000, () => (++calls === 1 ? mcpToken : 'b'.repeat(64)));
  const issued = sessions.issue(mcpToken);
  assert.ok(issued);
  assert.equal(issued.dashboardToken === mcpToken, false);
  assert.equal(calls, 2);
});

test('sliding renewal keeps an active session alive but idle sessions still expire', () => {
  let now = 1_800_000_000_000;
  let tokenCounter = 0;
  const sessions = new DashboardSessions(() => now, () => (++tokenCounter).toString(16).padStart(64, '0'));
  const issued = sessions.issue();
  assert.ok(issued);

  // Activity just before the idle deadline renews the full window.
  now += dashboardSessionLifetimeMs - 1;
  assert.equal(sessions.touch(issued.dashboardToken), true);
  now += dashboardSessionLifetimeMs - 1;
  assert.equal(sessions.isActive(issued.dashboardToken), true);

  // Without further activity the renewed window still lapses.
  now += 1;
  assert.equal(sessions.touch(issued.dashboardToken), false);
  assert.equal(sessions.isActive(issued.dashboardToken), false);
});

test('renewal never exceeds the absolute session age and unknown tokens stay inactive', () => {
  let now = 1_800_000_000_000;
  let tokenCounter = 0;
  const sessions = new DashboardSessions(() => now, () => (++tokenCounter).toString(16).padStart(64, '0'));
  const issued = sessions.issue();
  assert.ok(issued);

  // Continuous activity up to the cap keeps the session alive ...
  for (let step = 0; step < 15; step++) {
    now += 11 * 60 * 60 * 1000;
    assert.equal(sessions.touch(issued.dashboardToken), true);
  }
  now = 1_800_000_000_000 + dashboardSessionAbsoluteCapMs - 1;
  assert.equal(sessions.touch(issued.dashboardToken), true);
  // ... but the absolute cap ends it even under activity.
  now += 1;
  assert.equal(sessions.touch(issued.dashboardToken), false);
  assert.equal(sessions.isActive(issued.dashboardToken), false);

  assert.equal(sessions.touch('c'.repeat(64)), false);
  assert.equal(sessions.revoke(issued.dashboardToken), false);
});
