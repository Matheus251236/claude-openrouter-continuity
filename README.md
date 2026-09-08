# Claude OpenRouter Continuity

Protótipo para desenvolver continuidade da **mesma sessão na aba Code do Claude Desktop**, usando primeiro a assinatura Claude e, após um erro de limite, o OpenRouter.

**Estado: experimental. O hot-swap dentro do processo do Desktop não é suportado.** A versão 0.2 acrescenta uma recuperação opt-in para Windows: depois de um erro de limite, ela pode fechar o Claude normalmente, reabrir o aplicativo e selecionar o Gateway já configurado. O modo permanece desativado por padrão. Não há chave incluída nem cobrança ao instalar ou testar.

## O que foi implementado

- Marketplace de plugins Claude em `.claude-plugin/marketplace.json`.
- Plugin `openrouter-continuity`, com hook `StopFailure` e servidor MCP local.
- Registro mínimo do último erro de limite/cobrança, sem histórico, credenciais ou ID original da sessão.
- Ferramenta `continuity_status`, que informa o estado real do diagnóstico e da recuperação.
- Ferramenta `continuity_set_recovery`, que arma ou desarma a recuperação somente após uma ação explícita.
- Auxiliar Windows que nunca força o encerramento do Claude, não lê credenciais e só procura o botão de Gateway dentro da janela do próprio aplicativo.
- Transporte de laboratório: tenta Anthropic, reconhece determinados erros de limite e repete a requisição no endpoint Messages do OpenRouter.
- Preservação das mensagens, instruções, definições de ferramentas e referências entre `tool_use` e `tool_result`.
- Credenciais separadas, bloqueio de redirects HTTP, limite local de tentativas pagas e cancelamento de requisições.
- SSE: permite fallback antes do início da mensagem; preserva o fluxo e não repete uma resposta já iniciada.
- Testes sem rede externa, contas reais ou consumo de tokens.

O fallback de transporte continua a mesma chamada da API. **Isso ainda não está conectado ao processo real do Desktop.** A recuperação 0.2 contorna essa ausência reiniciando o aplicativo; a conversa continua salva pelo Claude, mas a retomada automática da mesma tela ainda precisa de um teste real.

## Usar sem terminal

No Windows, abra **Verificar prototipo.vbs** com dois cliques. Ele executa os testes locais em segundo plano e abre um relatório no navegador. É necessário Node.js 22 ou superior. O relatório aparece em `runtime/report.html` e não entra no Git.

Para instalar o plugin experimental pelo Claude Desktop:

1. Abra a aba Code e o gerenciador de Plugins.
2. Adicione `https://github.com/Matheus251236/claude-openrouter-continuity` como marketplace; o nome do marketplace é `claude-continuity-lab`.
3. Instale `openrouter-continuity`.
4. Se solicitado pelo Claude, recarregue os plugins. Peça para consultar a ferramenta `continuity_status`.
5. Configure o OpenRouter em **Developer → Configure Third-Party Inference** antes de armar a recuperação.
6. Somente depois da configuração e de um teste de reinício, peça ao Claude para usar `continuity_set_recovery` com `enabled: true`.

Em repositórios privados, o mecanismo Git usado pelo Claude precisa ter acesso ao repositório. Estar conectado ao GitHub no navegador não garante essa autenticação. Os nomes dos botões podem variar entre versões.

Não é necessário usar o Claude via Bash. Os componentes usam Node e, no Windows, um processo PowerShell oculto com argumentos separados. A política de execução é ignorada somente para esse processo; a configuração do sistema não é alterada.

## Bloqueio de integração

Para alcançar um hot-swap sem reinício, a chamada do processo **já em execução** precisaria passar pelo transporte antes de receber a resposta de erro. Um hook depois da falha não substitui essa chamada sozinho: a documentação do `StopFailure` diz que saída e código de retorno são ignorados.

A investigação da versão Windows instalada encontrou a configuração de host e de autenticação na inicialização do processo da aba Code. A documentação atual também separa o modo de assinatura do modo Gateway. Não foi identificado um ponto de extensão de plugin que conecte o transporte à sessão já aberta.

Não modificamos binários do Claude, certificados, login ou tokens da conta. Não há adaptador que extraia credenciais de arquivos de login. A recuperação só usa a opção de Gateway que o usuário já configurou no próprio Claude Desktop.

Veja [a investigação e os critérios de conclusão](docs/integration.md).

## Desenvolvimento

```text
node scripts/validate.mjs
node --test tests/*.test.mjs
node scripts/verify.mjs
```

Sem dependências npm. Os 29 testes passam localmente; a matriz do GitHub Actions cobre Windows e Linux. Esses testes usam respostas simuladas, e o auxiliar Windows é executado apenas em modo `DryRun`: não encerram o Claude, não usam contas e não consomem tokens.

O módulo está em `plugins/openrouter-continuity/src/transport.mjs`. Ele permanece desabilitado por padrão. `enabled: true` e uma chave passada em memória habilitam fallback somente para o chamador que explicitamente usar `send()`. Não existe serviço de rede aberto, inicialização automática de proxy ou ativação de cobrança nesta versão.

O limite `maxFallbackRequests` é uma quantidade de tentativas por instância, **não um limite monetário**. Para uma futura operação real, a chave do OpenRouter deverá ter um orçamento configurado na conta. Reiniciar o módulo zera esse contador.

## Limitações conhecidas

- Não detecta antecipadamente o saldo semanal: reage ao erro retornado pela API.
- Um erro `rate_limit_error` pode ser temporário; não prova que a cota semanal acabou.
- Não há validação com assinatura real, API OpenRouter, thinking assinado, compactação, ferramentas hospedadas ou funções exclusivas de conta.
- O corpo de erro HTTP deve ser JSON reconhecido; SSE deve trazer o erro antes do início da mensagem. Outros casos são devolvidos ao chamador.
- A requisição OpenRouter remove metadados de conta e headers OAuth; conserva o conteúdo da conversa, que seria enviado ao OpenRouter quando habilitado.
- O modelo original é mantido, ou traduzido por um `modelMap` explícito. O provedor é limitado a Anthropic no corpo do pedido. A compatibilidade desses campos com a versão atual do endpoint OpenRouter ainda exige teste real.
- Não promete migrar uma sessão existente, manter recursos de nuvem ou retomar uma resposta parcialmente emitida.
- A recuperação 0.2 reinicia o aplicativo. Ela aborta se o Claude não fechar normalmente e nunca usa encerramento forçado.
- O Gateway precisa estar configurado previamente. Se o botão “Continuar com Gateway” não aparecer em 60 segundos, a recuperação registra a falha e para.

## Referências

- [OpenRouter no Claude Desktop](https://openrouter.ai/docs/cookbook/coding-agents/claude-desktop-integration)
- [Configuração de gateway por interface](https://code.claude.com/docs/en/llm-gateway-connect#desktop-app)
- [Assinaturas e gateways](https://code.claude.com/docs/en/llm-gateway#subscriptions-and-gateways)
- [Hooks e StopFailure](https://code.claude.com/docs/en/hooks#stopfailure)
- [Referência de plugins](https://code.claude.com/docs/en/plugins-reference)
- [Marketplaces](https://code.claude.com/docs/en/plugin-marketplaces)

Este é um projeto independente, sem afiliação com Anthropic ou OpenRouter.
