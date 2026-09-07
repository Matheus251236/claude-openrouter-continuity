import { dataDir, recordFailure } from './state.mjs';

try {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > 1048576) throw new Error('Oversize hook input');
    chunks.push(chunk);
  }
  await recordFailure(JSON.parse(Buffer.concat(chunks).toString('utf8')), dataDir());
} catch {
  // Never echo API errors, transcripts, input JSON or credentials into Claude logs.
  process.stderr.write('Continuity: não foi possível registrar o evento local.\n');
  process.exitCode = 1;
}
