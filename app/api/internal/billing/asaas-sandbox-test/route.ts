import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE_NAME } from "@/lib/auth/session";
import { requirePlatformAdmin } from "@/lib/auth/platformAdmin";
import {
  createSandboxHarnessDependencies,
  executeAsaasSandboxHarness,
  isAsaasSandboxHarnessEnabled,
  parseSandboxHarnessCommand,
  type SandboxHarnessFailureCode,
} from "@/lib/billing/asaasSandboxHarness";

function failureStatus(code: SandboxHarnessFailureCode | "asaas_auth_failed"): number {
  if (code === "test_establishment_not_found") return 404;
  if (
    code === "customer_conflict" ||
    code === "subscription_conflict" ||
    code === "test_establishment_invalid"
  ) {
    return 409;
  }
  return 502;
}

export async function POST(req: NextRequest) {
  const authority = await requirePlatformAdmin(req.cookies.get(SESSION_COOKIE_NAME)?.value);
  if (authority.status === "unauthenticated") {
    return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 });
  }
  if (authority.status !== "authorized") {
    return NextResponse.json({ error: "FORBIDDEN" }, { status: 403 });
  }

  const environment = {
    VERCEL_ENV: process.env.VERCEL_ENV,
    ASAAS_ENVIRONMENT: process.env.ASAAS_ENVIRONMENT,
    ASAAS_API_KEY: process.env.ASAAS_API_KEY,
  };
  if (!isAsaasSandboxHarnessEnabled(environment)) {
    return NextResponse.json({ error: "SANDBOX_HARNESS_DISABLED" }, { status: 404 });
  }

  const command = parseSandboxHarnessCommand(await req.json().catch(() => null));
  if (!command) {
    return NextResponse.json({ error: "INVALID_PAYLOAD" }, { status: 400 });
  }

  try {
    const dependencies = await createSandboxHarnessDependencies(environment.ASAAS_API_KEY!);
    const result = await executeAsaasSandboxHarness(command, dependencies);
    if (!result.ok) {
      return NextResponse.json(result, { status: failureStatus(result.code) });
    }
    return NextResponse.json(result);
  } catch {
    return NextResponse.json({ error: "INTERNAL_ERROR" }, { status: 500 });
  }
}
