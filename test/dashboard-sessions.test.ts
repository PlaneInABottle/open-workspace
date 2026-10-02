import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DashboardSessions, dashboardSessionLifetimeMs, maximumDashboardSessions } from '../src/dashboard-sessions.js';

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
