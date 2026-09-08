import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { join } from "path";
import { closeDatabase, getDb, initDatabase } from "../../db/connection";
import {
  enqueueChatPipelineTask,
  resetChatPipelineCoordinatorForTests,
} from "../chat-pipeline-coordinator.service";
import { putCortexConfig } from "./config";
import * as consolidation from "./consolidation";
import {
  fingerprintChunkSource,
  processChunk,
  scheduleProcessChunk,
  type ChunkSourceRow,
} from "./index";
import type { HeuristicAnalysisOutput } from "./heuristic-runtime";

const USER_ID = "patch-c-user";
const CHAT_ID = "patch-c-chat";
const CHUNK_ID = "patch-c-chunk";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const heuristic: HeuristicAnalysisOutput = {
  salienceResult: {
    score: 0.4,
    source: "heuristic",
    emotionalTags: [],
    statusChanges: [],
    narrativeFlags: [],
    hasDialogue: false,
    hasAction: false,
    hasInternalThought: false,
    wordCount: 2,
  },
  entities: [],
  relationships: [],
  aliases: [],
  timings: { totalMs: 0, salienceMs: 0, entityMs: 0, relationshipMs: 0, aliasMs: 0 },
};

async function applyBaseline(): Promise<void> {
  const db = getDb();
  db.run("PRAGMA foreign_keys = OFF");
  db.run(await Bun.file(join(import.meta.dir, "..", "..", "db", "baseline.sql")).text());
  db.run(await Bun.file(join(import.meta.dir, "..", "..", "db", "migrations", "066_chat_chunks_cortex_warmup.sql")).text());
}

function seedChunk(content = "Melina waits.", updatedAt = 10): void {
  const db = getDb();
  db.query(
    `INSERT INTO chats (id, user_id, character_id, name, metadata, created_at, updated_at)
     VALUES (?, ?, 'dummy-character', 'Patch C', '{}', 1, 1)`,
  ).run(CHAT_ID, USER_ID);
  db.query(
    `INSERT INTO messages (id, chat_id, index_in_chat, is_user, name, content, send_date, created_at)
     VALUES ('m1', ?, 0, 0, 'Melina', ?, 1, 1)`,
  ).run(CHAT_ID, content);
  db.query(
    `INSERT INTO chat_chunks
       (id, chat_id, start_message_id, end_message_id, message_ids, content,
        token_count, message_count, created_at, updated_at)
     VALUES (?, ?, 'm1', 'm1', '["m1"]', ?, 3, 1, 1, ?)`,
  ).run(CHUNK_ID, CHAT_ID, content, updatedAt);
}

function sourceRow(): ChunkSourceRow {
  return getDb().query(
    `SELECT id, chat_id, start_message_id, end_message_id, message_ids, content,
            token_count, message_count, updated_at, created_at
     FROM chat_chunks WHERE id = ?`,
  ).get(CHUNK_ID) as ChunkSourceRow;
}

function data(content = "Melina waits.") {
  return {
    chunkId: CHUNK_ID,
    chatId: CHAT_ID,
    userId: USER_ID,
    characterId: null,
    content,
    messageIds: ["m1"],
    startMessageIndex: 0,
    endMessageIndex: 0,
    createdAt: 1,
  };
}

function derivedCounts() {
  const db = getDb();
  return {
    salience: (db.query("SELECT COUNT(*) AS c FROM memory_salience WHERE chunk_id = ?").get(CHUNK_ID) as any).c,
    entities: (db.query("SELECT COUNT(*) AS c FROM memory_entities WHERE chat_id = ?").get(CHAT_ID) as any).c,
    relations: (db.query("SELECT COUNT(*) AS c FROM memory_relations WHERE chat_id = ?").get(CHAT_ID) as any).c,
    fonts: (db.query("SELECT COUNT(*) AS c FROM memory_font_colors WHERE chat_id = ?").get(CHAT_ID) as any).c,
    signature: (db.query("SELECT cortex_warmup_signature AS value FROM chat_chunks WHERE id = ?").get(CHUNK_ID) as any)?.value,
  };
}

