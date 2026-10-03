// Compiled executable allowlist: human-extended source only, never agent
// writable. v1 holds exactly one class. Agents name the class in declarations;
// the class owns the binary name and the probe. Every argv vector is built by
// runDatastoreQuery itself via the shared psqlArgs construction with no
// socketDir/port, so -h/-p never enter a tool argv and class and spawn cannot
// drift (G2 asserts psqlArgs output plus the actual spawn argv directly).
export const localToolSocketTimeoutMs = 40_000;
export const localToolProbeTimeoutMs = 5_000;

export interface LocalToolClass {
  /** Kebab-case class name referenced by declarations. */
  name: string;
  /** Binary basename owned by this class; resolved to a canonical absolute path. */
  binary: string;
  /** Exact slot names and kinds a declaration must carry — no more, no fewer. */
  slotSpec: Record<string, 'identifier'>;
  /** Probe argv appended after the canonical binary (binary viability only). */
  probeArgs: string[];
  /** Class-owned constants; never declarable. */
  timeoutMs: number;
  outputLimit: number;
  socketTimeoutMs: number;
  socketOnly: true;
}

const psqlFixedSelect: LocalToolClass = {
  name: 'psql-fixed-select',
  binary: 'psql',
  slotSpec: { database: 'identifier', role: 'identifier' },
  probeArgs: ['--version'],
  timeoutMs: 15_000,
  outputLimit: 64 * 1024,
  socketTimeoutMs: localToolSocketTimeoutMs,
  socketOnly: true,
};

export const localToolClasses: Record<string, LocalToolClass> = {
  'psql-fixed-select': psqlFixedSelect,
};
