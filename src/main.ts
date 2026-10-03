import { join } from 'node:path';
import { getAssetKeys, isSea } from 'node:sea';
import { Store, stateDirectory, writePrivateJson, acquireStateLock } from './store.js';
import { WorkspaceService } from './workspace.js';
import { createApp } from './http.js';
import { DashboardBuildError, loadStaticAssets } from './static-assets.js';
import { initConsumerSkills } from './consumer-skills.js';
import { openDashboard } from './open-dashboard.js';

export async function runService(): Promise<void> {
  let release: (() => Promise<void>) | undefined;
  try {
    const skills = await initConsumerSkills();
    const assets = await loadStaticAssets();
    // SEA-only startup self-check (never a public route): proves the blob
    // readers served dashboard + skills in this boot. Source boots stay silent.
    if (isSea()) console.log(`OpenWorkspace SEA bundle: ${getAssetKeys().length} asset keys, ${assets.files.size} dashboard files, ${skills.length} skills.`);
    const store = new Store(stateDirectory());
    release = await acquireStateLock(store.directory);
    await store.initialize();
    const app = createApp(new WorkspaceService(store), { assets });
    const port = Number(process.env.OPENWORKSPACE_PORT || 4318);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid port.');
    const origin = await app.listen(port);
    try {
      await writePrivateJson(join(store.directory, 'connection.json'), { origin, mcpToken: app.mcpToken });
    } catch (error) {
      await app.close();
      throw error;
    }
    console.log(`OpenWorkspace is ready at ${origin}.`);
    const shutdown = async () => { await app.close(); await release?.(); process.exit(0); };
    process.once('SIGTERM', shutdown);
    process.once('SIGINT', shutdown);
    if (process.env.OPENWORKSPACE_NO_OPEN !== '1') openDashboard(origin);
  } catch (error) {
    await release?.();
    console.error(error instanceof DashboardBuildError
      ? error.message
      : 'OpenWorkspace could not start. Check state permissions, an existing service lock, Node version and port availability.');
    process.exitCode = 1;
  }
}

// Dual-entry guard: direct tsx invocation runs the runner; plain import is
// side-effect-free. Suffix comparison only — fileURLToPath(import.meta.url) is
// undefined under a CJS bundle and must never be used here.
const serviceEntry = process.argv[1] ?? '';
if (serviceEntry.endsWith('/main.ts') || serviceEntry.endsWith('\\main.ts') || serviceEntry === 'main.ts') {
  void runService();
}
