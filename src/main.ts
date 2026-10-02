import { join } from 'node:path';
import { Store, stateDirectory, writePrivateJson, acquireStateLock } from './store.js';
import { WorkspaceService } from './workspace.js';
import { createApp } from './http.js';
import { DashboardBuildError, loadStaticAssets } from './static-assets.js';
import { openDashboard } from './open-dashboard.js';

let release: (() => Promise<void>) | undefined;
try {
  const assets = await loadStaticAssets();
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
