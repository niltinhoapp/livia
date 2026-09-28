// Catálogo fictício do ambiente de demonstração (F2).
//
// Diferente da agenda, o cardápio NÃO é materializado em memória: ele é
// semeado como documento real em `menuCategories`/`menuProducts` do tenant de
// demonstração, pelas MESMAS funções que o painel usa
// (saveMenuCategory/saveMenuProduct em lib/orders.ts).
//
// Por que a assimetria com a agenda é deliberada:
//
//   - a agenda é indexada por DATA. Semear ocupação exigiria rolar as datas
//     adiante para sempre, então o baseline é um padrão materializado por
//     data consultada;
//   - o cardápio é atemporal. Um seed idempotente é a representação mais
//     honesta possível: o prospect recebe preço, variação e adicional lidos
//     do Firestore pelas tools reais, e nada é inventado em runtime.
//
// O catálogo é COMUM a todos os prospects — é o cardápio do estabelecimento
// fictício, não um dado de sessão. O isolamento por prospect acontece no
// PEDIDO (mode: "demo" + prospectingLeadId, com assertDraftScope em
// lib/orders.ts), nunca no catálogo.
//
// Ids fixos com prefixo `demo-` tornam o seed idempotente: rodar duas vezes
// atualiza os mesmos documentos em vez de duplicar o cardápio.
import type { MenuCategory, MenuProduct, OrderSettings } from "@/types";

export interface DemoCatalogCategory {
  id: string;
  name: string;
  sortOrder: number;
}

export type DemoCatalogProduct = Pick<
  MenuProduct,
  "id" | "categoryId" | "name" | "description" | "basePriceCents" | "variants" | "modifierGroups"
>;

export const DEMO_CATALOG_CATEGORIES: DemoCatalogCategory[] = [
  { id: "demo-cat-lanches", name: "Lanches", sortOrder: 1 },
  { id: "demo-cat-pizzas", name: "Pizzas", sortOrder: 2 },
  { id: "demo-cat-bebidas", name: "Bebidas", sortOrder: 3 },
];

export const DEMO_CATALOG_PRODUCTS: DemoCatalogProduct[] = [
  {
    id: "demo-prod-xburger",
    categoryId: "demo-cat-lanches",
    name: "X-Burger",
    description: "Hambúrguer, queijo, alface, tomate e cebola",
    basePriceCents: 2400,
    variants: [],
    // Grupo OPCIONAL: é o que permite "2 X-Burgers sem cebola" sair do
    // catálogo real, com preço do backend, em vez de o modelo inventar a
    // remoção. Remover não altera o preço (delta 0); adicionar, sim.
    modifierGroups: [
      {
        id: "demo-grp-xburger-personalizar",
        name: "Personalizar",
        required: false,
        minSelections: 0,
        maxSelections: 3,
        options: [
          { id: "demo-opt-sem-cebola", name: "Sem cebola", priceDeltaCents: 0, active: true },
          { id: "demo-opt-sem-picles", name: "Sem picles", priceDeltaCents: 0, active: true },
          { id: "demo-opt-bacon", name: "Bacon extra", priceDeltaCents: 500, active: true },
        ],
      },
    ],
  },
  {
    id: "demo-prod-xsalada",
    categoryId: "demo-cat-lanches",
    name: "X-Salada",
    description: "Hambúrguer, queijo, alface, tomate e maionese da casa",
    basePriceCents: 2600,
    variants: [],
    modifierGroups: [],
  },
  {
    id: "demo-prod-pizza-margherita",
    categoryId: "demo-cat-pizzas",
    name: "Pizza Margherita",
    description: "Molho de tomate, muçarela e basílico",
    basePriceCents: 4900,
    // Variação: prova que tamanho muda o preço pelo backend.
    variants: [
      { id: "demo-var-pizza-media", name: "Média", priceDeltaCents: 0, active: true },
      { id: "demo-var-pizza-grande", name: "Grande", priceDeltaCents: 1600, active: true },
    ],
    // Grupo OBRIGATÓRIO: prova a regra "pergunte antes de adicionar" — o
    // backend recusa o item sem uma escolha de borda.
    modifierGroups: [
      {
        id: "demo-grp-pizza-borda",
        name: "Borda",
        required: true,
        minSelections: 1,
        maxSelections: 1,
        options: [
          { id: "demo-opt-borda-simples", name: "Sem borda recheada", priceDeltaCents: 0, active: true },
          { id: "demo-opt-borda-catupiry", name: "Borda de catupiry", priceDeltaCents: 900, active: true },
        ],
      },
    ],
  },
  {
    id: "demo-prod-coca",
    categoryId: "demo-cat-bebidas",
    name: "Coca-Cola",
    description: null,
    basePriceCents: 800,
    variants: [
      { id: "demo-var-coca-lata", name: "Lata 350ml", priceDeltaCents: 0, active: true },
      { id: "demo-var-coca-600", name: "Garrafa 600ml", priceDeltaCents: 400, active: true },
    ],
    modifierGroups: [],
  },
  {
    id: "demo-prod-suco",
    categoryId: "demo-cat-bebidas",
    name: "Suco natural de laranja",
    description: "500ml",
    basePriceCents: 1000,
    variants: [],
    modifierGroups: [],
  },
];

