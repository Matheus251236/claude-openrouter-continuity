import { readFile, access, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = async path => JSON.parse(await readFile(join(root, path), 'utf8'));
const marketplace = await read('.claude-plugin/marketplace.json');
assert.equal(marketplace.name, 'claude-continuity-lab');
assert.ok(marketplace.owner.name);
assert.equal(marketplace.plugins.length, 1);
const entry = marketplace.plugins[0];
assert.ok(entry.source.startsWith('./plugins/'));
const pluginRoot = entry.source.slice(2);
const manifest = await read(`${pluginRoot}/.claude-plugin/plugin.json`);
assert.equal(manifest.name, entry.name);
assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
const hook = await read(`${pluginRoot}/hooks/hooks.json`);
assert.deepEqual(Object.keys(hook.hooks), ['StopFailure']);
const handler = hook.hooks.StopFailure[0].hooks[0];
assert.equal(handler.command, 'node');
const mcp = await read(`${pluginRoot}/.mcp.json`);
assert.equal(mcp.mcpServers.continuity.command, 'node');
for (const path of [...handler.args, ...mcp.mcpServers.continuity.args]) {
  assert.ok(path.startsWith('${CLAUDE_PLUGIN_ROOT}/'));
  await access(join(root, pluginRoot, path.replace('${CLAUDE_PLUGIN_ROOT}/', '')));
}
async function inspect(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (['.git', 'runtime', 'node_modules'].includes(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) await inspect(path);
    else if (/\.(json|mjs|md|yml|vbs)$/.test(path)) {
      const text = await readFile(path, 'utf8');
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
      assert.ok(!credentialPatterns.some(pattern => pattern.test(text)), 'Credential-like value in repository');
    }
  }
}
await inspect(root);
console.log('Manifest, marketplace, hook and MCP paths validated; no credential patterns found. This is a local structural check, not Claude Desktop installation validation.');
