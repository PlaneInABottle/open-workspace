import { randomBytes } from 'node:crypto';

export const dashboardSessionLifetimeMs = 12 * 60 * 60 * 1000;
// Sliding-renewal bound: active use renews the 12h idle window, but no
// session outlives this absolute age (restart still invalidates everything,
// since sessions are in-memory only).
export const dashboardSessionAbsoluteCapMs = 7 * 24 * 60 * 60 * 1000;
export const maximumDashboardSessions = 8;

export interface IssuedDashboardSession {
  dashboardToken: string;
  expiresAt: string;
}

export class DashboardSessions {
  private readonly sessionsByToken = new Map<string, { expiresAt: number; issuedAt: number }>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly createToken: () => string = () => randomBytes(32).toString('hex'),
  ) {}

  issue(excludedToken?: string): IssuedDashboardSession | null {
    const now = this.now();
    this.pruneExpired(now);
    if (this.sessionsByToken.size >= maximumDashboardSessions) return null;

    let dashboardToken: string;
    do {
      dashboardToken = this.createToken();
    } while (this.sessionsByToken.has(dashboardToken) || dashboardToken === excludedToken);

    if (!/^[a-f0-9]{64}$/.test(dashboardToken)) throw new Error('Invalid dashboard session token source.');
    const expiry = now + dashboardSessionLifetimeMs;
    this.sessionsByToken.set(dashboardToken, { expiresAt: expiry, issuedAt: now });
    return { dashboardToken, expiresAt: new Date(expiry).toISOString() };
  }

  /**
   * Pure expiry check without renewal. Production auth uses touch(); this
   * stays for tests and fail-closed spot checks that must not extend the
   * idle window by observing it.
   */
  isActive(dashboardToken: string): boolean {
    const session = this.sessionsByToken.get(dashboardToken);
    if (session === undefined) return false;
    if (this.now() >= session.expiresAt) {
      this.sessionsByToken.delete(dashboardToken);
      return false;
    }
    return true;
  }

  /**
   * Sliding renewal for active use: an unexpired session's idle window
   * extends by the full lifetime, capped by the absolute session age. Pure
   * expiry semantics are unchanged — idle sessions still die, revoked and
   * unknown tokens stay inactive, and the fail-closed shape is preserved.
   */
  touch(dashboardToken: string): boolean {
    const session = this.sessionsByToken.get(dashboardToken);
    if (session === undefined) return false;
    const now = this.now();
    if (now >= session.expiresAt) {
      this.sessionsByToken.delete(dashboardToken);
      return false;
    }
    session.expiresAt = Math.min(now + dashboardSessionLifetimeMs, session.issuedAt + dashboardSessionAbsoluteCapMs);
    return true;
  }

  revoke(dashboardToken: string): boolean {
    return this.sessionsByToken.delete(dashboardToken);
  }

  private pruneExpired(now: number) {
    for (const [token, session] of this.sessionsByToken) {
      if (now >= session.expiresAt) this.sessionsByToken.delete(token);
    }
  }
}
