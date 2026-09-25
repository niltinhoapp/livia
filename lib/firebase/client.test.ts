import { describe, expect, it, vi } from "vitest";

let capturedParams: Record<string, string> | undefined;

vi.mock("firebase/app", () => ({
  getApps: () => [],
  getApp: () => ({}),
  initializeApp: () => ({}),
}));

vi.mock("firebase/auth", () => {
  class MockGoogleAuthProvider {
    providerId = "google.com";
    customParameters: Record<string, string> = {};
    setCustomParameters(params: Record<string, string>) {
      this.customParameters = { ...this.customParameters, ...params };
      capturedParams = this.customParameters;
      return this;
    }
  }
  return {
    getAuth: () => ({}),
    GoogleAuthProvider: MockGoogleAuthProvider,
  };
});

describe("Google Auth provider", () => {
  it("requests account selection on every login", async () => {
    await import("./client");
    expect(capturedParams).toBeDefined();
    expect(capturedParams!.prompt).toBe("select_account");
  });
});
