import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { join } from "path";
import { closeDatabase, getDb, initDatabase } from "../src/db/connection";
import * as chatsSvc from "../src/services/chats.service";

import * as embeddingsSvc from "../src/services/embeddings.service";
import * as vectorizationQueue from "../src/services/vectorization-queue.service";
import * as memoryCache from "../src/services/chat-memory-cache.service";
import * as settingsSvc from "../src/services/settings.service";
import { getRecentVectorizedChunkIds } from "../src/services/memory-cortex/retrieval";
import { getNextUnconsolidatedChunkBatch } from "../src/services/memory-cortex/consolidation";

const USER_ID = "chunk-order-user";
const CHAT_ID = "chunk-order-chat";

async function applyBaseline(): Promise<void> {
  const db = getDb();
  db.run("PRAGMA foreign_keys = OFF");
  db.run(await Bun.file(join(import.meta.dir, "..", "src", "db", "baseline.sql")).text());
}

function seedChat(): void {
  getDb()
    .query(
      `INSERT INTO chats (id, user_id, character_id, name, metadata, created_at, updated_at)
       VALUES (?, ?, ?, 'Chunk ordering', '{}', 1, 1)`,
    )
    .run(CHAT_ID, USER_ID, "dummy-character");
}

function insertMessage(id: string, index: number): void {
  getDb()
    .query(
      `INSERT INTO messages
       (id, chat_id, index_in_chat, is_user, name, content, send_date, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, CHAT_ID, index, index % 2, index % 2 ? "User" : "Character", `message-${index}`, index + 1, index + 1);
}

function insertChunk(id: string, messageId: string, createdAt: number): void {
  getDb()
    .query(
      `INSERT INTO chat_chunks
       (id, chat_id, start_message_id, end_message_id, message_ids, content,
        token_count, message_count, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, 1, ?, ?)`,
    )
    .run(
      id,
      CHAT_ID,
      messageId,
      messageId,
      JSON.stringify([messageId]),
      `chunk-${messageId}`,
      createdAt,
      createdAt,
    );
}

describe("chat chunk canonical ordering", () => {
  beforeEach(async () => {
    closeDatabase();
    initDatabase(":memory:");
    await applyBaseline();
    seedChat();
    settingsSvc.putSetting(USER_ID, "embeddingConfig", { enabled: true, vectorize_chat_messages: true });
    spyOn(embeddingsSvc, "deleteChatChunkEmbeddings").mockResolvedValue(undefined);
    spyOn(vectorizationQueue, "queueChunkVectorization").mockImplementation(() => {});
    spyOn(memoryCache, "scheduleChatMemoryRefresh").mockImplementation(() => {});
    insertMessage("m0", 0);
    insertMessage("m1", 1);
    insertMessage("m2", 2);
  });

  afterEach(() => {
    (embeddingsSvc.deleteChatChunkEmbeddings as any).mockRestore();
    (vectorizationQueue.queueChunkVectorization as any).mockRestore();
    (memoryCache.scheduleChatMemoryRefresh as any).mockRestore();
  });

  test("orders chunks by message position, not created_at", () => {
    insertChunk("chunk-m0", "m0", 30);
    insertChunk("chunk-m1", "m1", 10);
    insertChunk("chunk-m2", "m2", 20);

    expect(chatsSvc.getChatChunks(USER_ID, CHAT_ID).map((chunk) => chunk.id)).toEqual([
      "chunk-m0",
      "chunk-m1",
      "chunk-m2",
    ]);
  });

  test("same-second chunks still follow canonical message order", () => {
    // Bulk rebuilds can create hundreds of chunks inside one second. Insert
    // them out of order to make the timestamp tie deterministic in this test.
    insertChunk("chunk-m2", "m2", 100);
    insertChunk("chunk-m0", "m0", 100);
    insertChunk("chunk-m1", "m1", 100);

    expect(chatsSvc.getChatChunks(USER_ID, CHAT_ID).map((chunk) => chunk.id)).toEqual([
      "chunk-m0",
      "chunk-m1",
      "chunk-m2",
    ]);
  });

  test("hidden messages do not create gaps in contiguous visible slices", () => {
    getDb().query("UPDATE messages SET extra = ? WHERE id = 'm1'").run('{"hidden":true}');
    insertChunk("visible", "m0", 10);
    getDb().query("UPDATE chat_chunks SET message_ids = ?, end_message_id = 'm2', message_count = 2").run('["m0","m2"]');
    const topology = chatsSvc.getChatChunkTopology(USER_ID, CHAT_ID);
    expect(topology.valid).toBe(true);
    expect(topology.complete).toBe(true);
    expect(topology.coveredMessageCount).toBe(2);
    expect(topology.visibleMessageCount).toBe(2);
    expect(chatsSvc.getChatChunks(USER_ID, CHAT_ID)[0].message_ids).toEqual(["m0", "m2"]);
  });

  test("visible messages with zero chunks are valid but incomplete", () => {
    expect(chatsSvc.getChatChunkTopology(USER_ID, CHAT_ID)).toMatchObject({
      valid: true,
      complete: false,
      coveredMessageCount: 0,
      visibleMessageCount: 3,
    });
  });

  test("rejects a stored message_count that disagrees with message_ids", () => {
    insertChunk("prefix", "m0", 10);
    getDb().query("UPDATE chat_chunks SET message_count = 2 WHERE id = 'prefix'").run();

    expect(chatsSvc.getChatChunkTopology(USER_ID, CHAT_ID).valid).toBe(false);
  });

  test("normal append fast path selects the canonical last chunk despite reversed or equal timestamps", () => {
    insertChunk("chunk-m1", "m1", 100);
    insertChunk("chunk-m0", "m0", 300);

    expect(chatsSvc.getLastChatChunk(USER_ID, CHAT_ID)?.id).toBe("chunk-m1");
    getDb().query("UPDATE chat_chunks SET created_at = 100").run();
    expect(chatsSvc.getLastChatChunk(USER_ID, CHAT_ID)?.id).toBe("chunk-m1");
  });

  test("LTM recent fallback uses canonical chunk recency", () => {
    insertChunk("chunk-m0", "m0", 300);
    insertChunk("chunk-m1", "m1", 200);
    insertChunk("chunk-m2", "m2", 100);

    expect(memoryCache.getRecentFallbackChunks(CHAT_ID, 2).map(chunk => chunk.metadata.chunkId)).toEqual([
      "chunk-m2",
      "chunk-m1",
    ]);
  });

  test("Cortex recent candidates use canonical chunk recency", () => {
    insertChunk("chunk-m0", "m0", 300);
    insertChunk("chunk-m1", "m1", 200);
    insertChunk("chunk-m2", "m2", 100);
    getDb().query("UPDATE chat_chunks SET vectorized_at = 1").run();

    expect(getRecentVectorizedChunkIds(getDb(), CHAT_ID, 2)).toEqual(["chunk-m2", "chunk-m1"]);
  });

  test("consolidation selects the canonical earliest unconsolidated chunks", () => {
    insertChunk("chunk-m0", "m0", 300);
    insertChunk("chunk-m1", "m1", 200);
    insertChunk("chunk-m2", "m2", 100);

    expect(getNextUnconsolidatedChunkBatch(CHAT_ID, 2).map(chunk => chunk.id)).toEqual([
      "chunk-m0",
      "chunk-m1",
    ]);
  });

  test("surgical tail rebuild preserves the canonical prefix despite reverse timestamps", async () => {
    insertChunk("prefix", "m0", 30);
    insertChunk("middle", "m1", 20);
    insertChunk("tail", "m2", 10);
    expect(chatsSvc.getChatChunkTopology(USER_ID, CHAT_ID).valid).toBe(true);
    await chatsSvc.rebuildChatChunksFromMessages(USER_ID, CHAT_ID, ["m2", "m1"]);
    const chunks = chatsSvc.getChatChunks(USER_ID, CHAT_ID);
    expect(chunks.map(c => c.message_ids)).toEqual([["m0"], ["m1"], ["m2"]]);
    expect(chunks[0].id).toBe("prefix");
    expect(chunks.some(c => c.id === "middle" || c.id === "tail")).toBe(false);
    expect(embeddingsSvc.deleteChatChunkEmbeddings).toHaveBeenCalledWith(USER_ID, CHAT_ID, ["middle", "tail"]);
  });

  test("revalidates the prefix after anchor selection", async () => {
    insertChunk("prefix", "m0", 30);
    insertChunk("middle", "m1", 20);
    insertChunk("tail", "m2", 10);
    const config = await embeddingsSvc.getEmbeddingConfig(USER_ID);
    const configSpy = spyOn(embeddingsSvc, "getEmbeddingConfig").mockImplementation(async () => {
      getDb().query("UPDATE chat_chunks SET end_message_id = 'm1' WHERE id = 'prefix'").run();
      return config;
    });
    try {
      await chatsSvc.rebuildChatChunksFromMessages(USER_ID, CHAT_ID, ["m2"]);
      expect(chatsSvc.getChatChunks(USER_ID, CHAT_ID).some(c => c.id === "prefix")).toBe(false);
      expect(embeddingsSvc.deleteChatChunkEmbeddings).toHaveBeenCalledWith(USER_ID, CHAT_ID);
    } finally {
      configSpy.mockRestore();
    }
  });

  test("an unchunked visible tail is valid and is rebuilt with the suffix", async () => {
    insertChunk("prefix", "m0", 30);
    insertChunk("middle", "m1", 10);
    expect(chatsSvc.getChatChunkTopology(USER_ID, CHAT_ID)).toMatchObject({
      valid: true,
      complete: false,
      coveredMessageCount: 2,
      visibleMessageCount: 3,
    });
    await chatsSvc.rebuildChatChunksFromMessages(USER_ID, CHAT_ID, ["m1"]);
    const chunks = chatsSvc.getChatChunks(USER_ID, CHAT_ID);
    expect(chunks[0].id).toBe("prefix");
    expect(chunks.flatMap(c => c.message_ids)).toEqual(["m0", "m1", "m2"]);
  });

  for (const [name, corruption] of [
    ["duplicate coverage", "UPDATE chat_chunks SET message_ids = '[\"m0\"]', start_message_id = 'm0', end_message_id = 'm0' WHERE id = 'middle'"],
    ["overlapping slices", "UPDATE chat_chunks SET message_ids = '[\"m0\",\"m1\"]', end_message_id = 'm1' WHERE id = 'prefix'"],
    ["gap", "DELETE FROM chat_chunks WHERE id = 'middle'"],
    ["noncontiguous slice", "UPDATE chat_chunks SET message_ids = '[\"m0\",\"m2\"]', end_message_id = 'm2' WHERE id = 'prefix'"],
    ["wrong boundary", "UPDATE chat_chunks SET end_message_id = 'm1' WHERE id = 'prefix'"],
    ["malformed JSON", "UPDATE chat_chunks SET message_ids = '{' WHERE id = 'prefix'"],
    ["non-array JSON", "UPDATE chat_chunks SET message_ids = '{}' WHERE id = 'prefix'"],
    ["orphan message", "UPDATE chat_chunks SET message_ids = '[\"missing\"]' WHERE id = 'prefix'"],
    ["hidden coverage", "UPDATE messages SET extra = '{\"hidden\":true}' WHERE id = 'm1'"],
  ]) {
    test(`${name} causes full rebuild without preserving an invalid prefix`, async () => {
      insertChunk("prefix", "m0", 30);
      insertChunk("middle", "m1", 20);
      insertChunk("tail", "m2", 10);
      getDb().run(corruption);
      expect(chatsSvc.getChatChunkTopology(USER_ID, CHAT_ID).valid).toBe(false);
      await chatsSvc.rebuildChatChunksFromMessages(USER_ID, CHAT_ID, ["m2"]);
      const chunks = chatsSvc.getChatChunks(USER_ID, CHAT_ID);
      expect(chunks.some(c => ["prefix", "middle", "tail"].includes(c.id))).toBe(false);
      expect(chunks.flatMap(c => c.message_ids)).toEqual(
        chatsSvc.getMessages(USER_ID, CHAT_ID).filter(m => m.extra?.hidden !== true).map(m => m.id),
      );
      expect(chatsSvc.getChatChunkTopology(USER_ID, CHAT_ID).valid).toBe(true);
      expect(embeddingsSvc.deleteChatChunkEmbeddings).toHaveBeenCalledWith(USER_ID, CHAT_ID);
    });
  }

});
