// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { ORDER_REFRESH_INTERVAL_MS, useOrderAutoRefresh } from "./useOrderAutoRefresh";

function Probe({ refresh }: { refresh: (signal: AbortSignal) => Promise<void> }) {
  useOrderAutoRefresh(refresh);
  return null;
}

afterEach(() => { cleanup(); vi.useRealTimers(); });

describe("useOrderAutoRefresh", () => {
  it("atualiza em intervalo moderado e remove interval/listener ao desmontar", async () => {
    vi.useFakeTimers();
    const refresh = vi.fn(async () => undefined);
    const { unmount } = render(<Probe refresh={refresh} />);
    await vi.advanceTimersByTimeAsync(ORDER_REFRESH_INTERVAL_MS - 1);
    expect(refresh).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(refresh).toHaveBeenCalledTimes(1);
    unmount();
    await vi.advanceTimersByTimeAsync(ORDER_REFRESH_INTERVAL_MS * 2);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("não acumula refresh lento e aborta a requisição pendente ao desmontar", async () => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    const refresh = vi.fn((nextSignal: AbortSignal) => {
      signals.push(nextSignal);
      return new Promise<void>(() => undefined);
    });
    const { unmount } = render(<Probe refresh={refresh} />);
    await vi.advanceTimersByTimeAsync(ORDER_REFRESH_INTERVAL_MS * 3);
    expect(refresh).toHaveBeenCalledTimes(1);
    unmount();
    expect(signals[0]?.aborted).toBe(true);
  });

  it("mantém um único timer após rerender e atualiza ao voltar para aba visível", async () => {
    vi.useFakeTimers();
    const before = Object.getOwnPropertyDescriptor(document, "visibilityState");
    let visibility: DocumentVisibilityState = "hidden";
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
    const first = vi.fn(async () => undefined);
    const second = vi.fn(async () => undefined);
    const { rerender } = render(<Probe refresh={first} />);
    rerender(<Probe refresh={second} />);
    await vi.advanceTimersByTimeAsync(ORDER_REFRESH_INTERVAL_MS);
    expect(first).not.toHaveBeenCalled(); expect(second).not.toHaveBeenCalled();
    visibility = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
    await Promise.resolve();
    expect(second).toHaveBeenCalledTimes(1);
    if (before) Object.defineProperty(document, "visibilityState", before);
  });
});
