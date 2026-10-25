import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import { harnessInspectionSchema, type HarnessInspection } from "@codexhost/shared-contracts";

export type ReadyPiInspection = Extract<HarnessInspection, { status: "ready" }>;

export function codexhostDataDirectory(environment: NodeJS.ProcessEnv): string {
  return (
    environment.CODEXHOST_DATA_DIR ??
    path.join(environment.HOME ?? environment.USERPROFILE ?? homedir(), ".codexhost")
  );
}

export function piInspectionCacheFile(environment: NodeJS.ProcessEnv): string {
  return path.resolve(codexhostDataDirectory(environment), "cache", "pi-inspection-v1.json");
}

/**
 * Ready inspections from earlier Host runs, keyed by inspect cwd. Pi startup loads every
 * extension, so Host startup serves these and revalidates later instead of racing the Session
 * that is opening. A missing, unreadable, or invalid file is an empty cache.
 */
export class PiInspectionCache {
  readonly #file: string;
  #entries: Promise<Map<string, ReadyPiInspection>> | null = null;
  #writes: Promise<void> = Promise.resolve();

  constructor(file: string) {
    this.#file = file;
  }

  async get(cwd: string): Promise<ReadyPiInspection | undefined> {
    return (await this.#load()).get(cwd);
  }

  set(cwd: string, inspection: ReadyPiInspection): Promise<void> {
    return this.#update((entries) => entries.set(cwd, inspection));
  }

  delete(cwd: string): Promise<void> {
    return this.#update((entries) => entries.delete(cwd));
  }

  clear(): Promise<void> {
    return this.#update((entries) => entries.clear());
  }

  #load(): Promise<Map<string, ReadyPiInspection>> {
    this.#entries ??= readFile(this.#file, "utf8").then(parseEntries, () => new Map());
    return this.#entries;
  }

  #update(change: (entries: Map<string, ReadyPiInspection>) => unknown): Promise<void> {
    const write = this.#writes.then(async () => {
      const entries = await this.#load();
      change(entries);
      await this.#write(entries);
    });
    // One failed write must not block later ones; callers still observe their own failure.
    this.#writes = write.catch(() => undefined);
    return write;
  }

  async #write(entries: Map<string, ReadyPiInspection>): Promise<void> {
    await mkdir(path.dirname(this.#file), { recursive: true });
    const temporary = `${this.#file}.${randomUUID()}.tmp`;
    try {
      await writeFile(
        temporary,
        JSON.stringify({ version: 1, entries: Object.fromEntries(entries) }),
        { mode: 0o600 },
      );
      await rename(temporary, this.#file);
    } finally {
      await rm(temporary, { force: true });
    }
  }
}

function parseEntries(text: string): Map<string, ReadyPiInspection> {
  const entries = new Map<string, ReadyPiInspection>();
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return entries;
  }
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.entries)) return entries;
  for (const [cwd, candidate] of Object.entries(value.entries)) {
    const parsed = harnessInspectionSchema.safeParse(candidate);
    if (parsed.success && parsed.data.status === "ready") entries.set(cwd, parsed.data);
  }
  return entries;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
