import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { trustedSystemPath } from './trusted-system.js';

type SpawnChild = Pick<ChildProcess, 'once' | 'unref'>;
type SpawnFunction = (command: string, args: string[], options: SpawnOptions) => SpawnChild;

const linuxSystemPath = '/usr/bin:/bin';
const linuxDesktopEnvironment = [
  'DISPLAY',
  'WAYLAND_DISPLAY',
  'XAUTHORITY',
  'DBUS_SESSION_BUS_ADDRESS',
  'XDG_RUNTIME_DIR',
  'XDG_CURRENT_DESKTOP',
  'XDG_SESSION_TYPE',
  'XDG_SESSION_DESKTOP',
];

export interface DashboardOpenerOptions {
  platform?: NodeJS.Platform;
  spawn?: SpawnFunction;
  warn?: (message: string) => void;
}

export function buildDashboardOpenerEnvironment(platform: NodeJS.Platform, source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  if (platform !== 'linux') return {};
  const env: NodeJS.ProcessEnv = { PATH: linuxSystemPath };
  for (const key of linuxDesktopEnvironment) {
    const value = source[key];
    if (value && !value.includes('\0')) env[key] = value;
  }
  return env;
}

function trustedOpener(platform: NodeJS.Platform): string | undefined {
  if (platform === 'darwin') return trustedSystemPath('/usr/bin/open', 'file');
  if (platform !== 'linux') return undefined;
  if (!trustedSystemPath('/usr/bin', 'directory') || !trustedSystemPath('/bin', 'directory')) return undefined;
  return trustedSystemPath('/usr/bin/xdg-open', 'file');
}

export function openDashboard(origin: string, options: DashboardOpenerOptions = {}): boolean {
  let dashboardUrl: URL;
  try {
    dashboardUrl = new URL(origin);
  } catch {
    warnFailure(options.warn);
    return false;
  }

  if (dashboardUrl.origin !== origin || dashboardUrl.protocol !== 'http:'
    || dashboardUrl.hostname !== '127.0.0.1' || !dashboardUrl.port
    || dashboardUrl.pathname !== '/' || dashboardUrl.search || dashboardUrl.hash) {
    warnFailure(options.warn);
    return false;
  }

  const platform = options.platform ?? process.platform;
  const executable = trustedOpener(platform);
  if (!executable) {
    warnFailure(options.warn, origin);
    return false;
  }

  try {
    const child = (options.spawn ?? spawn as SpawnFunction)(executable, [origin], {
      shell: false,
      detached: true,
      stdio: 'ignore',
      env: buildDashboardOpenerEnvironment(platform),
    });
    let failureReported = false;
    const reportFailure = () => {
      if (failureReported) return;
      failureReported = true;
      warnFailure(options.warn, origin);
    };
    child.once('error', reportFailure);
    child.once('exit', (code, signal) => {
      if (code !== 0 || signal !== null) reportFailure();
    });
    child.unref();
    return true;
  } catch {
    warnFailure(options.warn, origin);
    return false;
  }
}

function warnFailure(warn: DashboardOpenerOptions['warn'], origin?: string) {
  const target = origin ? ` ${origin}` : '';
  (warn ?? console.warn)(`OpenWorkspace could not safely open${target} automatically. Open the dashboard URL manually.`);
}
