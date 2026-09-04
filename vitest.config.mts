import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dirname = path.dirname(fileURLToPath(import.meta.url));

// Testes unitários da lógica pura (sem Firebase/OpenAI/Next runtime) — ver
// lib/ai/*.test.ts. Não roda contra Firestore nem chama a API da OpenAI.
//
// Environment default continua "node" (nenhum dos 258 testes existentes
// precisa de DOM, e trocar o default arriscaria regressão neles à toa).
// Os poucos arquivos .test.tsx que precisam de DOM (ver
// app/painel/conversas/page.messages.test.tsx) pedem jsdom por arquivo, via
// o comentário `// @vitest-environment jsdom` no topo do arquivo — suportado
// nativamente pelo Vitest, sem precisar de um segundo projeto/config.
//
// O plugin React só existe pra dar transform de JSX/TSX aos `.test.tsx`
// (o Next já faz isso pro app em si via SWC; o Vitest roda fora do Next e
// precisa do próprio transform). Não afeta nenhum `.test.ts` existente.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { "@": dirname },
  },
  test: {
    environment: "node",
    include: ["**/*.test.ts", "**/*.test.tsx"],
    exclude: ["node_modules/**", ".next/**"],
  },
});
