# Lívia — Áudio no MVP

## Decisão oficial

O suporte a mensagens de áudio no WhatsApp é requisito para o MVP da Lívia.

O MVP não deve ser considerado pronto para lançamento enquanto o fluxo real de áudio não estiver funcional e validado.

## Arquitetura decidida

A Lívia não deve enviar o arquivo de áudio diretamente ao modelo conversacional como fluxo principal.

O backend é responsável por receber e preparar a mídia:

```text
Cliente envia áudio no WhatsApp
        ↓
Webhook Meta
        ↓
Backend identifica a mídia
        ↓
Backend baixa o áudio com segurança
        ↓
Validação de tipo/tamanho
        ↓
Serviço de transcrição
        ↓
Texto transcrito
        ↓
Fluxo normal de inteligência da Lívia
        ↓
Resposta pelo WhatsApp
```

A IA conversacional continua trabalhando principalmente com texto. Depois da transcrição, a mensagem deve seguir o mesmo fluxo utilizado para texto digitado, preservando as regras e ferramentas já existentes.

## Integração com o núcleo atual

Uma transcrição válida deve poder alimentar normalmente:

- conversa e contexto;
- conhecimento;
- agenda;
- correções de data e horário;
- CRM e identificação de interesse;
- handoff humano;
- demais regras comportamentais existentes.

Não criar uma segunda inteligência específica para áudio se o texto transcrito puder reutilizar o pipeline atual.

## Responsabilidade do backend

O backend deve cuidar de:

- identificação da mensagem de áudio;
- download seguro da mídia da Meta;
- validação de formato e tamanho;
- envio ao serviço de transcrição;
- associação da transcrição à mensagem original;
- tratamento de timeout e falha de transcrição;
- idempotência para evitar processamento/resposta duplicados;
- entrega do texto ao pipeline conversacional.

O backend não deve interpretar a intenção comercial ou conversacional do áudio. Essa interpretação continua sendo responsabilidade da inteligência da Lívia após receber a transcrição.

## Falhas

Se o áudio não puder ser baixado ou transcrito com segurança, a Lívia não deve inventar seu conteúdo.

O fluxo deve retornar uma resposta segura ao cliente ou encaminhar para tratamento apropriado conforme a regra que for definida na implementação.

## Dados e privacidade

Antes da implementação deve ser decidido explicitamente se o arquivo de áudio original precisa ser persistido.

A transcrição deve ficar associada à mensagem original quando necessário para histórico e contexto, respeitando isolamento entre estabelecimentos e as regras de retenção definidas para o produto.

Não persistir mídia além do necessário sem uma finalidade de produto definida.

## Critério mínimo de aceite do MVP

Antes do lançamento, validar no fluxo real do WhatsApp pelo menos:

1. áudio curto com fala clara;
2. áudio com pedido de informação;
3. áudio com intenção de agendamento;
4. áudio com data e horário;
5. áudio que gere interesse/CRM;
6. áudio pedindo atendimento humano;
7. áudio sem fala compreensível;
8. falha de download/transcrição;
9. reprocessamento do mesmo webhook sem resposta duplicada.

## Imagem e documentos

Imagem e documentos são persistidos em Storage privado e associados à
mensagem para análise pela equipe humana. O painel sinaliza cada mídia com
anexo persistido como "Anexo aguardando análise". Essa sinalização é apenas
operacional: não cria handoff, não pausa a Lívia e não muda o modo da conversa.

**Decisão de produto:** a resposta da Lívia ao recebimento de mídia será
configurável por estabelecimento e não deve ser hardcoded no backend. Cada
estabelecimento poderá definir se aceita imagens/documentos e qual orientação
deve ser enviada ao cliente. Essa configuração é requisito futuro e não faz
parte da sinalização interna atual.

Não há visão multimodal, OCR ou interpretação automática do conteúdo.

## Regra de implementação

A implementação deve ser precedida por uma Pré-OT read-only para mapear o recebimento atual de mídia no webhook e encontrar o menor ponto de integração da transcrição.

Não alterar fluxos estáveis de texto, agenda, CRM ou handoff apenas para acomodar áudio. O objetivo é adicionar a etapa de transcrição antes do pipeline conversacional existente.

## Implementação do backend

O pipeline usa o `media_id` recebido no webhook para consultar a URL
temporária da Cloud API e baixá-la no servidor com o token cifrado do próprio
estabelecimento. O áudio é validado antes da transcrição e mantido somente em
memória. O arquivo original e a URL autenticada não são persistidos.

Limites do MVP:

- no máximo 16 MiB por áudio;
- 10 segundos por chamada de download à Meta;
- MIME de áudio explícito e compatível;
- 30 segundos para transcrição, sem retry automático;
- transcript vazio é falha segura e não chega à inteligência.

A transcrição usa `OPENAI_API_KEY`, já exigida pelo backend. O modelo pode ser
configurado com `LIVIA_TRANSCRIPTION_MODEL`; sem essa variável, o padrão é
`gpt-4o-mini-transcribe`. Nenhum valor real deve ser colocado no repositório.

## Validação manual posterior (fora de Production nesta OT)

No ambiente de Preview apropriado, com webhook e credenciais próprios:

1. enviar áudio curto: “Olá, queria saber como funciona a Lívia”;
2. enviar: “Quero marcar uma avaliação amanhã às dez”;
3. em seguida, enviar: “Não, quis dizer às onze”;
4. enviar: “Quero falar com uma pessoa”;
5. enviar um áudio sem fala compreensível e confirmar o fallback curto;
6. reenviar o mesmo payload assinado, com o mesmo `wamid`, e confirmar uma
   única transcrição, resposta e eventual mutação;
7. conferir logs apenas por `messageId` mascarado, estabelecimento, tipo,
   tamanho, duração e código sanitizado — nunca áudio, transcript ou token.
