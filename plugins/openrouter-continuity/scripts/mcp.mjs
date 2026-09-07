import { createInterface } from 'node:readline';
import { dataDir, status } from './state.mjs';

const supportedVersions = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of lines) {
  let request;
  try { if (line.length > 1048576) throw new Error(); request = JSON.parse(line); }
  catch { send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); continue; }
  if (request.id === undefined) continue;
  let result;
  try {
    switch (request.method) {
      case 'initialize':
        result = {
          protocolVersion: supportedVersions.includes(request.params?.protocolVersion)
            ? request.params.protocolVersion : supportedVersions[0],
          capabilities: { tools: {} },
          serverInfo: { name: 'openrouter-continuity', version: '0.1.0' }
        }; break;
      case 'ping': result = {}; break;
      case 'tools/list':
        result = { tools: [{
          name: 'continuity_status',
          description: 'Lê o último erro de limite registrado e o estado real da integração experimental. Não altera provedor, não faz chamadas pagas e não retoma sessões.',
          inputSchema: { type: 'object', properties: {}, additionalProperties: false },
          annotations: { readOnlyHint: true, openWorldHint: false }
        }] }; break;
      case 'tools/call':
        if (request.params?.name !== 'continuity_status') throw new Error('unknown tool');
        result = { content: [{ type: 'text', text: JSON.stringify(await status(dataDir())) }] }; break;
      default:
        send({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Method not found' } });
        continue;
    }
    send({ jsonrpc: '2.0', id: request.id, result });
  } catch {
    send({ jsonrpc: '2.0', id: request.id, error: { code: -32603, message: 'Continuity: operação indisponível; verifique a versão do Claude e o diretório de dados do plugin.' } });
  }
}
