import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { join } from "path";
import { closeDatabase, getDb, initDatabase } from "../db/connection";
import { bulkDeleteMessages, deleteMessage, getChatChunks, updateMessage } from "./chats.service";
import { putSetting } from "./settings.service";
import * as embeddingsSvc from "./embeddings.service";

const userId = "patch-e-user";
const chatId = "patch-e-chat";

async function setup(): Promise<void> {
  closeDatabase();
  initDatabase(":memory:");
  const db = getDb();
  db.run(await Bun.file(join(import.meta.dir, "..", "db", "baseline.sql")).text());
  db.run(await Bun.file(join(import.meta.dir, "..", "db", "migrations", "066_chat_chunks_cortex_warmup.sql")).text());
  db.query("INSERT INTO user (id, name, email) VALUES (?, 'Patch E', 'patch-e@example.test')").run(userId);
  db.query("INSERT INTO characters (id, user_id, name) VALUES ('character', ?, 'Character')").run(userId);
  db.query("INSERT INTO chats (id, user_id, character_id, name, metadata, created_at, updated_at) VALUES (?, ?, 'character', 'Patch E', '{}', 1, 1)").run(chatId, userId);
  putSetting(userId, "embeddingConfig", { enabled: true, vectorize_chat_messages: true });
  for (let index = 0; index < 7; index++) {
    const messageId = `m${index}`;
    const chunkId = `chunk-${index}`;
    db.query("INSERT INTO messages (id, chat_id, index_in_chat, is_user, name, content, send_date, swipe_id, swipes, swipe_dates, created_at) VALUES (?, ?, ?, 0, 'Character', ?, ?, 0, ?, ?, ?)")
      .run(messageId, chatId, index, `message ${index}`, index + 1, JSON.stringify([`message ${index}`]), JSON.stringify([index + 1]), index + 1);
    db.query(`INSERT INTO chat_chunks (id, chat_id, start_message_id, end_message_id, message_ids, content, token_count, message_count, created_at, updated_at, cortex_warmup_signature)
      VALUES (?, ?, ?, ?, ?, ?, 2, 1, ?, ?, ?)`)
      .run(chunkId, chatId, messageId, messageId, JSON.stringify([messageId]), `message ${index}`, index + 1, index + 1, `signature-${index}`);
  }
}

async function settleRebuild(): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt++) {
    if (!getChatChunks(userId, chatId).some(chunk => chunk.id === "chunk-3")) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

let deleteEmbeddingsSpy: ReturnType<typeof spyOn>;
beforeEach(async () => {
  await setup();
  deleteEmbeddingsSpy = spyOn(embeddingsSvc, "deleteChatChunkEmbeddings").mockResolvedValue(undefined);
});
afterEach(() => {
  deleteEmbeddingsSpy.mockRestore();
  closeDatabase();
});

describe("Patch E deletion-aware chunk rebuild", () => {
  test("keeps signed prefix chunks when a middle message is deleted", async () => {
    expect(deleteMessage(userId, "m3")).toBe(true);
    await settleRebuild();

    const chunks = getChatChunks(userId, chatId);
    expect(chunks.slice(0, 3).map(chunk => chunk.id)).toEqual(["chunk-0", "chunk-1", "chunk-2"]);
    const signatures = getDb().query("SELECT id, cortex_warmup_signature FROM chat_chunks WHERE id IN ('chunk-0', 'chunk-1', 'chunk-2') ORDER BY id").all() as any[];
    expect(signatures.map(row => row.cortex_warmup_signature)).toEqual(["signature-0", "signature-1", "signature-2"]);
    expect(chunks.some(chunk => chunk.id === "chunk-3")).toBe(false);
  });

  test("uses the earliest pre-delete chunk for a bulk deletion", async () => {
    expect(bulkDeleteMessages(userId, chatId, ["m5", "m2"])).toBe(2);
    await settleRebuild();

    const chunks = getChatChunks(userId, chatId);
    expect(chunks[0]?.id).toBe("chunk-0");
    expect(chunks[1]?.id).toBe("chunk-1");
    expect(getDb().query("SELECT cortex_warmup_signature AS value FROM chat_chunks WHERE id = 'chunk-1'").get() as any).toEqual({ value: "signature-1" });
  });

  test("rebuilds from the first captured chunk without an unsafe fallback", async () => {
    expect(deleteMessage(userId, "m0")).toBe(true);
    await settleRebuild();
    expect(getChatChunks(userId, chatId).some(chunk => chunk.id === "chunk-0")).toBe(false);
  });

  test("rapid later then earlier single deletes preserve only the earlier prefix", async () => {
    expect(deleteMessage(userId, "m5")).toBe(true);
    expect(deleteMessage(userId, "m2")).toBe(true);
    await settleRebuild();
    expect(getChatChunks(userId, chatId).slice(0, 2).map(chunk => chunk.id)).toEqual(["chunk-0", "chunk-1"]);
    expect(getDb().query("SELECT cortex_warmup_signature AS value FROM chat_chunks WHERE id = 'chunk-1'").get() as any).toEqual({ value: "signature-1" });
  });

  test("rapid earlier then later single deletes retain the earlier safe prefix", async () => {
    expect(deleteMessage(userId, "m2")).toBe(true);
    expect(deleteMessage(userId, "m5")).toBe(true);
    await settleRebuild();
    expect(getChatChunks(userId, chatId).slice(0, 2).map(chunk => chunk.id)).toEqual(["chunk-0", "chunk-1"]);
    expect(getDb().query("SELECT cortex_warmup_signature AS value FROM chat_chunks WHERE id = 'chunk-0'").get() as any).toEqual({ value: "signature-0" });
  });

  test("a pending deletion and earlier edit use the edit's safe prefix", async () => {
    expect(deleteMessage(userId, "m5")).toBe(true);
    expect(updateMessage(userId, "m2", { content: "edited message 2" })?.id).toBe("m2");
    await settleRebuild();
    expect(getChatChunks(userId, chatId).slice(0, 2).map(chunk => chunk.id)).toEqual(["chunk-0", "chunk-1"]);
    expect(getDb().query("SELECT cortex_warmup_signature AS value FROM chat_chunks WHERE id = 'chunk-1'").get() as any).toEqual({ value: "signature-1" });
  });
});
