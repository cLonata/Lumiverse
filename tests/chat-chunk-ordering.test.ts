import { beforeEach, describe, expect, test } from "bun:test";
import { join } from "path";
import { closeDatabase, getDb, initDatabase } from "../src/db/connection";
import * as chatsSvc from "../src/services/chats.service";

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
    insertMessage("m0", 0);
    insertMessage("m1", 1);
    insertMessage("m2", 2);
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
});
