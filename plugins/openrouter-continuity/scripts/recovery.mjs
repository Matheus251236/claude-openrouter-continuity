import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

export function recoveryCommand(dir, root = pluginRoot) {
  if (process.platform !== 'win32') return null;
  return {
    command: 'powershell.exe',
    args: [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden',
      '-File', join(root, 'scripts', 'restart-to-gateway.ps1'),
      '-DataDir', dir
    ]
  };
}

export function launchRecovery(dir, options = {}) {
  const spec = recoveryCommand(dir, options.pluginRoot);
  if (!spec) return { launched: false, reason: 'unsupported_platform' };
  const spawnImpl = options.spawnImpl ?? spawn;
  const child = spawnImpl(spec.command, spec.args, {
    detached: true, stdio: 'ignore', windowsHide: true
  });
  child.unref?.();
  return { launched: true, pid: Number.isInteger(child.pid) ? child.pid : null };
}
