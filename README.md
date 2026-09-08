# Claude OpenRouter Continuity

Plugin experimental e biblioteca de transporte para estudar fallback de uma chamada Anthropic para o OpenRouter sem reiniciar o sistema operacional nem o Claude Desktop.

## Estado real da integração

A biblioteca implementa o retry em memória: chama a Anthropic, captura um HTTP 429, converte o pedido para OpenRouter Chat Completions, faz a segunda chamada e converte a resposta de volta para o formato Anthropic. Ela conserva texto, ferramentas e IDs de chamadas nos formatos cobertos pelos testes.

O sistema de plugins do Claude Code não oferece um interceptor para as requisições do próprio modelo. MCP adiciona ferramentas que o Claude pode chamar, e StopFailure ocorre depois que a chamada do modelo já falhou. Por isso, instalar este repositório na aba Plugins não conecta automaticamente a sessão nativa a createContinuityTransport().send().

O status do plugin informa essa diferença por meio de:

- desktopRoutingAttached: false
- automaticFallbackActive: false

O código não afirma que existe hot-swap na sessão nativa enquanto esse ponto de extensão não existir.

## Configurar a OpenRouter API Key sem terminal

A versão 0.3.0 declara uma opção sensível chamada **OpenRouter API Key**. Quando o Claude Desktop instalar ou atualizar o plugin, abra:

1. **Configurações → Plugins → Openrouter continuity → Gerenciar/Configurar**.
2. Localize **OpenRouter API Key**.
3. Cole a chave diretamente nesse campo mascarado e salve.
4. Recarregue os plugins quando o Claude solicitar.

O Claude guarda o valor no armazenamento seguro usado para configurações sensíveis. O arquivo .mcp.json apenas injeta o valor no processo local como OPENROUTER_API_KEY:

~~~json
{
  "env": {
    "OPENROUTER_API_KEY": "${user_config.openrouter_api_key}"
  }
}
~~~

Não coloque a chave no repositório, no README, em .env versionado ou em mensagens de chat. A chave nunca é retornada pela ferramenta continuity_status.

## Transporte em memória

O módulo plugins/openrouter-continuity/src/transport.mjs exporta:

- translateAnthropicModel(model, overrides): remove sufixos de data e normaliza famílias como claude-3-5-sonnet-20241022 para anthropic/claude-3.5-sonnet.
- toOpenRouterChatRequest(body, modelMap): converte Anthropic Messages para OpenRouter Chat Completions.
- createContinuityTransport(options): tenta https://api.anthropic.com/v1/messages e, somente em HTTP 429, tenta https://openrouter.ai/api/v1/chat/completions.

O fallback:

- usa somente a chave OpenRouter na segunda chamada;
- não encaminha cookies, OAuth, chave Anthropic ou metadata de conta ao OpenRouter;
- converte respostas JSON, erros e streams SSE de volta para eventos Anthropic;
- limita o número de tentativas OpenRouter por instância;
- volta a testar a Anthropic no turno seguinte.

Um integrador compatível ainda precisa fornecer ao transporte o corpo e os headers da requisição antes da chamada nativa:

~~~js
const transport = createContinuityTransport();
const response = await transport.send(anthropicBody, anthropicSessionHeaders);
~~~

Esse adaptador não pode ser criado com MCP, skill ou hook depois da instalação. Ele precisaria ser exposto pela Anthropic no host da aba Code ou configurado como o gateway de todas as chamadas desde o início.

## Remoções da versão 0.3

Foram eliminados:

- restart-to-gateway.ps1;
- recovery.mjs;
- state.mjs;
- gravação de falhas e configuração em disco;
- hook StopFailure;
- ferramenta continuity_set_recovery.

O plugin não fecha, encerra nem reabre o Claude.

## Instalação pelo Claude Desktop

Adicione este repositório como marketplace:

~~~text
https://github.com/Matheus251236/claude-openrouter-continuity
~~~

Depois instale ou atualize **openrouter-continuity** e configure a chave no campo sensível descrito acima. Não é necessário operar o Claude via Bash.

## Desenvolvimento e testes

~~~text
node scripts/validate.mjs
node --test tests/*.test.mjs
~~~

Os testes não fazem chamadas externas e usam credenciais obviamente sintéticas. Eles validam tradução dinâmica de modelos, conversão de mensagens e ferramentas, fallback somente em HTTP 429, isolamento das credenciais, JSON e SSE, remoção do reinício e configuração sensível.

## Limitações

- Não prevê quando a cota semanal acabará; reage a HTTP 429.
- Não repete uma resposta primária parcialmente emitida.
- Blocos Anthropic sem equivalente seguro em Chat Completions geram erro local.
- O normalizador cobre convenções de nomes; modelos futuros podem precisar de modelMap.
- Recursos proprietários da assinatura, thinking assinado, ferramentas hospedadas e compactação exigem testes próprios.
- O limite local de tentativas não é monetário. Configure orçamento e limites também no OpenRouter.

Veja [a análise do ponto de integração](docs/integration.md).

## Referências

- [Plugins do Claude Code](https://code.claude.com/docs/en/plugins-reference)
- [Hooks e StopFailure](https://code.claude.com/docs/en/hooks#stopfailure)
- [MCP no Claude Code](https://code.claude.com/docs/en/mcp)
- [OpenRouter Chat Completions](https://openrouter.ai/docs/api/api-reference/chat/send-chat-completion-request)
- [OpenRouter Anthropic Messages](https://openrouter.ai/docs/api/api-reference/anthropic-messages/create-messages)

Projeto independente, sem afiliação com Anthropic ou OpenRouter.
