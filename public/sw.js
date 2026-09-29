// Service worker do painel da Lívia: só avisos de atendimento humano.
// O aviso não é estado — tocar abre a conversa, e o painel mostra a verdade.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

function safePanelPath(value) {
  // Só caminhos do próprio painel: nenhum link externo sai de um push.
  return typeof value === "string" && value.startsWith("/painel/") ? value : "/painel/conversas";
}

self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch (_) {
    payload = {};
  }
  const data = (payload && payload.data) || payload || {};
  const title = typeof data.title === "string" && data.title ? data.title : "Atendimento humano";
  const body = typeof data.body === "string" && data.body ? data.body : "Um cliente precisa de atendimento.";
  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      tag: typeof data.tag === "string" ? data.tag : "handoff",
      renotify: true,
      icon: "/livia-icon-oficial-master.png",
      badge: "/livia-icon-oficial-master.png",
      data: { url: safePanelPath(data.url) },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = new URL(safePanelPath(event.notification.data && event.notification.data.url), self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if (client.url.startsWith(self.location.origin) && "focus" in client) {
          return client.navigate(target).then((navigated) => (navigated || client).focus());
        }
      }
      return self.clients.openWindow(target);
    }),
  );
});
