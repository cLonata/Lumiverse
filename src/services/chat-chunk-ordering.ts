import { getDb } from "../db/connection";

export interface RawChatChunkRow {
  id: string;
  chat_id: string;
  start_message_id: string;
  end_message_id: string;
  message_ids: string;
  message_count: number;
  [key: string]: any;
}

export interface ChunkTopologyMessage {
  id: string;
  index_in_chat: number;
}

export interface ChatChunkTopology {
  chunks: RawChatChunkRow[];
  valid: boolean;
  complete: boolean;
  coveredMessageCount: number;
  visibleMessageCount: number;
}

export interface CanonicalChunkQueryOptions {
  direction?: "asc" | "desc";
  limit?: number;
  vectorizedOnly?: boolean;
  unconsolidatedOnly?: boolean;
}

/**
 * Cheap canonical chunk ordering for ordinary reads and append selection.
 * Boundary-message joins avoid parsing every chunk or loading chat history.
 * Full structural validation is intentionally separate below.
 */
export function getCanonicalChatChunkRows(
  chatId: string,
  options: CanonicalChunkQueryOptions = {},
): RawChatChunkRow[] {
  const direction = options.direction === "desc" ? "DESC" : "ASC";
  const filters = ["cc.chat_id = ?"];
  if (options.vectorizedOnly) filters.push("cc.vectorized_at IS NOT NULL");
  if (options.unconsolidatedOnly) filters.push("cc.consolidation_id IS NULL");
  const limitSql = options.limit == null ? "" : " LIMIT ?";
  const params: Array<string | number> = [chatId];
  if (options.limit != null) params.push(Math.max(0, options.limit));

  return getDb().query(
    `SELECT cc.*
     FROM chat_chunks cc
     LEFT JOIN messages chunk_start
       ON chunk_start.id = cc.start_message_id AND chunk_start.chat_id = cc.chat_id
     LEFT JOIN messages chunk_end
       ON chunk_end.id = cc.end_message_id AND chunk_end.chat_id = cc.chat_id
     WHERE ${filters.join(" AND ")}
     ORDER BY
       CASE WHEN chunk_start.id IS NULL THEN 1 ELSE 0 END ASC,
       chunk_start.index_in_chat ${direction},
       CASE WHEN chunk_end.id IS NULL THEN 1 ELSE 0 END ASC,
       chunk_end.index_in_chat ${direction},
       cc.id ${direction}${limitSql}`,
  ).all(...params) as RawChatChunkRow[];
}

export function getLastCanonicalChatChunkRow(chatId: string): RawChatChunkRow | null {
  return getCanonicalChatChunkRows(chatId, { direction: "desc", limit: 1 })[0] ?? null;
}

/** Validate that chunks form contiguous slices of the supplied visible messages. */
export function validateChatChunkTopology(
  rows: RawChatChunkRow[],
  visibleMessages: ChunkTopologyMessage[],
): ChatChunkTopology {
  const positions = new Map(visibleMessages.map((message, index) => [message.id, index]));
  let valid = new Set(visibleMessages.map(message => message.index_in_chat)).size === visibleMessages.length;
  const entries = rows.map(row => {
    let ids: string[] = [];
    try {
      const parsed: unknown = JSON.parse(row.message_ids);
      if (Array.isArray(parsed) && parsed.every(id => typeof id === "string")) ids = parsed;
      else valid = false;
    } catch {
      valid = false;
    }
    const indexes = ids.map(id => positions.get(id));
    const known = indexes.filter((index): index is number => index !== undefined);
    const start = known.reduce((earliest, position) => Math.min(earliest, position), Infinity);
    if (
      !ids.length
      || row.message_count !== ids.length
      || known.length !== ids.length
      || indexes.some((position, index) => position !== start + index)
      || row.start_message_id !== ids[0]
      || row.end_message_id !== ids[ids.length - 1]
    ) valid = false;
    return { row, ids, start };
  });

  entries.sort((a, b) => a.start - b.start || a.row.id.localeCompare(b.row.id));
  let next = 0;
  for (const entry of entries) {
    if (entry.start !== next) valid = false;
    next = entry.start + entry.ids.length;
  }

  const visibleMessageCount = visibleMessages.length;
  const coveredMessageCount = valid ? next : 0;
  return {
    chunks: entries.map(entry => entry.row),
    valid,
    complete: valid && coveredMessageCount === visibleMessageCount,
    coveredMessageCount,
    visibleMessageCount,
  };
}

/**
 * Load and validate stored topology without depending on the chat service.
 * Malformed message extra matches chats.service behavior and remains visible.
 */
export function loadChatChunkTopology(chatId: string): ChatChunkTopology {
  const messageRows = getDb().query(
    "SELECT id, index_in_chat, extra FROM messages WHERE chat_id = ? ORDER BY index_in_chat ASC",
  ).all(chatId) as Array<ChunkTopologyMessage & { extra: string | null }>;
  const visibleMessages = messageRows.filter(row => {
    try {
      return JSON.parse(row.extra || "{}")?.hidden !== true;
    } catch {
      return true;
    }
  });
  const rows = getCanonicalChatChunkRows(chatId);
  return validateChatChunkTopology(rows, visibleMessages);
}
