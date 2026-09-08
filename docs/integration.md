# Investigação da integração com Claude Desktop

Data: 7 de setembro de 2026.

## Objetivo de aceitação

O usuário permanece na aba Code, com sua conta e sessão atual. Enquanto a assinatura aceita chamadas, elas usam a assinatura. Quando o limite é atingido, a próxima resposta usa OpenRouter e aparece na mesma sessão, sem precisar operar Claude em um terminal.

## Evidência local

Foi encontrada a versão Windows Store **1.46388.4.0** em execução. A inspeção foi somente de leitura nos módulos distribuídos dentro de `resources/app.asar`. Código proprietário, arquivos de login e dados pessoais não foram copiados para este repositório.

A configuração de ambiente do aplicativo reserva variáveis de endereço de API e autenticação. O construtor do ambiente do processo Code atribui o host e credenciais de acordo com o provedor do aplicativo. O modo Gateway fornece credenciais próprias e limpa o campo de OAuth de assinatura. Há também um mecanismo de atualização das credenciais pelo host.

Esses achados indicam que editar variáveis de um subprocesso de hook não altera automaticamente o cliente de API do processo pai. Também tornam frágil qualquer tentativa de alterar arquivos de ambiente esperando que o Desktop conserve a alteração.

Não executamos injeção de código, patch de `app.asar`, leitura de tokens, captura de tráfego, interceptação TLS ou encerramento de processos. Não foi encontrado um mecanismo de hot-swap exposto ao plugin na documentação ou nas partes inspecionadas. Isso é uma conclusão limitada à investigação realizada, não uma prova matemática de impossibilidade.

## Evidência documental

A [configuração Desktop](https://code.claude.com/docs/en/llm-gateway-connect#desktop-app) usa as preferências de inferência de terceiros, separadas das variáveis usadas pela CLI. O [guia OpenRouter](https://openrouter.ai/docs/cookbook/coding-agents/claude-desktop-integration) descreve aplicar a configuração, reiniciar e entrar com Gateway. A versão 0.2 automatiza somente esse reinício e a escolha do Gateway já configurado; ela não transforma esse fluxo em hot-swap.

O [evento StopFailure](https://code.claude.com/docs/en/hooks#stopfailure) informa erros de API. Seu retorno não fornece uma decisão de substituição da resposta ou do provedor. Por isso, este plugin usa o evento apenas como evidência diagnóstica.

## Arquitetura implementada e parte ausente

```text
Claude Desktop, sessão atual
        |
        | ADAPTADOR DE SESSÃO AUSENTE / NÃO VALIDADO
        v
createContinuityTransport().send(requisição, headers da sessão)
        |
        +--> Anthropic --> resposta normal --> chamador
        |
        +--> erro de limite reconhecido
                 |
                 +--> OpenRouter, credencial separada --> chamador

Plugin instalado --> StopFailure --> registro local mínimo
                 |               --> se armado: fechamento normal
                 |                              --> reabre Desktop
                 |                              --> seleciona Gateway
                 +--> MCP continuity_status / continuity_set_recovery
```

O módulo de transporte não lê credenciais por conta própria. O futuro adaptador precisaria receber a requisição que o cliente já ia enviar e mantê-la no mesmo fluxo. Seus destinos são fixos e HTTPS: Anthropic primário, OpenRouter secundário. O retorno da segunda chamada continua no mesmo `send()`; nenhuma sessão é criada por esse módulo.

As mensagens e IDs de ferramentas permanecem intactos no teste. Metadados externos de conta e headers de autenticação não são repassados para o segundo provedor. Nenhum conteúdo de requisição ou erro bruto é registrado.

## Recuperação experimental 0.2

O auxiliar Windows usa UI Automation apenas na janela do processo Claude. Ele não lê nem grava a chave do Gateway. A configuração fica sob responsabilidade do formulário oficial do Desktop. Se o aplicativo não fechar normalmente, nenhum processo é forçado. O recurso é opt-in e fica desarmado após a instalação.

O teste `DryRun` carrega as bibliotecas de UI Automation e valida os argumentos sem fechar ou abrir aplicativos. O teste real ainda exige configurar o OpenRouter, reiniciar o Desktop e comprovar que a sessão salva volta a abrir no Gateway.

## Próxima etapa necessária

Investigar com a Anthropic uma extensão de transporte na aba Code que permita conectar o intermediário a uma sessão ativa. Se um ponto suportado aparecer, criar um adaptador pequeno e específico à versão e testá-lo primeiro em uma sessão descartável. O acesso ao GitHub permite publicar o código, mas não resolve este bloqueio técnico. Uma chave OpenRouter também não o resolve sozinha.

Para validar a recuperação, configurar o Gateway pelo formulário oficial, manter o recurso desarmado, realizar um reinício manual e confirmar que o Desktop conserva a sessão. Só então armar o fechamento automático. Não apresentar o reinício como hot-swap dentro do processo.

## Testes de aceitação ainda pendentes

1. Provar que uma chamada da sessão Code real chega ao transporte usando a autenticação original.
2. Simular a resposta de limite sem gastar toda a assinatura do usuário.
3. Obter uma resposta real OpenRouter e exibi-la na mesma sessão e aba.
4. Confirmar que nenhuma ação de ferramenta foi repetida e que seus IDs continuam válidos.
5. Validar thinking, anexos, compactação, cancelamento, reconexão e troca de modelo.
6. Verificar renovação da credencial da assinatura e retorno ao primário após o limite se restabelecer.
7. Validar instalação, atualização e remoção via marketplace em Windows, sem uso de Bash pelo usuário.

Até esses critérios serem cumpridos, o projeto deve continuar marcado como experimental e a ferramenta MCP deve informar `automaticFallbackActive: false`.
