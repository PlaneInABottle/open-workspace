import { randomBytes } from 'node:crypto';

export const dashboardSessionLifetimeMs = 12 * 60 * 60 * 1000;
export const maximumDashboardSessions = 8;

export interface IssuedDashboardSession {
  dashboardToken: string;
  expiresAt: string;
}

export class DashboardSessions {
  private readonly expiryByToken = new Map<string, number>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly createToken: () => string = () => randomBytes(32).toString('hex'),
  ) {}

  issue(excludedToken?: string): IssuedDashboardSession | null {
    const now = this.now();
    this.pruneExpired(now);
    if (this.expiryByToken.size >= maximumDashboardSessions) return null;

    let dashboardToken: string;
    do {
      dashboardToken = this.createToken();
    } while (this.expiryByToken.has(dashboardToken) || dashboardToken === excludedToken);

    if (!/^[a-f0-9]{64}$/.test(dashboardToken)) throw new Error('Invalid dashboard session token source.');
    const expiry = now + dashboardSessionLifetimeMs;
    this.expiryByToken.set(dashboardToken, expiry);
    return { dashboardToken, expiresAt: new Date(expiry).toISOString() };
  }

  isActive(dashboardToken: string): boolean {
    const expiry = this.expiryByToken.get(dashboardToken);
    if (expiry === undefined) return false;
    if (this.now() >= expiry) {
      this.expiryByToken.delete(dashboardToken);
      return false;
    }
    return true;
  }

  revoke(dashboardToken: string): boolean {
    return this.expiryByToken.delete(dashboardToken);
  }

  private pruneExpired(now: number) {
    for (const [token, expiry] of this.expiryByToken) {
      if (now >= expiry) this.expiryByToken.delete(token);
    }
  }
}
