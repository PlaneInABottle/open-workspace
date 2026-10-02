#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

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

try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { 'state-directory': { type: 'string' }, port: { type: 'string' }, 'no-open': { type: 'boolean' }, help: { type: 'boolean', short: 'h' } },
  });
  if (values.help) { console.log(usage); }
  else {
    const command = positionals[0];
    if (positionals.length !== 1 || !['start', 'mcp'].includes(command)) throw new Error('Choose start or mcp.');
    if (values['state-directory'] && !values['state-directory'].startsWith('/')) throw new Error('State directory must be absolute.');
    if (values['no-open'] && command !== 'start') throw new Error('Use --no-open only with start.');
    if (values.port && (command !== 'start' || !/^\d+$/.test(values.port) || Number(values.port) < 1 || Number(values.port) > 65535)) {
      throw new Error('Use a valid port only with start.');
    }
    const file = command === 'start' ? 'main' : command;
    const child = spawn(process.execPath, [
      fileURLToPath(new URL('../node_modules/tsx/dist/cli.mjs', import.meta.url)),
      fileURLToPath(new URL(`../src/${file}.ts`, import.meta.url)),
    ], {
      stdio: 'inherit',
      env: { ...process.env,
        ...(values['state-directory'] ? { OPENWORKSPACE_HOME: values['state-directory'] } : {}),
        ...(values.port ? { OPENWORKSPACE_PORT: values.port } : {}),
        ...(values['no-open'] ? { OPENWORKSPACE_NO_OPEN: '1' } : {}),
      },
    });
    child.once('error', () => { console.error('OpenWorkspace runtime could not start. Check the app installation.'); process.exitCode = 1; });
    child.once('exit', (code, signal) => { process.exitCode = signal ? 1 : code || 0; });
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => child.kill(signal));
  }
} catch (error) {
  console.error(error.message);
  console.error('Run openworkspace --help for usage. No project command was executed.');
  process.exitCode = 1;
}
