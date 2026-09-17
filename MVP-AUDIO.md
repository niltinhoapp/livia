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

Imagem e documentos continuam como evolução separada e não são requisito deste marco de áudio do MVP.

Podem ser tratados pelo backend e encaminhados para análise humana enquanto não houver necessidade comprovada de visão multimodal no fluxo automático.

## Regra de implementação

A implementação deve ser precedida por uma Pré-OT read-only para mapear o recebimento atual de mídia no webhook e encontrar o menor ponto de integração da transcrição.

Não alterar fluxos estáveis de texto, agenda, CRM ou handoff apenas para acomodar áudio. O objetivo é adicionar a etapa de transcrição antes do pipeline conversacional existente.
