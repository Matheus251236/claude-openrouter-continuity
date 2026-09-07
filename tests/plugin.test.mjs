import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { recordFailure, status, dataDir } from '../plugins/openrouter-continuity/scripts/state.mjs';

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'continuity-test-'));
  t.after(() => {
    const target = resolve(dir);
    assert.equal(target.startsWith(resolve(tmpdir()) + (process.platform === 'win32' ? '\\' : '/') + 'continuity-test-'), true);
    return rm(target, { recursive: true, force: true });
  });
  return dir;
}

test('hook stores minimal diagnostic data, never transcript, raw error or original session id', async t => {
  const dir = await fixture(t);
  assert.equal(await recordFailure({ hook_event_name: 'StopFailure', error: 'rate_limit',
    session_id: 'FAKE_PRIVATE_SESSION', transcript_path: 'private-path',
    error_details: 'FAKE_SECRET', last_assistant_message: 'private error' }, dir), true);
  const text = await readFile(join(dir, 'last-failure.json'), 'utf8');
  for (const sensitive of ['FAKE_PRIVATE_SESSION', 'private-path', 'FAKE_SECRET', 'private error'])
    assert.equal(text.includes(sensitive), false);
  const result = await status(dir);
  assert.equal(result.lastFailure.error, 'rate_limit');
  assert.equal(result.automaticFallbackActive, false);
});

test('unrelated hook events do not record an exhausted subscription', async t => {
  const dir = await fixture(t);
  assert.equal(await recordFailure({ hook_event_name: 'Stop', error: 'rate_limit' }, dir), false);
  assert.equal(await recordFailure({ hook_event_name: 'StopFailure', error: 'authentication_failed' }, dir), false);
  assert.equal((await status(dir)).lastFailure, null);
});

test('missing plugin data directory never writes into the project implicitly', () => {
  assert.throws(() => dataDir({}), /unavailable/);
});

test('MCP process initializes and returns truthful integration status over stdio', async t => {
  const dir = await fixture(t);
  const child = spawn(process.execPath, [resolve('plugins/openrouter-continuity/scripts/mcp.mjs')], {
    env: { ...process.env, CLAUDE_PLUGIN_DATA: dir }, windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe']
  });
  const timer = setTimeout(() => child.kill(), 5000);
  t.after(() => { clearTimeout(timer); child.kill(); });
  let output = '', stderr = '';
  child.stdout.on('data', chunk => output += chunk);
  child.stderr.on('data', chunk => stderr += chunk);
  const closed = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', code => resolve(code));
  });
  for (const message of [
    { id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1' } } },
    { method: 'notifications/initialized' },
    { id: 2, method: 'tools/list' },
    { id: 3, method: 'tools/call', params: { name: 'continuity_status', arguments: {} } }
  ]) child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
  child.stdin.end();
  assert.equal(await closed, 0);
  assert.equal(stderr, '');
  const replies = output.trim().split('\n').map(JSON.parse);
  assert.equal(replies.length, 3);
  assert.equal(replies[0].result.protocolVersion, '2025-03-26');
  assert.equal(replies[1].result.tools[0].name, 'continuity_status');
  assert.equal(JSON.parse(replies[2].result.content[0].text).desktopRoutingAttached, false);
});

test('command hook executes with stdin and path arguments without Bash', async t => {
  const dir = await fixture(t);
  const child = spawn(process.execPath, [resolve('plugins/openrouter-continuity/scripts/record-failure.mjs')], {
    env: { ...process.env, CLAUDE_PLUGIN_DATA: dir }, windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe']
  });
  const timer = setTimeout(() => child.kill(), 5000);
  t.after(() => { clearTimeout(timer); child.kill(); });
  const closed = new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
  child.stdin.end(JSON.stringify({ hook_event_name: 'StopFailure', error: 'billing_error', session_id: 'synthetic' }));
  assert.equal(await closed, 0);
  assert.equal((await status(dir)).lastFailure.error, 'billing_error');
});