/**
 * Configuração de pedidos do tenant de demonstração.
 *
 * `orderHours` fica `null` de propósito: a demonstração herda o expediente
 * canônico do estabelecimento, igual a um tenant real, para que a regra de
 * janela de recebimento seja demonstrada de verdade em vez de contornada.
 */
export const DEMO_ORDER_SETTINGS: Partial<OrderSettings> = {
  pickupEnabled: true,
  deliveryEnabled: true,
  deliveryRules: [
    { kind: "neighborhood", neighborhood: "Centro", feeCents: 500 },
    { kind: "fixed", feeCents: 900 },
  ],
  acceptedPaymentMethods: ["pix", "cash", "credit_card", "debit_card"],
  pixInstructions: "Chave PIX de demonstração: demo@conectweb.exemplo (nenhuma cobrança real é gerada).",
  orderHours: null,
};

export interface DemoCatalogSeedResult {
  categories: number;
  products: number;
}

const orderService = () => import("@/lib/orders");

/**
 * Semeia (ou atualiza) o cardápio fictício e a configuração de pedidos.
 *
 * Idempotente pelos ids fixos. Usa exclusivamente a API real de cardápio, que
 * valida preço, variação e grupo obrigatório — um catálogo de demonstração
 * inválido falha aqui, não na frente do prospect.
 */
export async function seedDemoCatalog(establishmentId: string): Promise<DemoCatalogSeedResult> {
  const { saveMenuCategory, saveMenuProduct, saveOrderSettings } = await orderService();

  for (const category of DEMO_CATALOG_CATEGORIES) {
    await saveMenuCategory(establishmentId, { name: category.name, active: true, sortOrder: category.sortOrder }, category.id);
  }
  for (const product of DEMO_CATALOG_PRODUCTS) {
    await saveMenuProduct(establishmentId, { ...product, active: true }, product.id);
  }
  await saveOrderSettings(establishmentId, DEMO_ORDER_SETTINGS);

  return { categories: DEMO_CATALOG_CATEGORIES.length, products: DEMO_CATALOG_PRODUCTS.length };
}

/** Só para asserção em teste/operação: os ids que o seed instala. */
export function demoCatalogIds(): { categories: string[]; products: string[] } {
  return {
    categories: DEMO_CATALOG_CATEGORIES.map((c) => c.id),
    products: DEMO_CATALOG_PRODUCTS.map((p) => p.id),
  };
}

export type DemoCatalogCategoryDoc = MenuCategory;
