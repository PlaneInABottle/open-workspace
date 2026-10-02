import { join } from 'node:path';
import { z } from 'zod';
import { ensurePrivateDirectory, readPrivateJson, stateDirectory } from './store.js';

const connectionSchema = z.object({
  origin: z.string().url(),
  mcpToken: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

export async function connection(directory = stateDirectory()) {
  await ensurePrivateDirectory(directory);
  const value = connectionSchema.parse(await readPrivateJson(join(directory, 'connection.json')));
  const url = new URL(value.origin);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port
    || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Local connection must target the loopback service.');
  }
  return value;
}

export async function serviceRequest(path: string, data?: unknown) {
  const local = await connection();
  const response = await fetch(`${local.origin}${path}`, {
    method: data === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${local.mcpToken}`, ...(data === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    signal: AbortSignal.timeout(10_000), redirect: 'error',
  });
  const result = await response.json() as { error?: string };
  if (!response.ok) throw new Error(result.error || 'Local operation failed.');
  return result;
}
