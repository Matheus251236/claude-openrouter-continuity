import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export function dataDir(env = process.env) {
  // Claude owns the persistent plugin directory; never fall back to a project directory.
  if (!env.CLAUDE_PLUGIN_DATA) throw new Error('CLAUDE_PLUGIN_DATA is unavailable');
  return env.CLAUDE_PLUGIN_DATA;
}

export async function recordFailure(event, dir) {
  if (event.hook_event_name !== 'StopFailure' ||
      !['rate_limit', 'billing_error'].includes(event.error)) return false;
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const record = {
    at: new Date().toISOString(), error: event.error,
    sessionHash: typeof event.session_id === 'string'
      ? createHash('sha256').update(event.session_id).digest('hex') : null,
    desktopRoutingAttached: false
  };
  const tmp = join(dir, `${randomUUID()}.tmp`);
  await writeFile(tmp, JSON.stringify(record), { mode: 0o600 });
  await rename(tmp, join(dir, 'last-failure.json'));
  return true;
}

export async function status(dir) {
  let lastFailure = null;
  try { lastFailure = JSON.parse(await readFile(join(dir, 'last-failure.json'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  return {
    version: '0.1.0', stage: 'experimental', desktopRoutingAttached: false,
    automaticFallbackActive: false, lastFailure,
    blocker: 'O Desktop não oferece um ponto de extensão validado para interceptar a API da sessão atual. O transporte existe como módulo de laboratório; instalar o plugin não o conecta ao Desktop.'
  };
}
