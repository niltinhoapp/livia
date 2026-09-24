import { createHash } from "node:crypto";

function canonicalOperationValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalOperationValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([key]) => !key.startsWith("__"))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, nested]) => [key, canonicalOperationValue(nested)]));
}

export function operationSemanticKey(toolName: string, args: Record<string, unknown>): string {
  return `${toolName}:${JSON.stringify(canonicalOperationValue(args))}`;
}

export function stableToolOperationId(
  inboundScope: string,
  toolName: string,
  args: Record<string, unknown>,
  occurrence = 0,
): string {
  const semantic = JSON.stringify(canonicalOperationValue(args));
  const digest = createHash("sha256").update(`${inboundScope}\n${toolName}\n${semantic}\n${occurrence}`).digest("hex");
  return `waop_${digest}`;
}
