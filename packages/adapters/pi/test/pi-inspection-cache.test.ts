import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";
import { harnessThinkingOptionIdSchema } from "@codexhost/shared-contracts";

import { PiAdapter, type PiTurnTransport } from "../src/pi-adapter.js";

vi.mock("../src/pi-credential-imports.js", () => ({
  createPiCredentialImports: () => ({
    providers: [],
    list: async () => [],
    add: async () => undefined,
    reimport: async () => undefined,
    remove: async () => undefined,
  }),
}));

function inspectionTransport(models: string[], startGate?: Promise<void>): PiTurnTransport {
  return {
    state: {
      sessionId: "inspection",
      provider: "synthetic-provider",
      modelId: models[0],
      thinkingLevel: harnessThinkingOptionIdSchema.parse("high"),
    },
    start: vi.fn(async () => startGate),
    getAvailableModels: vi.fn(async () =>
      models.map((id) => ({ provider: "synthetic-provider", id, reasoning: true })),
    ),
    getAvailableThinkingLevels: vi.fn(async () => [harnessThinkingOptionIdSchema.parse("high")]),
    close: vi.fn(async () => undefined),
  } as unknown as PiTurnTransport;
}

describe("Pi inspection cache and credential changes", () => {
  it("drops an inspection that started before a credential change", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "pi-inspection-race-"));
    const inspectionCacheFile = path.join(directory, "pi-inspection-v1.json");
    let releaseStale!: () => void;
    const staleGate = new Promise<void>((resolve) => (releaseStale = resolve));
    const createTransport = vi
      .fn()
      .mockReturnValueOnce(inspectionTransport(["removed-model"], staleGate))
      .mockReturnValue(inspectionTransport(["kept-model"]));
    const adapter = new PiAdapter({ inspectionCacheFile }, { createTransport });
    try {
      const stale = adapter.inspect({ cwd: "/synthetic" });
      await vi.waitFor(() => expect(createTransport).toHaveBeenCalledOnce());
      await adapter.credentialImports.remove("removed-provider");

      // A request after the change neither joins nor receives the stale inspection.
      const fresh = await adapter.inspect({ cwd: "/synthetic" });
      expect(JSON.stringify(fresh)).toContain("kept-model");
      releaseStale();
      expect(JSON.stringify(await stale)).toContain("removed-model");

      const served = await adapter.inspect({ cwd: "/synthetic" });
      expect(JSON.stringify(served)).toContain("kept-model");
      expect(JSON.stringify(served)).not.toContain("removed-model");
      const persisted = await readFile(inspectionCacheFile, "utf8");
      expect(persisted).toContain("kept-model");
      expect(persisted).not.toContain("removed-model");
      expect(createTransport).toHaveBeenCalledTimes(2);
    } finally {
      await adapter.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
