# Limite de integração com a aba Code

## Fluxo implementado

~~~text
adaptador que possua a requisição antes do envio
        |
        v
createContinuityTransport().send(body, headers)
        |
        +--> Anthropic /v1/messages --> resposta Anthropic
        |
        +--> HTTP 429
                 |
                 +--> converte pedido Anthropic para Chat Completions
                 +--> OpenRouter /api/v1/chat/completions
                 +--> converte JSON/SSE para o formato Anthropic
                 +--> devolve Response ao adaptador
~~~

Todo o contador e o mapeamento ficam na instância JavaScript. Nenhum estado de recuperação é gravado em disco e nenhum processo é reiniciado.

## Ponto ausente no Claude Desktop

Um plugin pode fornecer skills, agentes, hooks, MCP, LSP e componentes experimentais documentados. Um MCP server fornece ferramentas externas ao modelo; ele não substitui o cliente HTTP usado pelo host para chamar o próprio modelo.

O evento StopFailure contém a categoria do erro depois que o turno termina. A documentação diz que esse evento não possui controle de decisão e que sua saída e seu código são ignorados. Portanto, ele não consegue substituir o erro por outro stream.

Também não é suficiente sobrescrever globalThis.fetch no processo MCP: o MCP roda como subprocesso separado, com memória e rede próprias. Isso não altera o JavaScript nem o cliente HTTP do Claude Desktop.

Para usar o transporte com a sessão nativa, a Anthropic precisaria expor middleware de transporte antes da chamada, callback de retry com resposta substituta, gateway por requisição que preserve a assinatura no primeiro destino, ou API pública para trocar o provedor de uma sessão ativa. Nenhum desses mecanismos aparece na referência atual.

## Compatibilidade do protocolo

O endpoint solicitado, /api/v1/chat/completions, usa o protocolo OpenAI. Retornar seu stream diretamente para um chamador Anthropic seria incompatível. O transporte converte system, mensagens, ferramentas, tool_use, tool_result, razões de parada, tokens, eventos SSE e erros.

O OpenRouter também oferece /api/v1/messages, que reduz a necessidade de conversão. A versão 0.3 mantém Chat Completions para atender ao desenho solicitado e torna a tradução explícita e testável.

## Critério para declarar fallback automático

automaticFallbackActive só poderá mudar para true depois que uma requisição real da aba Code chegar ao transporte antes da Anthropic, receber um 429 simulado e exibir o stream OpenRouter na mesma sessão. Até lá o plugin permanece uma biblioteca pronta para um adaptador, sem alegar interceptação inexistente.
