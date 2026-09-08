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

async function readJson(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function writeJsonAtomic(dir, name, value) {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const tmp = join(dir, `${randomUUID()}.tmp`);
  await writeFile(tmp, JSON.stringify(value), { mode: 0o600 });
  await rename(tmp, join(dir, name));
}

export async function recoveryConfig(dir) {
  const value = await readJson(join(dir, 'recovery-config.json'));
  return {
    armed: value?.armed === true,
    mode: 'restart-to-configured-gateway',
    requiresConfiguredGateway: true
  };
}

export async function setRecoveryArmed(dir, armed) {
  if (typeof armed !== 'boolean') throw new TypeError('armed must be boolean');
  const value = {
    armed,
    mode: 'restart-to-configured-gateway',
    requiresConfiguredGateway: true,
    updatedAt: new Date().toISOString()
  };
  await writeJsonAtomic(dir, 'recovery-config.json', value);
  return value;
}

export async function recordRecoveryState(dir, state, detail = null) {
  await writeJsonAtomic(dir, 'recovery-status.json', {
    at: new Date().toISOString(), state,
    detail: typeof detail === 'string' ? detail.slice(0, 160) : null
  });
}

export async function status(dir) {
  const lastFailure = await readJson(join(dir, 'last-failure.json'));
  const lastRecovery = await readJson(join(dir, 'recovery-status.json'));
  const recovery = await recoveryConfig(dir);
  return {
    version: '0.2.0', stage: 'experimental', desktopRoutingAttached: false,
    automaticFallbackActive: false,
    automaticRecoveryArmed: recovery.armed,
    recoveryMode: recovery.mode,
    requiresConfiguredGateway: recovery.requiresConfiguredGateway,
    lastFailure, lastRecovery,
    blocker: 'O Desktop não permite trocar o transporte dentro do processo atual. A recuperação experimental fecha normalmente o app, reabre e seleciona o Gateway já configurado; ela não lê nem armazena a chave do OpenRouter.'
  };
}
