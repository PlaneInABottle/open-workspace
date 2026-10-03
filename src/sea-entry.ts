import { parseArgs } from 'node:util';
import { isSea } from 'node:sea';
import { runService } from './main.js';
import { runMcpBridge } from './mcp.js';

const usage = `OpenWorkspace local companion

Usage:
  openworkspace start [--state-directory <absolute-path>] [--port <number>] [--no-open]
  openworkspace mcp [--state-directory <absolute-path>]

Run this companion from any project directory. It never uses that project's package manager.
start: start the workspace service, not your project applications
mcp: start the stdio MCP bridge
--no-open: do not open a browser when starting the service

Source preview: requires the OpenWorkspace Node runtime and installed app dependencies.
End-user runtime bundling is planned; Java-only/Node-free installation is not released yet.`;

// CJS-safe entry (no top-level await, no import.meta): parses argv exactly like
// bin/openworkspace.mjs and invokes exactly one runner.
export async function runSeaEntry(argv = process.argv): Promise<void> {
  try {
    const { values, positionals } = parseArgs({
      args: argv.slice(2),
      allowPositionals: true,
      options: { 'state-directory': { type: 'string' }, port: { type: 'string' }, 'no-open': { type: 'boolean' }, help: { type: 'boolean', short: 'h' } },
    });
    if (values.help) { console.log(usage); return; }
    const command = positionals[0];
    if (positionals.length !== 1 || !['start', 'mcp'].includes(command)) throw new Error('Choose start or mcp.');
    if (values['state-directory'] && !values['state-directory'].startsWith('/')) throw new Error('State directory must be absolute.');
    if (values['no-open'] && command !== 'start') throw new Error('Use --no-open only with start.');
    if (values.port && (command !== 'start' || !/^\d+$/.test(values.port) || Number(values.port) < 1 || Number(values.port) > 65535)) {
      throw new Error('Use a valid port only with start.');
    }
    if (values['state-directory']) process.env.OPENWORKSPACE_HOME = values['state-directory'];
    if (values.port) process.env.OPENWORKSPACE_PORT = values.port;
    if (values['no-open']) process.env.OPENWORKSPACE_NO_OPEN = '1';
    if (command === 'start') await runService();
    else await runMcpBridge();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    console.error('Run openworkspace --help for usage. No project command was executed.');
    process.exitCode = 1;
  }
}

const entryScript = process.argv[1] ?? '';
if (isSea()) {
  // Inside the injected binary this module IS the entry point: argv[1] is
  // not a script path, so the filename guard below never fires. Dispatch
  // unconditionally — runSeaEntry parses user args from argv like node.
  void runSeaEntry();
} else if (entryScript.endsWith('sea-entry.ts') || entryScript.endsWith('sea-entry.cjs') || entryScript.endsWith('sea-entry.js')) {
  void runSeaEntry();
}
