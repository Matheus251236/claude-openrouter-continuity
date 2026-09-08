import test from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pluginRoot = join(root, 'plugins', 'openrouter-continuity');
const readJson = async path => JSON.parse(await readFile(path, 'utf8'));

test('manifest exposes a required sensitive OpenRouter key setting', async () => {
  const marketplace = await readJson(join(root, '.claude-plugin', 'marketplace.json'));
  const manifest = await readJson(join(pluginRoot, '.claude-plugin', 'plugin.json'));
  assert.equal(marketplace.plugins[0].version, manifest.version);
  assert.equal(manifest.version, '0.3.0');
  assert.deepEqual(manifest.userConfig.openrouter_api_key, {
    type: 'string',
    title: 'OpenRouter API Key',
    description: 'Chave usada somente nas tentativas de fallback enviadas ao OpenRouter.',
    sensitive: true,
    required: true
  });
});

test('MCP receives the sensitive user setting through OPENROUTER_API_KEY', async () => {
  const mcp = await readJson(join(pluginRoot, '.mcp.json'));
  const server = mcp.mcpServers.continuity;
  assert.equal(server.command, 'node');
  assert.deepEqual(server.args, ['${CLAUDE_PLUGIN_ROOT}/scripts/mcp.mjs']);
  assert.equal(server.env.OPENROUTER_API_KEY, '${user_config.openrouter_api_key}');
  await access(join(pluginRoot, 'scripts', 'mcp.mjs'));
});

test('restart, recovery, hook and disk-state modules are absent', async () => {
  for (const relative of [
    'scripts/restart-to-gateway.ps1',
    'scripts/recovery.mjs',
    'scripts/record-failure.mjs',
    'scripts/state.mjs',
    'hooks/hooks.json'
  ]) {
    await assert.rejects(access(join(pluginRoot, relative)));
  }
});

test('MCP reports key presence without disclosing it and translates models', async t => {
  const marker = 'unit-test-openrouter-key-marker';
  const child = spawn(process.execPath, [join(pluginRoot, 'scripts', 'mcp.mjs')], {
    env: { ...process.env, OPENROUTER_API_KEY: marker },
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe']
  });
  const timer = setTimeout(() => child.kill(), 5000);
  t.after(() => { clearTimeout(timer); child.kill(); });
  let output = '';
  let stderr = '';
  child.stdout.on('data', chunk => output += chunk);
  child.stderr.on('data', chunk => stderr += chunk);
  const closed = new Promise((resolveClose, reject) => {
    child.on('error', reject);
    child.on('close', resolveClose);
  });
  for (const message of [
    { id: 1, method: 'initialize', params: {
      protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1' }
    } },
    { method: 'notifications/initialized' },
    { id: 2, method: 'tools/list' },
    { id: 3, method: 'tools/call', params: { name: 'continuity_status', arguments: {} } },
    { id: 4, method: 'tools/call', params: {
      name: 'continuity_translate_model', arguments: { model: 'claude-3-5-sonnet-20241022' }
    } }
  ]) {
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
  }
  child.stdin.end();
  assert.equal(await closed, 0);
  assert.equal(stderr, '');
  assert.equal(output.includes(marker), false);
  const replies = output.trim().split('\n').map(JSON.parse);
  assert.equal(replies[0].result.serverInfo.version, '0.3.0');
  assert.equal(replies[1].result.tools.length, 2);
  const status = JSON.parse(replies[2].result.content[0].text);
  assert.equal(status.openRouterKeyConfigured, true);
  assert.equal(status.desktopRoutingAttached, false);
  assert.equal(status.restartBehaviorPresent, false);
  const mapped = JSON.parse(replies[3].result.content[0].text);
  assert.equal(mapped.openRouterModel, 'anthropic/claude-3.5-sonnet');
});

test('repository contains no credential-like values', async () => {
  const credentialPatterns = [
    /sk-(?:or-v1-|proj-)[a-zA-Z0-9_-]{16,}/,
    /sk-ant-[a-zA-Z0-9_-]{16,}/,
    /github_pat_[a-zA-Z0-9_]{20,}/,
    /gh[pousr]_[a-zA-Z0-9]{20,}/,
    /AKIA[0-9A-Z]{16}/,
    /xox[baprs]-[a-zA-Z0-9-]{20,}/,
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
    /https?:\/\/[^\s/@:]+:[^\s/@]+@/,
    /Bearer\s+[a-zA-Z0-9._~+/=-]{24,}/
  ];
  async function inspect(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (['.git', 'runtime', 'node_modules'].includes(entry.name)) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await inspect(path);
      else if (/\.(json|mjs|md|yml|vbs|ps1)$/.test(path)) {
        const text = await readFile(path, 'utf8');
        assert.equal(credentialPatterns.some(pattern => pattern.test(text)), false,
          `Credential-like value in ${path}`);
      }
    }
  }
  await inspect(root);
});
