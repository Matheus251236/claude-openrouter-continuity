import { dataDir, recordFailure, recoveryConfig, recordRecoveryState } from './state.mjs';
import { launchRecovery } from './recovery.mjs';

try {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > 1048576) throw new Error('Oversize hook input');
    chunks.push(chunk);
  }
  const dir = dataDir();
  const recorded = await recordFailure(JSON.parse(Buffer.concat(chunks).toString('utf8')), dir);
  if (recorded && (await recoveryConfig(dir)).armed) {
    const result = launchRecovery(dir);
    if (!result.launched) await recordRecoveryState(dir, result.reason);
  }
} catch {
  // Never echo API errors, transcripts, input JSON or credentials into Claude logs.
  process.stderr.write('Continuity: não foi possível registrar o evento local.\n');
  process.exitCode = 1;
}
