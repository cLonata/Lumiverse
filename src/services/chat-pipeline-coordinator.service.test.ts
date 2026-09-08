import { afterEach, describe, expect, test } from "bun:test";

import {
  enqueueChatPipelineTask,
  getChatPipelineStatus,
  resetChatPipelineCoordinatorForTests,
} from "./chat-pipeline-coordinator.service";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

afterEach(() => {
  resetChatPipelineCoordinatorForTests();
});

describe("chat pipeline coordinator", () => {
  test("chunk rebuild supersedes queued ingests and waits for an abort-ignoring active ingest", async () => {
    const blocker = deferred<void>();
    const order: string[] = [];

    const active = enqueueChatPipelineTask({
      chatId: "chat-a",
      kind: "cortex_ingest",
      dedupeKey: "chunk-1",
      revision: 1,
      run: async () => {
        order.push("ingest-active:start");
        await blocker.promise;
        order.push("ingest-active:end");
      },
    });

    await Promise.resolve();

    const queued = enqueueChatPipelineTask({
      chatId: "chat-a",
      kind: "cortex_ingest",
      dedupeKey: "chunk-2",
      revision: 1,
      run: async () => {
        order.push("ingest-queued");
      },
    });

    const rebuild = enqueueChatPipelineTask({
      chatId: "chat-a",
      kind: "chunk_rebuild",
      exclusive: true,
      run: async () => {
        order.push("rebuild");
      },
    });

    expect((await queued).status).toBe("superseded");

    blocker.resolve();

    expect((await active).status).toBe("superseded");
    expect((await rebuild).status).toBe("completed");
    expect(order).toEqual(["ingest-active:start", "ingest-active:end", "rebuild"]);

    const status = getChatPipelineStatus("chat-a");
    expect(status?.supersededTasks).toBe(2);
    expect(status?.queuedCounts.cortex_ingest).toBe(0);
  });

  test("newer queued ingests replace older queued ingests for the same chunk", async () => {
    const blocker = deferred<void>();
    const order: string[] = [];

    const warmup = enqueueChatPipelineTask({
      chatId: "chat-b",
      kind: "cortex_warmup",
      exclusive: true,
      run: async () => {
        order.push("warmup:start");
        await blocker.promise;
        order.push("warmup:end");
      },
    });

    await Promise.resolve();

    const older = enqueueChatPipelineTask({
      chatId: "chat-b",
      kind: "cortex_ingest",
      dedupeKey: "chunk-1",
      revision: 1,
      run: async () => {
        order.push("older-ingest");
      },
    });

    const newer = enqueueChatPipelineTask({
      chatId: "chat-b",
      kind: "cortex_ingest",
      dedupeKey: "chunk-1",
      revision: 2,
      run: async () => {
        order.push("newer-ingest");
      },
    });

    expect((await older).status).toBe("superseded");

    blocker.resolve();

    expect((await warmup).status).toBe("completed");
    expect((await newer).status).toBe("completed");
    expect(order).toEqual(["warmup:start", "warmup:end", "newer-ingest"]);
  });

  test("aborts an active ingest and starts rebuild only after it unwinds", async () => {
    const unwound = deferred<void>();
    const order: string[] = [];
    let receivedSignal: AbortSignal | undefined;

    const ingest = enqueueChatPipelineTask({
      chatId: "chat-c",
      kind: "cortex_ingest",
      run: async (signal) => {
        receivedSignal = signal;
        order.push("ingest:start");
        await new Promise<void>((resolve) => {
          signal!.addEventListener("abort", () => {
            order.push("ingest:abort");
            unwound.promise.then(resolve);
          }, { once: true });
        });
        order.push("ingest:unwound");
      },
    });
    await Promise.resolve();

    const rebuild = enqueueChatPipelineTask({
      chatId: "chat-c",
      kind: "chunk_rebuild",
      exclusive: true,
      run: async () => { order.push("rebuild"); },
    });

    expect(receivedSignal?.aborted).toBe(true);
    expect(getChatPipelineStatus("chat-c")?.activeTask?.supersedeReason)
      .toBe("superseded_by_chunk_rebuild");
    expect(order).toEqual(["ingest:start", "ingest:abort"]);

    unwound.resolve();
    expect(await ingest).toEqual({
      status: "superseded",
      reason: "superseded_by_chunk_rebuild",
    });
    expect((await rebuild).status).toBe("completed");
    expect(order).toEqual(["ingest:start", "ingest:abort", "ingest:unwound", "rebuild"]);
  });

  test("classifies only recorded coordinator preemption as superseded", async () => {
    const ordinaryFailure = new DOMException("provider timeout", "AbortError");
    const ingest = enqueueChatPipelineTask({
      chatId: "chat-d",
      kind: "cortex_ingest",
      run: async () => { throw ordinaryFailure; },
    });
    await expect(ingest).rejects.toBe(ordinaryFailure);
    expect(getChatPipelineStatus("chat-d")?.supersededTasks).toBe(0);
  });

  test("requests cancellation once across repeated rebuild submissions", async () => {
    const unwound = deferred<void>();
    let abortEvents = 0;
    const ingest = enqueueChatPipelineTask({
      chatId: "chat-e",
      kind: "cortex_ingest",
      run: async (signal) => {
        signal!.addEventListener("abort", () => { abortEvents++; }, { once: true });
        await unwound.promise;
      },
    });
    await Promise.resolve();

    const first = enqueueChatPipelineTask({
      chatId: "chat-e", kind: "chunk_rebuild", exclusive: true, run: async () => {},
    });
    const second = enqueueChatPipelineTask({
      chatId: "chat-e", kind: "chunk_rebuild", exclusive: true, run: async () => {},
    });
    expect(abortEvents).toBe(1);
    unwound.resolve();
    expect((await ingest).status).toBe("superseded");
    expect((await first).status).toBe("completed");
    expect((await second).status).toBe("completed");
  });

  test("keeps different chat lanes independent during preemption", async () => {
    const otherBlocker = deferred<void>();
    const other = enqueueChatPipelineTask({
      chatId: "chat-f", kind: "cortex_ingest", run: async () => { await otherBlocker.promise; },
    });
    const ingest = enqueueChatPipelineTask({
      chatId: "chat-g",
      kind: "cortex_ingest",
      run: async (signal) => {
        await new Promise<void>((resolve) => signal!.addEventListener("abort", () => resolve(), { once: true }));
      },
    });
    await Promise.resolve();
    const rebuild = enqueueChatPipelineTask({
      chatId: "chat-g", kind: "chunk_rebuild", exclusive: true, run: async () => {},
    });

    expect((await ingest).status).toBe("superseded");
    expect((await rebuild).status).toBe("completed");
    expect(getChatPipelineStatus("chat-f")?.activeTask?.kind).toBe("cortex_ingest");
    otherBlocker.resolve();
    expect((await other).status).toBe("completed");
  });

  test("continues the lane after expected preemption", async () => {
    const ingest = enqueueChatPipelineTask({
      chatId: "chat-h",
      kind: "cortex_ingest",
      run: async (signal) => {
        await new Promise<void>((_resolve, reject) => {
          signal!.addEventListener("abort", () => reject(signal!.reason), { once: true });
        });
      },
    });
    await Promise.resolve();
    const rebuild = enqueueChatPipelineTask({
      chatId: "chat-h", kind: "chunk_rebuild", exclusive: true, run: async () => "rebuilt",
    });
    const following = enqueueChatPipelineTask({
      chatId: "chat-h", kind: "cortex_warmup", run: async () => "continued",
    });

    expect((await ingest).status).toBe("superseded");
    expect((await rebuild).value).toBe("rebuilt");
    expect((await following).value).toBe("continued");
  });

  test("does not preempt active cortex rebuild or warmup work", async () => {
    for (const kind of ["cortex_rebuild", "cortex_warmup"] as const) {
      const blocker = deferred<void>();
      let signalSeen: AbortSignal | undefined;
      const active = enqueueChatPipelineTask({
        chatId: `chat-${kind}`,
        kind,
        run: async (signal) => { signalSeen = signal; await blocker.promise; },
      });
      await Promise.resolve();
      const rebuild = enqueueChatPipelineTask({
        chatId: `chat-${kind}`, kind: "chunk_rebuild", exclusive: true, run: async () => {},
      });
      expect(signalSeen).toBeUndefined();
      expect(getChatPipelineStatus(`chat-${kind}`)?.activeTask?.kind).toBe(kind);
      blocker.resolve();
      expect((await active).status).toBe("completed");
      expect((await rebuild).status).toBe("completed");
    }
  });
});
