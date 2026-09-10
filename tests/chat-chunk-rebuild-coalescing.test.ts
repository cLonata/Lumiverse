import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { join } from "path";
import { closeDatabase, getDb, initDatabase } from "../src/db/connection";
import * as chatsSvc from "../src/services/chats.service";
import * as embeddingsSvc from "../src/services/embeddings.service";
import * as vectorizationQueue from "../src/services/vectorization-queue.service";
import * as memoryCache from "../src/services/chat-memory-cache.service";
import * as settingsSvc from "../src/services/settings.service";
import {
  enqueueChatPipelineTask,
  resetChatPipelineCoordinatorForTests,
} from "../src/services/chat-pipeline-coordinator.service";

const USER_ID = "chunk-coalescing-user";
const OTHER_USER_ID = "chunk-coalescing-other-user";
const CHAT_ID = "chunk-coalescing-chat";

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
  reject: (reason?: unknown) => void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = () => res();
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function applyBaseline(): Promise<void> {
  const db = getDb();
  db.run("PRAGMA foreign_keys = OFF");
  db.run(await Bun.file(join(import.meta.dir, "..", "src", "db", "baseline.sql")).text());
  db.run(
    await Bun.file(
      join(import.meta.dir, "..", "src", "db", "migrations", "066_chat_chunks_cortex_warmup.sql"),
    ).text(),
  );
}

