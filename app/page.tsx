import Link from "next/link";
import {
  ArrowUpRight,
  Bot,
  CalendarDays,
  Check,
  Handshake,
  MessageCircle,
  Sparkles,
} from "lucide-react";

const capabilities = [
  {
    icon: MessageCircle,
    title: "Atendimento inteligente",
    description: "Responde dúvidas e orienta seus clientes usando as informações do seu negócio.",
  },
  {
    icon: CalendarDays,
    title: "Agenda organizada",
    description: "Ajuda no agendamento e na gestão dos horários diretamente durante o atendimento.",
  },
  {
    icon: Handshake,
    title: "Handoff humano",
    description: "Quando necessário, encaminha a conversa para uma pessoa continuar o atendimento.",
  },
];

export default function Home() {
  return (
    <main className="min-h-screen bg-white text-ink-900">
      <header className="mx-auto flex w-full max-w-7xl items-center justify-between px-5 py-5 sm:px-8 lg:px-10">
        <Link href="/" className="group inline-flex items-center gap-2 text-lg font-semibold tracking-[-0.02em] text-ink-900">
          <span className="grid size-9 place-items-center rounded-control bg-primary text-white shadow-e1 transition-colors group-hover:bg-primary-hover">
            <MessageCircle className="size-5" aria-hidden="true" strokeWidth={2.25} />
          </span>
          Lívia
        </Link>

        <Link
          href="/login"
          className="rounded-control border border-line bg-white px-4 py-2 text-sm font-semibold text-ink-700 transition-colors hover:border-primary-200 hover:bg-primary-50 hover:text-primary-700"
        >
          Entrar
        </Link>
      </header>

      <section className="mx-auto grid w-full max-w-7xl gap-14 px-5 pb-20 pt-12 sm:px-8 sm:pb-28 sm:pt-20 lg:grid-cols-[minmax(0,1fr)_minmax(420px,0.9fr)] lg:items-center lg:gap-16 lg:px-10 lg:pb-32">
        <div className="max-w-2xl">
          <p className="inline-flex items-center gap-2 rounded-full border border-primary-100 bg-primary-50 px-3 py-1.5 text-sm font-semibold text-primary-700">
            <Sparkles className="size-4" aria-hidden="true" />
            Recepcionista inteligente para WhatsApp
          </p>

          <h1 className="mt-6 max-w-xl text-4xl font-bold tracking-[-0.045em] text-ink-900 sm:text-5xl sm:leading-[1.08] lg:text-6xl">
            Seu atendimento no WhatsApp, com uma recepcionista que trabalha por você.
          </h1>

          <p className="mt-6 max-w-xl text-lg leading-8 text-ink-600 sm:text-xl">
            A Lívia responde clientes, organiza atendimentos e ajuda seu negócio a cuidar do WhatsApp sem deixar conversas importantes para trás.
          </p>

          <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:items-center">
            <Link
              href="/login"
              className="inline-flex min-h-12 items-center justify-center gap-2 rounded-control bg-primary px-5 py-3 text-base font-semibold text-white shadow-e2 transition-colors hover:bg-primary-hover"
            >
              Entrar na Lívia
              <ArrowUpRight className="size-4" aria-hidden="true" />
            </Link>
            <a
              href="https://livia.conectweb.online"
              target="_blank"
              rel="noreferrer"
              className="inline-flex min-h-12 items-center justify-center gap-2 rounded-control px-5 py-3 text-base font-semibold text-ink-700 transition-colors hover:bg-ink-50 hover:text-primary-700"
            >
              Conhecer a Lívia
              <ArrowUpRight className="size-4" aria-hidden="true" />
            </a>
          </div>

          <p className="mt-6 flex items-center gap-2 text-sm text-ink-500">
            <Check className="size-4 text-primary" aria-hidden="true" strokeWidth={2.5} />
            Para clínicas, odontologia, pets, salões e serviços locais.
          </p>
        </div>

        <div className="relative mx-auto w-full max-w-xl lg:max-w-none">
          <div className="rounded-[22px] border border-line bg-surface-muted p-3 shadow-e3 sm:p-5">
            <div className="overflow-hidden rounded-card border border-line bg-white shadow-e1">
              <div className="flex items-center justify-between border-b border-line bg-surface-muted px-4 py-3 sm:px-5">
                <div className="flex items-center gap-3">
                  <span className="grid size-9 place-items-center rounded-full bg-primary-100 text-primary-700">
                    <Bot className="size-5" aria-hidden="true" />
                  </span>
                  <div>
                    <p className="text-sm font-semibold text-ink-900">Lívia</p>
                    <p className="text-xs text-ink-500">Atendimento em andamento</p>
                  </div>
                </div>
                <span className="size-2.5 rounded-full bg-success" aria-label="Atendimento ativo" />
              </div>

              <div className="space-y-5 p-5 sm:p-6">
                <div className="max-w-[88%] rounded-2xl rounded-tl-sm bg-ink-100 px-4 py-3 text-sm leading-6 text-ink-700 sm:max-w-[78%]">
                  Olá, gostaria de marcar uma avaliação.
                </div>
                <div className="ml-auto max-w-[92%] rounded-2xl rounded-tr-sm bg-primary px-4 py-3 text-sm leading-6 text-white sm:max-w-[82%]">
                  Claro. Posso verificar os horários disponíveis para você.
                </div>
                <div className="flex flex-wrap gap-2 border-t border-line pt-5">
                  <span className="rounded-full bg-primary-50 px-3 py-1.5 text-xs font-semibold text-primary-700">Atendimento com IA</span>
                  <span className="rounded-full bg-surface-subtle px-3 py-1.5 text-xs font-semibold text-ink-600">Agenda</span>
                  <span className="rounded-full bg-surface-subtle px-3 py-1.5 text-xs font-semibold text-ink-600">Encaminhamento humano</span>
                </div>
              </div>
            </div>
          </div>
          <div className="absolute -bottom-5 -left-3 hidden rounded-card border border-primary-100 bg-white px-4 py-3 shadow-e2 sm:flex sm:items-center sm:gap-3 lg:-left-8">
            <span className="grid size-8 place-items-center rounded-full bg-primary-50 text-primary-700">
              <CalendarDays className="size-4" aria-hidden="true" />
            </span>
            <span className="text-sm font-medium text-ink-700">Atendimento com contexto</span>
          </div>
        </div>
      </section>

      <section className="border-y border-line bg-surface-muted">
        <div className="mx-auto w-full max-w-7xl px-5 py-16 sm:px-8 sm:py-20 lg:px-10">
          <div className="max-w-xl">
            <p className="text-sm font-semibold text-primary-700">Como a Lívia ajuda</p>
            <h2 className="mt-3 text-3xl font-bold tracking-[-0.035em] text-ink-900 sm:text-4xl">Atendimento presente, mesmo quando sua equipe está ocupada.</h2>
          </div>

          <div className="mt-10 grid gap-4 md:grid-cols-3">
            {capabilities.map(({ icon: Icon, title, description }) => (
              <article key={title} className="rounded-card border border-line bg-white p-6 shadow-e1">
                <span className="grid size-10 place-items-center rounded-control bg-primary-50 text-primary-700">
                  <Icon className="size-5" aria-hidden="true" />
                </span>
                <h3 className="mt-5 text-lg font-semibold tracking-[-0.015em] text-ink-900">{title}</h3>
                <p className="mt-2 text-sm leading-6 text-ink-600">{description}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className="mx-auto w-full max-w-7xl px-5 py-20 sm:px-8 sm:py-28 lg:px-10">
        <div className="rounded-lg border border-primary-100 bg-primary-50 px-6 py-12 text-center sm:px-10 sm:py-16">
          <p className="text-sm font-semibold text-primary-700">Lívia para o seu negócio</p>
          <h2 className="mx-auto mt-3 max-w-2xl text-3xl font-bold tracking-[-0.035em] text-ink-900 sm:text-4xl">
            Seu atendimento começa antes mesmo de você pegar no celular.
          </h2>
          <p className="mx-auto mt-4 max-w-xl text-base leading-7 text-ink-600">
            Conheça uma forma mais organizada e humana de acompanhar as conversas do seu negócio.
          </p>
          <Link
            href="/login"
            className="mt-7 inline-flex min-h-12 items-center justify-center gap-2 rounded-control bg-primary px-5 py-3 text-base font-semibold text-white shadow-e2 transition-colors hover:bg-primary-hover"
          >
            Entrar na Lívia
            <ArrowUpRight className="size-4" aria-hidden="true" />
          </Link>
        </div>
      </section>

      <footer className="border-t border-line">
        <div className="mx-auto flex w-full max-w-7xl flex-col gap-3 px-5 py-7 text-sm text-ink-500 sm:flex-row sm:items-center sm:justify-between sm:px-8 lg:px-10">
          <p><span className="font-semibold text-ink-700">Lívia</span> · Produto da Conect Web</p>
          <a
            href="https://livia.conectweb.online"
            target="_blank"
            rel="noreferrer"
            className="inline-flex w-fit items-center gap-1 font-medium text-ink-600 transition-colors hover:text-primary-700"
          >
            livia.conectweb.online
            <ArrowUpRight className="size-3.5" aria-hidden="true" />
          </a>
        </div>
      </footer>
    </main>
  );
}
