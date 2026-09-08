import { createInterface } from 'node:readline';
import { dataDir, status, setRecoveryArmed } from './state.mjs';

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
          serverInfo: { name: 'openrouter-continuity', version: '0.2.0' }
        }; break;
      case 'ping': result = {}; break;
      case 'tools/list':
        result = { tools: [
          {
            name: 'continuity_status',
            description: 'Lê o último erro de limite e o estado da recuperação experimental. Não lê credenciais e não faz chamadas pagas.',
            inputSchema: { type: 'object', properties: {}, additionalProperties: false },
            annotations: { readOnlyHint: true, openWorldHint: false }
          },
          {
            name: 'continuity_set_recovery',
            description: 'Ativa ou desativa a recuperação no Windows. Quando ativa, o próximo limite fecha o Claude normalmente, reabre o app e seleciona o Gateway já configurado. Não força processos e não armazena chaves.',
            inputSchema: {
              type: 'object', required: ['enabled'], additionalProperties: false,
              properties: { enabled: { type: 'boolean' } }
            },
            annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }
          }
        ] }; break;
      case 'tools/call':
        if (request.params?.name === 'continuity_status') {
          result = { content: [{ type: 'text', text: JSON.stringify(await status(dataDir())) }] };
        } else if (request.params?.name === 'continuity_set_recovery') {
          const enabled = request.params?.arguments?.enabled;
          await setRecoveryArmed(dataDir(), enabled);
          result = { content: [{ type: 'text', text: JSON.stringify({ enabled, requiresConfiguredGateway: true }) }] };
        } else throw new Error('unknown tool');
        break;
      default:
        send({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Method not found' } });
        continue;
    }
    send({ jsonrpc: '2.0', id: request.id, result });
  } catch {
    send({ jsonrpc: '2.0', id: request.id, error: { code: -32603, message: 'Continuity: operação indisponível; verifique a versão do Claude e o diretório de dados do plugin.' } });
  }
}
