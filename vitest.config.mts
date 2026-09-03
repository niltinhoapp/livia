import { defineConfig } from "vitest/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dirname = path.dirname(fileURLToPath(import.meta.url));

// Testes unitários da lógica pura (sem Firebase/OpenAI/Next runtime) — ver
// lib/ai/*.test.ts. Não roda contra Firestore nem chama a API da OpenAI.
export default defineConfig({
  resolve: {
    alias: { "@": dirname },
  },
  test: {
    environment: "node",
    include: ["**/*.test.ts"],
    exclude: ["node_modules/**", ".next/**"],
  },
});
