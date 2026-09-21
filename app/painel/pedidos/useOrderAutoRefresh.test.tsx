// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { ORDER_REFRESH_INTERVAL_MS, useOrderAutoRefresh } from "./useOrderAutoRefresh";

function Probe({ refresh }: { refresh: () => Promise<void> }) {
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
});
