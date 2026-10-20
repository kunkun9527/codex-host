import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { HostEvent } from "@codexhost/harness-adapter";
import { hostItemIdSchema, hostTurnIdSchema } from "@codexhost/shared-contracts";
import { PiSubagents, piSubagentId } from "../src/pi-subagents.js";
import {
  piSubagentArtifact,
  piSubagentReceiptRuns,
  restorePiSubagents,
} from "../src/pi-subagent-history.js";
import type { PiSessionHistory } from "../src/pi-history.js";

const status = {
  lifecycleArtifactVersion: 3,
  runId: "run-1",
  sessionId: "parent",
  mode: "workflow",
  state: "complete",
  steps: [{ workflowKey: "review", agent: "reviewer", status: "completed" }],
};

describe("Pi subagent history restoration", () => {
  it("accepts only known artifact versions owned by the exact parent Session", () => {
    expect(piSubagentArtifact(status, "run-1", new Set(["parent"]))?.[0]?.children).toEqual([
      { id: "review", kind: "step", label: "reviewer", state: "complete" },
    ]);
    expect(piSubagentArtifact(status, "run-1", new Set(["foreign"]))).toBeNull();
    expect(piSubagentArtifact(status, "wrong-run", new Set(["parent"]))).toBeNull();
    expect(
      piSubagentArtifact({ ...status, lifecycleArtifactVersion: 4 }, "run-1", new Set(["parent"])),
    ).toBeNull();
    expect(
      piSubagentArtifact(
        { ...status, steps: [{ ...status.steps[0], status: "future" }] },
        "run-1",
        new Set(["parent"]),
      ),
    ).toBeNull();
    // pi-subagents records the parent's session file as owner when the Session has one.
    const file = path.join(os.tmpdir(), "parent.jsonl");
    expect(
      piSubagentArtifact({ ...status, sessionId: file }, "run-1", new Set(["parent", file])),
    ).not.toBeNull();
  });

  it("shows a card from the launch receipt when the Turn ends before the first snapshot", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "pi-subagent-receipt-"));
    try {
      const asyncDir = path.join(dir, "run-1");
      await mkdir(asyncDir);
      await writeFile(path.join(asyncDir, "status.json"), JSON.stringify(status));
      const events: HostEvent[] = [];
      const observer = new PiSubagents((event) => events.push(event), piSubagentReceiptRuns);
      const turnId = hostTurnIdSchema.parse("turn-1");
      const receipt = { details: { mode: "workflow", asyncId: "run-1", asyncDir } };
      observer.start(turnId, "subagent", receipt, hostItemIdSchema.parse("item"));
      expect(events).toEqual([]);
      observer.finish(turnId);
      expect(events.find((event) => event.type === "item.started")).toMatchObject({
        item: { type: "subagentDelegation", subagents: [{ status: "completed" }] },
      });
      expect(events.find((event) => event.type === "item.completed")).toBeDefined();

      const missing = path.join(dir, "run-2");
      expect(piSubagentReceiptRuns("run-2", { mode: "single", asyncDir: missing })).toEqual([
        { id: "run-2", kind: "subagent", label: "Pi subagent", state: "running" },
      ]);
      expect(piSubagentReceiptRuns("run-2", { mode: "chain", asyncDir: missing })).toBeNull();
      expect(piSubagentReceiptRuns("run-1", { mode: "single", asyncDir: missing })).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("restores native receipts without events and gracefully skips deleted or foreign artifacts", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "pi-subagent-history-"));
    try {
      const asyncDir = path.join(dir, "run-1");
      await mkdir(asyncDir);
      await writeFile(path.join(asyncDir, "status.json"), JSON.stringify(status));
      const result = {
        role: "toolResult",
        toolName: "subagent",
        isError: false,
        details: { mode: "workflow", asyncId: "run-1", asyncDir },
      };
      const history: PiSessionHistory = {
        leafId: "result",
        entries: [{ id: "result", parentId: null, type: "message", message: result }],
      };
      const emit = vi.fn();
      const observer = new PiSubagents(emit);
      await restorePiSubagents(history, new Set(["foreign"]), observer);
      expect(observer.project("subagent", result, hostItemIdSchema.parse("item"))).toBeNull();
      await restorePiSubagents(history, new Set(["parent"]), observer);
      expect(observer.project("subagent", result, hostItemIdSchema.parse("item"))).toMatchObject({
        subagents: [
          {
            nativeSubagentId: piSubagentId({ runId: "run-1", childId: "review" }),
            status: "completed",
          },
        ],
      });
      expect(emit).not.toHaveBeenCalled();
      await rm(path.join(asyncDir, "status.json"));
      await expect(
        restorePiSubagents(history, new Set(["parent"]), new PiSubagents(emit)),
      ).resolves.toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
