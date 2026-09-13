import Image from "next/image";
import Link from "next/link";

export default function Home() {
  return (
    <main className="flex min-h-screen flex-col bg-surface-muted px-5 text-ink-900 sm:px-8">
      <section className="mx-auto flex w-full max-w-lg flex-1 items-center justify-center py-12 sm:py-16">
        <div className="w-full rounded-card border border-line bg-white px-6 py-10 text-center shadow-e2 sm:px-12 sm:py-14">
          <Image
            src="/livia-icon-oficial-master.png"
            alt="Lívia"
            width={112}
            height={112}
            priority
            className="mx-auto size-24 rounded-[22px] object-cover shadow-e1 sm:size-28"
          />

          <h1 className="mt-7 text-4xl font-bold tracking-[-0.045em] text-ink-900 sm:text-5xl">
            Lívia
          </h1>
          <p className="mt-3 text-lg font-semibold text-primary-700">
            Recepcionista inteligente para WhatsApp
          </p>
          <p className="mx-auto mt-5 max-w-sm text-base leading-7 text-ink-600 sm:text-lg">
            Atendimento inteligente para organizar conversas, agendamentos e a rotina do seu negócio.
          </p>

          <Link
            href="/login"
            className="mt-9 inline-flex min-h-12 items-center justify-center rounded-control bg-primary px-7 py-3 text-base font-semibold text-white shadow-e2 transition-colors hover:bg-primary-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
          >
            Entrar
          </Link>
        </div>
      </section>

      <footer className="py-6 text-center text-sm font-medium text-ink-500">
        Conect Web
      </footer>
    </main>
  );
}