function configure(update: any): void {
  putCortexConfig(USER_ID, update);
}

describe("Patch C live Cortex ingestion generation and cancellation", () => {
  const restorables: Array<{ mockRestore: () => void }> = [];

  beforeEach(async () => {
    closeDatabase();
    resetChatPipelineCoordinatorForTests();
    initDatabase(":memory:");
    await applyBaseline();
    seedChunk();
    configure({
      enabled: true,
      entityTracking: false,
      salienceScoring: true,
      consolidation: { enabled: false },
    });
  });

  afterEach(() => {
    while (restorables.length > 0) restorables.pop()!.mockRestore();
    resetChatPipelineCoordinatorForTests();
    closeDatabase();
  });

  test("unchanged source generation commits salience and signature", async () => {
    const expected = fingerprintChunkSource(sourceRow());
    await processChunk(data(), ["Melina"], undefined, undefined, undefined, heuristic, undefined, expected);
    expect(derivedCounts().salience).toBe(1);
    expect(derivedCounts().signature).not.toBeNull();
  });

  test("fingerprint detects same-second append and every source-bearing field", () => {
    const row = sourceRow();
    const original = fingerprintChunkSource(row);
    const mutations: Partial<ChunkSourceRow>[] = [
      { id: "other" }, { chat_id: "other" }, { start_message_id: "m0" },
      { end_message_id: "m2" }, { message_ids: '["m1","m2"]' },
      { content: "changed" }, { token_count: 4 }, { message_count: 2 },
      { created_at: row.created_at + 1 },
    ];
    for (const mutation of mutations) {
      expect(fingerprintChunkSource({ ...row, ...mutation, updated_at: row.updated_at })).not.toBe(original);
    }
  });

  test("same-second revision is rejected immediately before main persistence", async () => {
    const expected = fingerprintChunkSource(sourceRow());
    const run = processChunk(data(), ["Melina"], undefined, undefined, undefined, heuristic, undefined, expected);
    getDb().query(
      `UPDATE chat_chunks SET content = 'revised', message_ids = '["m1","m2"]',
       end_message_id = 'm2', token_count = 4, message_count = 2 WHERE id = ?`,
    ).run(CHUNK_ID);
    await run;
    expect(derivedCounts()).toEqual({ salience: 0, entities: 0, relations: 0, fonts: 0, signature: null });
  });

  test("deleted chunk cannot commit", async () => {
    const expected = fingerprintChunkSource(sourceRow());
    const run = processChunk(data(), ["Melina"], undefined, undefined, undefined, heuristic, undefined, expected);
    getDb().query("DELETE FROM chat_chunks WHERE id = ?").run(CHUNK_ID);
    await run;
    expect((getDb().query("SELECT COUNT(*) AS c FROM memory_salience").get() as any).c).toBe(0);
  });

  test("font attribution is deferred into the validated transaction", async () => {
    configure({ enabled: true, entityTracking: true, salienceScoring: true });
    const fontContent = '<font color="#ff0000">Melina waits.</font>';
    getDb().query("UPDATE messages SET content = ? WHERE id = 'm1'").run(fontContent);
    getDb().query("UPDATE chat_chunks SET content = ? WHERE id = ?").run(fontContent, CHUNK_ID);
    getDb().query(
      `INSERT INTO memory_entities (id, chat_id, name, entity_type, created_at, updated_at)
       VALUES ('melina', ?, 'Melina', 'character', 1, 1)`,
    ).run(CHAT_ID);
    const expected = fingerprintChunkSource(sourceRow());

    await processChunk(data(fontContent), ["Melina"], undefined, undefined, undefined, heuristic, undefined, expected);
    expect(derivedCounts().fonts).toBe(1);
    const stored = getDb().query(
      "SELECT sample_excerpt FROM memory_font_colors WHERE chat_id = ? AND hex_color = '#ff0000'",
    ).get(CHAT_ID) as { sample_excerpt: string | null };
    expect(stored.sample_excerpt).toContain("Melina waits.");
  });

  test("stale font analysis creates and reinforces no color mapping", async () => {
    configure({ enabled: true, entityTracking: true, salienceScoring: true });
    const fontContent = '<font color="#ff0000">Melina waits.</font>';
    getDb().query("UPDATE messages SET content = ? WHERE id = 'm1'").run(fontContent);
    getDb().query("UPDATE chat_chunks SET content = ? WHERE id = ?").run(fontContent, CHUNK_ID);
    getDb().query(
      `INSERT INTO memory_entities (id, chat_id, name, entity_type, created_at, updated_at)
       VALUES ('melina', ?, 'Melina', 'character', 1, 1)`,
    ).run(CHAT_ID);
    getDb().query(
      `INSERT INTO memory_font_colors
       (id, chat_id, entity_id, hex_color, usage_type, confidence, sample_count,
        sample_excerpt, created_at, updated_at)
       VALUES ('existing-color', ?, 'melina', '#ff0000', 'speech', 0.9, 3,
               'original evidence', 1, 1)`,
    ).run(CHAT_ID);
    const expected = fingerprintChunkSource(sourceRow());
    const run = processChunk(data(fontContent), ["Melina"], undefined, undefined, undefined, heuristic, undefined, expected);
    getDb().query("UPDATE chat_chunks SET token_count = token_count + 1 WHERE id = ?").run(CHUNK_ID);

    await run;
    const stored = getDb().query(
      "SELECT sample_count, sample_excerpt FROM memory_font_colors WHERE id = 'existing-color'",
    ).get() as { sample_count: number; sample_excerpt: string };
    expect(stored).toEqual({ sample_count: 3, sample_excerpt: "original evidence" });
  });

  test("stale sidecar-derived font colors do not escape validation", async () => {
    configure({
      enabled: true,
      entityTracking: true,
      entityExtractionMode: "sidecar",
      sidecar: { connectionProfileId: "sidecar" },
      sidecarReliability: { maxRetries: 0, fallback: "heuristic" },
    });
    getDb().query(
      `INSERT INTO memory_entities (id, chat_id, name, entity_type, created_at, updated_at)
       VALUES ('melina', ?, 'Melina', 'character', 1, 1)`,
    ).run(CHAT_ID);
    const response = deferred<any>();
    const started = deferred<void>();
    const generate = async () => { started.resolve(); return response.promise; };
    const expected = fingerprintChunkSource(sourceRow());
    const run = processChunk(data(), ["Melina"], generate as any, "sidecar", undefined, heuristic, undefined, expected);
    await started.promise;
    getDb().query("UPDATE chat_chunks SET content = 'revised' WHERE id = ?").run(CHUNK_ID);
    response.resolve({
      content: "",
      tool_calls: [
        { name: "score_salience", args: { importance: 4, emotional_tones: [], narrative_flags: [], key_facts: [] } },
        { name: "extract_entities", args: { entities: [], status_changes: [], discovered_aliases: [] } },
        { name: "extract_relationships", args: { relationships: [] } },
        { name: "extract_font_colors", args: { color_attributions: [{ hex_color: "#ff0000", character_name: "Melina", usage_type: "speech" }] } },
      ],
    });
    await run;
    expect(derivedCounts()).toEqual({ salience: 0, entities: 1, relations: 0, fonts: 0, signature: null });
  });

  test("scheduler abort stops sidecar retry and fallback and leaves no derived or font writes", async () => {
    configure({
      enabled: true,
      entityTracking: true,
      salienceScoring: true,
      entityExtractionMode: "sidecar",
      sidecar: { connectionProfileId: "sidecar" },
      sidecarReliability: { maxRetries: 3, retryDelayMs: 60_000, fallback: "heuristic" },
    });
    const controller = new AbortController();
    const started = deferred<void>();
    let calls = 0;
    const generate = ({ signal }: { signal?: AbortSignal }) => {
      calls++;
      started.resolve();
      return new Promise<any>((_resolve, reject) => {
        signal!.addEventListener("abort", () => reject(signal!.reason), { once: true });
      });
    };
    const expected = fingerprintChunkSource(sourceRow());
    const run = processChunk(
      data('<font color="#ff0000">Melina waits.</font>'), ["Melina"], generate as any,
      "sidecar", undefined, heuristic, controller.signal, expected,
    );
    await started.promise;
    controller.abort(new DOMException("superseded_by_chunk_rebuild", "AbortError"));
    await expect(run).rejects.toBeInstanceOf(DOMException);
    expect(calls).toBe(1);
    expect(derivedCounts()).toEqual({ salience: 0, entities: 0, relations: 0, fonts: 0, signature: null });
  });

  test("attempt timeout remains retryable", async () => {
    const nativeSetTimeout = globalThis.setTimeout;
    const timeout = spyOn(globalThis, "setTimeout").mockImplementation(((callback: (...args: any[]) => void, ms?: number, ...args: any[]) => {
      if (ms === 60_000) {
        queueMicrotask(() => callback(...args));
        return 1 as any;
      }
      return nativeSetTimeout(callback, ms, ...args);
    }) as typeof setTimeout);
    restorables.push(timeout);
    configure({
      enabled: true,
      entityTracking: false,
      entityExtractionMode: "sidecar",
      sidecar: { connectionProfileId: "sidecar" },
      sidecarTimeoutMs: 60_000,
      sidecarReliability: { maxRetries: 1, retryDelayMs: 0, fallback: "heuristic" },
    });
    let calls = 0;
    const generate = ({ signal }: { signal?: AbortSignal }) => {
      calls++;
      return new Promise<any>((_resolve, reject) => {
        signal!.addEventListener("abort", () => reject(signal!.reason), { once: true });
      });
    };
    await processChunk(data(), ["Melina"], generate as any, "sidecar", undefined, heuristic);
    expect(calls).toBe(2);
    expect(derivedCounts().salience).toBe(1);
  });

  test("abort during exponential retry backoff unwinds without another attempt", async () => {
    configure({
      enabled: true,
      entityTracking: false,
      entityExtractionMode: "sidecar",
      sidecar: { connectionProfileId: "sidecar" },
      sidecarReliability: { maxRetries: 2, retryDelayMs: 60_000, fallback: "heuristic" },
    });
    const firstAttempt = deferred<void>();
    const controller = new AbortController();
    let calls = 0;
    const generate = async () => {
      calls++;
      firstAttempt.resolve();
      throw new Error("provider failed");
    };
    const run = processChunk(data(), ["Melina"], generate as any, "sidecar", undefined, heuristic, controller.signal);
    await firstAttempt.promise;
    await Promise.resolve();
    controller.abort(new DOMException("superseded_by_chunk_rebuild", "AbortError"));
    await expect(run).rejects.toBeInstanceOf(DOMException);
    expect(calls).toBe(1);
  });

  test("stale ingest does not launch detached consolidation", async () => {
    configure({ enabled: true, entityTracking: false, consolidation: { enabled: true } });
    const consolidate = spyOn(consolidation, "maybeConsolidate").mockResolvedValue(undefined);
    restorables.push(consolidate);
    const expected = fingerprintChunkSource(sourceRow());
    const run = processChunk(data(), ["Melina"], undefined, undefined, undefined, heuristic, undefined, expected);
    getDb().query("UPDATE chat_chunks SET content = 'stale' WHERE id = ?").run(CHUNK_ID);
    await run;
    expect(consolidate).not.toHaveBeenCalled();
  });

  test("scheduled live ingest revalidates source generation captured at enqueue", async () => {
    const blocker = deferred<void>();
    const blockerStarted = deferred<void>();
    const blockingTask = enqueueChatPipelineTask({
      chatId: CHAT_ID,
      kind: "cortex_warmup",
      run: async () => {
        blockerStarted.resolve();
        await blocker.promise;
      },
    });
    await blockerStarted.promise;
    const queuedBehind = scheduleProcessChunk(data(), ["Melina"]);
    getDb().query("UPDATE chat_chunks SET content = 'same-second change' WHERE id = ?").run(CHUNK_ID);
    blocker.resolve();
    await blockingTask;
    const result = await queuedBehind;
    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("chunk_revised");
  });

  test("delayed G1 payload is replaced by the coherent current G2 source snapshot", async () => {
    configure({
      enabled: true,
      entityTracking: false,
      salienceScoringMode: "sidecar",
      sidecar: { connectionProfileId: "sidecar" },
      sidecarReliability: { maxRetries: 0, fallback: "heuristic" },
    });
    getDb().query(
      `INSERT INTO messages (id, chat_id, index_in_chat, is_user, name, content, send_date, created_at)
       VALUES ('m2', ?, 1, 1, 'User', 'G2 appended message', 2, 2)`,
    ).run(CHAT_ID);
    getDb().query(
      `UPDATE chat_chunks
       SET end_message_id = 'm2', message_ids = '["m1","m2"]',
           content = 'G2 stored content', token_count = 7, message_count = 2
       WHERE id = ?`,
    ).run(CHUNK_ID);

    let analyzedPrompt = "";
    const generate = async (opts: { messages: Array<{ role: string; content: string }> }) => {
      analyzedPrompt = opts.messages.find((message) => message.role === "user")?.content ?? "";
      return {
        content: "",
        tool_calls: [
          { name: "score_salience", args: { importance: 4, emotional_tones: [], narrative_flags: [], key_facts: [] } },
          { name: "extract_entities", args: { entities: [], status_changes: [], discovered_aliases: [] } },
          { name: "extract_relationships", args: { relationships: [] } },
          { name: "extract_font_colors", args: { color_attributions: [] } },
        ],
      };
    };

    const staleG1 = data("G1 captured content");
    staleG1.messageIds = ["m1"];
    const result = await scheduleProcessChunk(staleG1, ["Melina"], generate as any, "sidecar");

    expect(result.status).toBe("completed");
    expect(analyzedPrompt).toContain("G2 appended message");
    expect(analyzedPrompt).not.toContain("G1 captured content");
    expect(derivedCounts().signature).not.toBeNull();
  });

  test("actual scheduled live ingest is aborted and unwinds before chunk rebuild starts", async () => {
    configure({
      enabled: true,
      entityTracking: false,
      salienceScoringMode: "sidecar",
      sidecar: { connectionProfileId: "sidecar" },
      sidecarReliability: { maxRetries: 3, retryDelayMs: 60_000, fallback: "heuristic" },
    });
    const sidecarStarted = deferred<void>();
    const abortObserved = deferred<void>();
    const allowUnwind = deferred<void>();
    let rebuildStarted = false;
    const generate = ({ signal }: { signal?: AbortSignal }) => {
      sidecarStarted.resolve();
      return new Promise<any>((_resolve, reject) => {
        signal!.addEventListener("abort", async () => {
          abortObserved.resolve();
          await allowUnwind.promise;
          reject(signal!.reason);
        }, { once: true });
      });
    };

    const liveIngest = scheduleProcessChunk(data(), ["Melina"], generate as any, "sidecar");
    await sidecarStarted.promise;
    const rebuild = enqueueChatPipelineTask({
      chatId: CHAT_ID,
      kind: "chunk_rebuild",
      exclusive: true,
      run: async () => { rebuildStarted = true; },
    });

    await abortObserved.promise;
    expect(rebuildStarted).toBe(false);
    allowUnwind.resolve();
    const ingestResult = await liveIngest;
    const rebuildResult = await rebuild;
    expect(ingestResult).toEqual({
      status: "superseded",
      reason: "superseded_by_chunk_rebuild",
    });
    expect(rebuildResult.status).toBe("completed");
    expect(rebuildStarted).toBe(true);
  });
});
