import { constants, readFileSync, statSync } from "node:fs";
import { open, realpath } from "node:fs/promises";
import path from "node:path";

import { activePiEntries, type PiSessionHistory } from "./pi-history.js";
import { parsePiSubagentStatus, type PiSubagentNode, type PiSubagents } from "./pi-subagents.js";

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function state(value: unknown): unknown {
  return value === "pending" ? "queued" : value === "completed" ? "complete" : value;
}

/**
 * Project only documented lifecycle v3 artifacts; do not import the plugin's private runtime.
 * pi-subagents records the parent's session file as the owner when it has one, so ownership
 * accepts any of the parent Session's identities; `null` skips it for the live parent's receipt.
 */
export function piSubagentArtifact(
  value: unknown,
  runId: string,
  owners: ReadonlySet<string> | null,
): PiSubagentNode[] | null {
  if (
    !record(value) ||
    value.lifecycleArtifactVersion !== 3 ||
    value.runId !== runId ||
    (owners !== null && (typeof value.sessionId !== "string" || !owners.has(value.sessionId))) ||
    !["single", "parallel", "chain", "workflow"].includes(String(value.mode))
  )
    return null;
  if (value.steps !== undefined && (!Array.isArray(value.steps) || value.steps.length > 128))
    return null;
  const steps = Array.isArray(value.steps) ? value.steps : [];
  const children: Record<string, unknown>[] = [];
  for (const [index, step] of steps.entries()) {
    if (!record(step) || typeof step.agent !== "string") return null;
    children.push({
      id: step.workflowKey ?? step.runId ?? `step:${index}`,
      kind: "step",
      label: step.label ?? step.agent,
      state: state(step.status),
    });
  }
  return parsePiSubagentStatus({
    type: "extension_ui_request",
    method: "setWidget",
    widgetKey: "subagent-async",
    widgetLines: [
      "PI_SUBAGENT_ASYNC_JSON:" +
        JSON.stringify({
          kind: "pi-subagents.async-status-snapshot",
          version: 1,
          runs: [
            {
              id: runId,
              kind: value.mode === "single" ? "subagent" : "workflow",
              label: "Pi subagent",
              state: value.state,
              children,
            },
          ],
        }),
    ],
  });
}

const MAX_STATUS_BYTES = 1024 * 1024;

async function readStatusArtifact(directory: string): Promise<unknown> {
  const file = await open(
    path.join(directory, "status.json"),
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > MAX_STATUS_BYTES) return undefined;
    const buffer = Buffer.alloc(MAX_STATUS_BYTES + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_STATUS_BYTES) return undefined;
    return JSON.parse(buffer.subarray(0, bytesRead).toString("utf8"));
  } finally {
    await file.close();
  }
}

/**
 * The child Session file of a single async run, resolved from the parent's own launch receipt
 * and the run's status.json. pi-subagents stores child Sessions under the parent Session file's
 * sibling directory; anything outside it is refused, so a status file cannot redirect reads.
 */
export async function piSingleSubagentSessionFile(
  history: PiSessionHistory,
  runId: string,
  parentSessionId: string,
  parentSessionFile: string,
): Promise<string | null> {
  const receipt = activePiEntries(history).findLast(
    ({ message }) =>
      record(message) &&
      message.role === "toolResult" &&
      message.toolName === "subagent" &&
      record(message.details) &&
      message.details.mode === "single" &&
      message.details.asyncId === runId,
  )?.message;
  const directory = record(receipt) && record(receipt.details) ? receipt.details.asyncDir : null;
  if (
    typeof directory !== "string" ||
    !path.isAbsolute(directory) ||
    path.basename(directory) !== runId ||
    !path.isAbsolute(parentSessionFile) ||
    path.extname(parentSessionFile) !== ".jsonl"
  )
    return null;
  const value = await readStatusArtifact(directory);
  if (
    !record(value) ||
    value.lifecycleArtifactVersion !== 3 ||
    value.runId !== runId ||
    value.mode !== "single" ||
    (value.sessionId !== parentSessionId && value.sessionId !== parentSessionFile)
  )
    return null;
  const step = Array.isArray(value.steps) && record(value.steps[0]) ? value.steps[0] : {};
  const file = step.sessionFile ?? value.sessionFile;
  if (typeof file !== "string" || !path.isAbsolute(file)) return null;
  // Compare resolved paths so a symlinked or junctioned directory cannot lead outside the root.
  const [root, target] = await Promise.all([
    realpath(parentSessionFile.slice(0, -".jsonl".length)),
    realpath(file),
  ]);
  const relative = path.relative(root, target);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative) ? target : null;
}

/** Restored cards use parent-owned native receipts, never arbitrary filesystem paths supplied by the UI. */
export async function restorePiSubagents(
  history: PiSessionHistory,
  owners: ReadonlySet<string>,
  observer: PiSubagents,
): Promise<void> {
  const receipts = new Map<string, string>();
  for (const entry of activePiEntries(history)) {
    if (
      !record(entry.message) ||
      entry.message.role !== "toolResult" ||
      entry.message.toolName !== "subagent" ||
      entry.message.isError !== false ||
      !record(entry.message.details)
    )
      continue;
    const details = entry.message.details;
    if (
      !["single", "parallel", "chain", "workflow"].includes(String(details.mode)) ||
      typeof details.asyncId !== "string" ||
      typeof details.asyncDir !== "string" ||
      !path.isAbsolute(details.asyncDir) ||
      path.basename(details.asyncDir) !== details.asyncId
    )
      continue;
    receipts.set(details.asyncId, details.asyncDir);
  }
  // Bound history I/O. Missing, pruned, foreign and future-version artifacts remain ordinary tools.
  for (const [id, directory] of [...receipts].slice(-128)) {
    try {
      const runs = piSubagentArtifact(await readStatusArtifact(directory), id, owners);
      if (runs) observer.restore(runs);
    } catch {
      // Artifact retention and status publication races are not parent Session failures.
    }
  }
}

/**
 * The live launch receipt can arrive before the run's first status snapshot. Read the run's
 * status.json from the receipt; a single run without one is shown as running.
 */
export function piSubagentReceiptRuns(runId: string, details: unknown): PiSubagentNode[] | null {
  if (
    !record(details) ||
    typeof details.asyncDir !== "string" ||
    !path.isAbsolute(details.asyncDir) ||
    path.basename(details.asyncDir) !== runId
  )
    return null;
  try {
    const file = path.join(details.asyncDir, "status.json");
    if (statSync(file).size <= 1024 * 1024) {
      const runs = piSubagentArtifact(JSON.parse(readFileSync(file, "utf8")), runId, null);
      if (runs) return runs;
    }
  } catch {
    // Not written yet, pruned, or mid-write.
  }
  return details.mode === "single"
    ? [{ id: runId, kind: "subagent", label: "Pi subagent", state: "running" }]
    : null;
}