function seedChat(messageCount = 6): void {
  getDb()
    .query(
      `INSERT INTO chats (id, user_id, character_id, name, metadata, created_at, updated_at)
       VALUES (?, ?, ?, 'Chunk coalescing', '{}', 1, 1)`,
    )
    .run(CHAT_ID, USER_ID, "dummy-character");

  for (let index = 0; index < messageCount; index++) {
    const messageId = `m${index}`;
    getDb()
      .query(
        `INSERT INTO messages
         (id, chat_id, index_in_chat, is_user, name, content, send_date, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        messageId,
        CHAT_ID,
        index,
        index % 2,
        index % 2 ? "User" : "Character",
        `message-${index}`,
        index + 1,
        index + 1,
      );
    getDb()
      .query(
        `INSERT INTO chat_chunks
         (id, chat_id, start_message_id, end_message_id, message_ids, content,
          token_count, message_count, cortex_warmup_signature, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 1, 1, ?, ?, ?)`,
      )
      .run(
        `c${index}`,
        CHAT_ID,
        messageId,
        messageId,
        JSON.stringify([messageId]),
        `chunk-${messageId}`,
        `warm-c${index}`,
        index + 1,
        index + 1,
      );
  }
}

function chunkIds(): string[] {
  return chatsSvc.getChatChunks(USER_ID, CHAT_ID).map(chunk => chunk.id);
}

function embeddingDeleteCalls(): any[][] {
  return (embeddingsSvc.deleteChatChunkEmbeddings as any).mock.calls;
}

function hasFullEmbeddingDelete(): boolean {
  return embeddingDeleteCalls().some(args => args.length === 2);
}

describe("chat chunk rebuild intent coalescing", () => {
  const restorables: Array<{ mockRestore: () => void }> = [];

  beforeEach(async () => {
    closeDatabase();
    resetChatPipelineCoordinatorForTests();
    initDatabase(":memory:");
    await applyBaseline();
    seedChat();
    settingsSvc.putSetting(USER_ID, "embeddingConfig", {
      enabled: true,
      vectorize_chat_messages: true,
    });
    restorables.push(
      spyOn(embeddingsSvc, "deleteChatChunkEmbeddings").mockResolvedValue(undefined),
      spyOn(vectorizationQueue, "queueChunkVectorization").mockImplementation(() => {}),
      spyOn(memoryCache, "scheduleChatMemoryRefresh").mockImplementation(() => {}),
    );
  });

  afterEach(() => {
    while (restorables.length > 0) restorables.pop()!.mockRestore();
    resetChatPipelineCoordinatorForTests();
    closeDatabase();
  });

  async function gateFirstEmbeddingConfig() {
    const config = await embeddingsSvc.getEmbeddingConfig(USER_ID);
    const gate = deferred();
    let calls = 0;
    const mock = spyOn(embeddingsSvc, "getEmbeddingConfig").mockImplementation(async () => {
      calls += 1;
      if (calls === 1) await gate.promise;
      return config;
    });
    restorables.push(mock);
    return gate;
  }

  test("two overlapping surgical requests retain a surgical follow-up", async () => {
    const gate = await gateFirstEmbeddingConfig();
    const first = chatsSvc.rebuildChatChunksFromMessages(USER_ID, CHAT_ID, ["m5"]);
    const second = chatsSvc.rebuildChatChunksFromMessages(USER_ID, CHAT_ID, ["m2"]);

    gate.resolve();
    await Promise.all([first, second]);

    expect(chunkIds().slice(0, 2)).toEqual(["c0", "c1"]);
    const preserved = getDb()
      .query("SELECT cortex_warmup_signature FROM chat_chunks WHERE id = 'c0'")
      .get() as { cortex_warmup_signature: string | null } | null;
    expect(preserved?.cortex_warmup_signature).toBe("warm-c0");
    expect(hasFullEmbeddingDelete()).toBe(false);
  });

  test("three or more overlapping surgical requests merge to the earliest canonical scope", async () => {
    const gate = await gateFirstEmbeddingConfig();
    const requests = [
      chatsSvc.rebuildChatChunksFromMessages(USER_ID, CHAT_ID, ["m5"]),
      chatsSvc.rebuildChatChunksFromMessages(USER_ID, CHAT_ID, ["m4"]),
      chatsSvc.rebuildChatChunksFromMessages(USER_ID, CHAT_ID, ["m1"]),
      chatsSvc.rebuildChatChunksFromMessages(USER_ID, CHAT_ID, ["m3", "m2"]),
    ];

    gate.resolve();
    await Promise.all(requests);

    expect(chunkIds()[0]).toBe("c0");
    expect(chunkIds()).not.toContain("c1");
    expect(hasFullEmbeddingDelete()).toBe(false);
  });

  test("follow-up resolves against replacement chunk IDs", async () => {
    const gate = await gateFirstEmbeddingConfig();
    const first = chatsSvc.rebuildChatChunksFromMessages(USER_ID, CHAT_ID, ["m2"]);
    const second = chatsSvc.rebuildChatChunksFromMessages(USER_ID, CHAT_ID, ["m4"]);

    gate.resolve();
    await Promise.all([first, second]);

    expect(chunkIds().slice(0, 2)).toEqual(["c0", "c1"]);
    expect(chunkIds()).not.toContain("c4");
    expect(embeddingDeleteCalls().filter(args => args.length === 3)).toHaveLength(2);
    expect(hasFullEmbeddingDelete()).toBe(false);
  });

  test("slow live ingest is cancelled before coalesced surgical rebuild persistence", async () => {
    let ingestAlive = false;
    let persistenceOverlappedIngest = false;
    (embeddingsSvc.deleteChatChunkEmbeddings as any).mockImplementation(async () => {
      if (ingestAlive) persistenceOverlappedIngest = true;
    });
    const blockingTask = enqueueChatPipelineTask({
      chatId: CHAT_ID,
      kind: "cortex_ingest",
      run: async (signal) => {
        ingestAlive = true;
        try {
          await new Promise<void>((_resolve, reject) => {
            signal!.addEventListener("abort", () => reject(signal!.reason), { once: true });
          });
        } finally {
          ingestAlive = false;
        }
      },
    });
    const first = chatsSvc.rebuildChatChunksFromMessages(USER_ID, CHAT_ID, ["m5"]);
    const second = chatsSvc.rebuildChatChunksFromMessages(USER_ID, CHAT_ID, ["m2"]);

    expect(chatsSvc.isChatChunkRebuildInProgress(CHAT_ID)).toBe(true);
    const [ingestResult] = await Promise.all([blockingTask, first, second]);

    expect(ingestResult.status).toBe("superseded");
    expect(chunkIds().slice(0, 2)).toEqual(["c0", "c1"]);
    expect(hasFullEmbeddingDelete()).toBe(false);
    expect(persistenceOverlappedIngest).toBe(false);
  });

  test("pending explicit full intent dominates pending surgical intent", async () => {
    const gate = await gateFirstEmbeddingConfig();
    const active = chatsSvc.rebuildChatChunksFromMessages(USER_ID, CHAT_ID, ["m5"]);
    const pendingSurgical = chatsSvc.rebuildChatChunksFromMessages(USER_ID, CHAT_ID, ["m2"]);
    const pendingFull = chatsSvc.rebuildChatChunks(USER_ID, CHAT_ID);

    gate.resolve();
    await Promise.all([active, pendingSurgical, pendingFull]);

    expect(chunkIds().some(id => /^c\d+$/.test(id))).toBe(false);
    expect(hasFullEmbeddingDelete()).toBe(true);
  });

  test("surgical intent arriving during an executing full rebuild is retained", async () => {
    const config = await embeddingsSvc.getEmbeddingConfig(USER_ID);
    const fullStarted = deferred();
    const fullGate = deferred();
    let calls = 0;
    restorables.push(
      spyOn(embeddingsSvc, "getEmbeddingConfig").mockImplementation(async () => {
        calls += 1;
        if (calls === 1) {
          fullStarted.resolve();
          await fullGate.promise;
        }
        return config;
      }),
    );

    const full = chatsSvc.rebuildChatChunks(USER_ID, CHAT_ID);
    await fullStarted.promise;
    const surgical = chatsSvc.rebuildChatChunksFromMessages(USER_ID, CHAT_ID, ["m3"]);
    fullGate.resolve();
    await Promise.all([full, surgical]);

    expect(hasFullEmbeddingDelete()).toBe(true);
    expect(embeddingDeleteCalls().some(args => args.length === 3)).toBe(true);
  });

  test("invalid topology in a coalesced follow-up safely performs a full rebuild", async () => {
    const gate = await gateFirstEmbeddingConfig();
    let corrupted = false;
    (embeddingsSvc.deleteChatChunkEmbeddings as any).mockImplementation(
      async (_userId: string, _chatId: string, discardedIds?: string[]) => {
        if (!corrupted && discardedIds) {
          corrupted = true;
          getDb().query("UPDATE chat_chunks SET end_message_id = 'm1' WHERE id = 'c0'").run();
        }
      },
    );
    const first = chatsSvc.rebuildChatChunksFromMessages(USER_ID, CHAT_ID, ["m5"]);
    const second = chatsSvc.rebuildChatChunksFromMessages(USER_ID, CHAT_ID, ["m2"]);

    gate.resolve();
    await Promise.all([first, second]);

    expect(chunkIds().some(id => /^c\d+$/.test(id))).toBe(false);
    expect(hasFullEmbeddingDelete()).toBe(true);
    expect(chatsSvc.getChatChunkTopology(USER_ID, CHAT_ID).valid).toBe(true);
  });

  test("all accepted callers settle only after the merged drain", async () => {
    const config = await embeddingsSvc.getEmbeddingConfig(USER_ID);
    const firstGate = deferred();
    const secondGate = deferred();
    const secondStarted = deferred();
    let calls = 0;
    restorables.push(
      spyOn(embeddingsSvc, "getEmbeddingConfig").mockImplementation(async () => {
        calls += 1;
        if (calls === 1) await firstGate.promise;
        if (calls === 2) {
          secondStarted.resolve();
          await secondGate.promise;
        }
        return config;
      }),
    );

    let firstSettled = false;
    let secondSettled = false;
    const first = chatsSvc.rebuildChatChunksFromMessages(USER_ID, CHAT_ID, ["m5"])
      .finally(() => { firstSettled = true; });
    const second = chatsSvc.rebuildChatChunksFromMessages(USER_ID, CHAT_ID, ["m2"])
      .finally(() => { secondSettled = true; });

    firstGate.resolve();
    await secondStarted.promise;
    expect(firstSettled).toBe(false);
    expect(secondSettled).toBe(false);
    expect(chatsSvc.isChatChunkRebuildInProgress(CHAT_ID)).toBe(true);

    secondGate.resolve();
    await Promise.all([first, second]);
    expect(firstSettled).toBe(true);
    expect(secondSettled).toBe(true);
    expect(chatsSvc.isChatChunkRebuildInProgress(CHAT_ID)).toBe(false);
  });

  test("failed generation cleans owner state and permits a later rebuild", async () => {
    const config = await embeddingsSvc.getEmbeddingConfig(USER_ID);
    const failure = new Error("controlled rebuild failure");
    const configMock = spyOn(embeddingsSvc, "getEmbeddingConfig").mockRejectedValue(failure);
    const first = chatsSvc.rebuildChatChunksFromMessages(USER_ID, CHAT_ID, ["m5"]);
    const second = chatsSvc.rebuildChatChunksFromMessages(USER_ID, CHAT_ID, ["m2"]);

    const failed = await Promise.allSettled([first, second]);
    expect(failed.map(result => result.status)).toEqual(["rejected", "rejected"]);
    for (const result of failed) {
      expect(result.status === "rejected" ? result.reason?.message : null).toBe("controlled rebuild failure");
    }
    expect(chatsSvc.isChatChunkRebuildInProgress(CHAT_ID)).toBe(false);

    configMock.mockRestore();
    restorables.push(
      spyOn(embeddingsSvc, "getEmbeddingConfig").mockResolvedValue(config),
    );
    await chatsSvc.rebuildChatChunksFromMessages(USER_ID, CHAT_ID, ["m3"]);
    expect(chunkIds().slice(0, 3)).toEqual(["c0", "c1", "c2"]);
  });

  test("empty affected-message input retains safe full-rebuild behavior", async () => {
    await chatsSvc.rebuildChatChunksFromMessages(USER_ID, CHAT_ID, []);

    expect(chunkIds().some(id => /^c\d+$/.test(id))).toBe(false);
    expect(hasFullEmbeddingDelete()).toBe(true);
  });

  test("pending empty input remains full when a later surgical request merges", async () => {
    const gate = await gateFirstEmbeddingConfig();
    const active = chatsSvc.rebuildChatChunksFromMessages(USER_ID, CHAT_ID, ["m5"]);
    const pendingEmpty = chatsSvc.rebuildChatChunksFromMessages(USER_ID, CHAT_ID, []);
    const laterSurgical = chatsSvc.rebuildChatChunksFromMessages(USER_ID, CHAT_ID, ["m2"]);

    gate.resolve();
    await Promise.all([active, pendingEmpty, laterSurgical]);

    expect(chunkIds().some(id => /^c\d+$/.test(id))).toBe(false);
    expect(hasFullEmbeddingDelete()).toBe(true);
  });

  test("a chat owner rejects a mismatched user without merging intent", async () => {
    const gate = await gateFirstEmbeddingConfig();
    const owner = chatsSvc.rebuildChatChunksFromMessages(USER_ID, CHAT_ID, ["m5"]);
    const mismatch = chatsSvc.rebuildChatChunksFromMessages(OTHER_USER_ID, CHAT_ID, ["m2"]);

    await expect(mismatch).rejects.toThrow("already owned by another user");
    gate.resolve();
    await owner;
    expect(chunkIds().slice(0, 5)).toEqual(["c0", "c1", "c2", "c3", "c4"]);
  });

  test("surgical request intent retains its provenance", () => {
    const intent = chatsSvc.createRebuildIntent(false, ["m2"], "message_update");

    expect(intent.full).toBe(false);
    expect([...intent.affectedMessageIds]).toEqual(["m2"]);
    expect([...intent.reasons]).toEqual(["message_update"]);
    expect(intent.traceIds.size).toBe(1);
  });

  test("full request intent retains its provenance", () => {
    const intent = chatsSvc.createRebuildIntent(true, [], "manual");

    expect(intent.full).toBe(true);
    expect(intent.affectedMessageIds.size).toBe(0);
    expect([...intent.reasons]).toEqual(["manual"]);
    expect(intent.traceIds.size).toBe(1);
  });

  test("merging surgical intents retains IDs, reasons, and trace IDs", () => {
    const first = chatsSvc.createRebuildIntent(false, ["m2"], "message_update");
    const second = chatsSvc.createRebuildIntent(false, ["m4"], "swipe_change");
    const merged = chatsSvc.mergeRebuildIntent(first, second, CHAT_ID);

    expect(merged.full).toBe(false);
    expect([...merged.affectedMessageIds]).toEqual(["m2", "m4"]);
    expect([...merged.reasons]).toEqual(["message_update", "swipe_change"]);
    expect(merged.traceIds.size).toBe(2);
  });

  test("full intent dominates surgical intent while retaining provenance", () => {
    const surgical = chatsSvc.createRebuildIntent(false, ["m2"], "message_delete");
    const full = chatsSvc.createRebuildIntent(true, [], "manual");
    const merged = chatsSvc.mergeRebuildIntent(surgical, full, CHAT_ID);

    expect(merged.full).toBe(true);
    expect([...merged.affectedMessageIds]).toEqual(["m2"]);
    expect([...merged.reasons]).toEqual(["message_delete", "manual"]);
    expect(merged.traceIds.size).toBe(2);
  });

  test("anchor diagnostics identify a matched message", () => {
    expect(chatsSvc.findAnchorChunkForMessages(USER_ID, CHAT_ID, ["m2"])).toEqual({
      anchorChunkId: "c2",
      reason: "matched",
      topologyValid: true,
      totalChunks: 6,
      matchedMessageIds: ["m2"],
    });
  });

  test("anchor diagnostics retain the earliest anchor and all matched IDs", () => {
    expect(chatsSvc.findAnchorChunkForMessages(USER_ID, CHAT_ID, ["m4", "deleted-m3", "m1"])).toEqual({
      anchorChunkId: "c1",
      reason: "matched",
      topologyValid: true,
      totalChunks: 6,
      matchedMessageIds: ["m1", "m4"],
    });
  });

  test("anchor diagnostics identify invalid topology", () => {
    getDb().query("UPDATE chat_chunks SET end_message_id = 'm1' WHERE id = 'c0'").run();

    expect(chatsSvc.findAnchorChunkForMessages(USER_ID, CHAT_ID, ["m2"])).toMatchObject({
      anchorChunkId: null,
      reason: "invalid_topology",
      topologyValid: false,
      totalChunks: 6,
      matchedMessageIds: [],
    });
  });

  test("anchor diagnostics identify a missing or deleted message ID", () => {
    expect(chatsSvc.findAnchorChunkForMessages(USER_ID, CHAT_ID, ["deleted-m2"])).toEqual({
      anchorChunkId: null,
      reason: "no_matching_message_id",
      topologyValid: true,
      totalChunks: 6,
      matchedMessageIds: [],
    });
  });

  test("anchor fallback logs full lifecycle mode separately from the surgical request", async () => {
    const info = spyOn(console, "info").mockImplementation(() => {});
    restorables.push(info);

    await chatsSvc.rebuildChatChunksFromMessages(USER_ID, CHAT_ID, ["deleted-m2"], "message_delete");

    const lifecycleEvents = info.mock.calls
      .map(([message]) => String(message))
      .filter(message => message.startsWith("[chats:rebuild] full_"))
      .map(message => JSON.parse(message.slice(message.indexOf("{"))));
    expect(lifecycleEvents).toHaveLength(2);
    for (const event of lifecycleEvents) {
      expect(event.mode).toBe("full");
      expect(event.requested_mode).toBe("surgical");
    }
  });
});
