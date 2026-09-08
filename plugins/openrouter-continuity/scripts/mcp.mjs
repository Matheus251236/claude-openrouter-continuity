import { createInterface } from 'node:readline';
import { translateAnthropicModel } from '../src/transport.mjs';

const supportedVersions = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const send = message => process.stdout.write(`${JSON.stringify(message)}\n`);
const keyConfigured = () => typeof process.env.OPENROUTER_API_KEY === 'string' &&
  process.env.OPENROUTER_API_KEY.trim().length > 0;

function status() {
  return {
    version: '0.3.0',
    stage: 'experimental',
    openRouterKeyConfigured: keyConfigured(),
    desktopRoutingAttached: false,
    automaticFallbackActive: false,
    restartBehaviorPresent: false,
    blocker: 'Claude Code plugins expose tools and lifecycle hooks, but no model-request transport interceptor. The in-memory transport only runs when an adapter explicitly calls createContinuityTransport().send().'
  };
}

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of lines) {
  let request;
  try {
    if (line.length > 1048576) throw new Error();
    request = JSON.parse(line);
  } catch {
    send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    continue;
  }
  if (request.id === undefined) continue;
  try {
    let result;
    switch (request.method) {
      case 'initialize':
        result = {
          protocolVersion: supportedVersions.includes(request.params?.protocolVersion)
            ? request.params.protocolVersion : supportedVersions[0],
          capabilities: { tools: {} },
          serverInfo: { name: 'openrouter-continuity', version: '0.3.0' }
        };
        break;
      case 'ping':
        result = {};
        break;
      case 'tools/list':
        result = { tools: [
          {
            name: 'continuity_status',
            description: 'Informa se a chave OpenRouter foi configurada e se o transporte está realmente conectado. Nunca exibe a chave.',
            inputSchema: { type: 'object', properties: {}, additionalProperties: false },
            annotations: { readOnlyHint: true, openWorldHint: false }
          },
          {
            name: 'continuity_translate_model',
            description: 'Mostra como um identificador de modelo Anthropic seria normalizado para o OpenRouter. Não faz chamada de rede.',
            inputSchema: {
              type: 'object', required: ['model'], additionalProperties: false,
              properties: { model: { type: 'string', minLength: 1 } }
            },
            annotations: { readOnlyHint: true, openWorldHint: false }
          }
        ] };
        break;
      case 'tools/call':
        if (request.params?.name === 'continuity_status') {
          result = { content: [{ type: 'text', text: JSON.stringify(status()) }] };
        } else if (request.params?.name === 'continuity_translate_model') {
          const model = request.params?.arguments?.model;
          if (typeof model !== 'string' || !model.trim()) throw new Error('invalid model');
          result = { content: [{ type: 'text', text: JSON.stringify({
            input: model, openRouterModel: translateAnthropicModel(model)
          }) }] };
        } else {
          throw new Error('unknown tool');
        }
        break;
      default:
        send({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Method not found' } });
        continue;
    }
    send({ jsonrpc: '2.0', id: request.id, result });
  } catch {
    send({ jsonrpc: '2.0', id: request.id, error: {
      code: -32603, message: 'Continuity: operação indisponível ou entrada inválida.'
    } });
  }
}
