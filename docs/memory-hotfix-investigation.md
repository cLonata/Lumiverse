# Memory/LTM/Cortex Hotfix Investigation

**Branch:** `test/memory-hotfix`  
**Status:** Patches A, B, and C are implemented and regression-tested. No production deployment is claimed.
**Evidence convention:** **[Code]** is directly established by the checked-out source. **[Production]** is a value or event reported from the real incident's logs/database evidence. **[Inference]** is an engineering conclusion consistent with the first two, but not independently proven by them. **[Open]** is not yet established.

## Executive Summary

Three independent defects make a chat's derived memory state vulnerable when ordinary message updates overlap slow Cortex work.

1. **Bug A — canonical ordering:** several LTM/Cortex paths order `chat_chunks` by `created_at`. That field has second resolution, is not the visible-message order, and is tied for chunks produced in the same second. The authoritative visible order is `messages.index_in_chat` (or an equivalent order derived from the chunks' start/end messages).
2. **Bug B — rebuild escalation:** a second surgical request that observes `_rebuildInflight` sets `_rebuildPending`, waits, then deliberately invokes the full `rebuildChatChunks()` path. Thus an overlapping surgical request is not kept surgical.
3. **Bug C — queued work is reported as in flight:** a chunk rebuild registers its `_rebuildInflight` promise before its exclusive task starts in the per-chat lane. A long `cortex_ingest` task ahead of it can therefore leave the rebuild queued, yet visible as in flight. This substantially widens Bug B's overlap window.

**[Code]** Normal generation creates an empty staged assistant message and later changes its content with `updateMessage()`. Unless `skipChunkRebuild` is explicitly true, an active-content update requests `rebuildChatChunksFromMessages()`. Ordinary chatting can therefore enter the chain; a user does not need to manually invoke maintenance.

**[Production]** The incident showed a divergence of 379 visible messages versus 847 `chat_chunks`. A canonical full LTM recompile subsequently restored 379 chunks and 379 vectorized chunks. Later, the chat had 450 chunks, 431 of them with a null Cortex warmup signature. These observations establish corrupt/incomplete derived state and successful repair by a canonical recompile; they do not alone identify which write produced each extra chunk.

**[Inference]** Bugs B and C provide a strong, source-supported explanation for repeated full chunk recreation during normal activity. Recreated chunks lose their per-row warmup signatures, which makes a later Cortex warmup appear to require almost all chunks. Bug A can additionally make any procedure that traverses chunks by timestamp select a non-canonical anchor or order. The combined loop is plausible and testable, but the available incident extract does not prove the exact statement sequence that created all 847 rows.

## User-visible Symptoms

- Memory retrieval may appear inconsistent with the displayed conversation because chunk ordering and chunk boundaries are derived-state inputs. **[Inference]**
- The Memory/Cortex UI may repeatedly show broad warmup/rebuild work after a small edit or an ordinary response. **[Production]** A later warmup reported approximately 447 total chunks and 445 pending, with `signature_changed=false`.
- Cortex may look as though it is rebuilding everything even when its structural configuration has not changed. **[Code + Production]** The coverage rule keys completion to per-chunk signatures, and incident diagnostics reported nearly all signatures pending without a signature change.
- Rebuild journal messages can say a surgical pass preserved hundreds of chunks, followed by a full rebuild, making the maintenance activity look disproportionate to the user action. **[Production]** Repeated journal examples report surgical rebuilds with hundreds of “preserved” chunks.

These are downstream consequences, not separate root causes. Neither the incident counts nor the UI behavior establish a Cortex extractor defect.

## Production Evidence

The following facts are retained verbatim in meaning from the incident material provided for this investigation. They are deliberately separated from code conclusions.

| Evidence | Classification | What it proves / does not prove |
| --- | --- | --- |
| 379 visible messages; 847 `chat_chunks` | **[Production]** | Derived chunks outnumbered visible messages by a large margin. It does not identify the individual write path responsible. |
| Canonical full LTM recompile restored 379 chunks / 379 vectorized | **[Production]** | Full canonical reconstruction could restore a one-message-per-chunk state for that chat at that point. |
| Later state: 450 chunks; 431 null Cortex warmup signatures | **[Production]** | Most current rows were not marked warm for the then-current signature. It does not by itself prove why those rows were created. |
| Repeated journals: surgical rebuilds reporting hundreds of preserved chunks | **[Production]** | Surgical maintenance was operating with a large preserved prefix. It does not itself prove an escalation occurred in every example. |
| Critical approximately 00:55–00:59 period: ordinary chat requests; a Cortex ingest active for minutes with retries; a surgical rebuild queued and later run; a full rebuild immediately followed | **[Production]** | The event ordering is consistent with the B/C causal chain. Correlation alone does not prove all internal calls or the initiating message IDs. |
| Later warmup: roughly 447 total / 445 pending, `signature_changed=false` | **[Production]** | Pending work was not attributable to a logged structural-signature change. It does not prove that every pending signature was cleared by a single full rebuild. |

## Timeline

### Incident timeline (production evidence)

| Approximate time | Observed event | Classification |
| --- | --- | --- |
| Before repair | 379 visible messages; 847 `chat_chunks` | **[Production]** |
| Canonical repair | Full LTM recompile yields 379 chunks and 379 vectorized | **[Production]** |
| ~00:55–00:59 | Ordinary chat traffic occurs while Cortex ingestion remains active for several minutes and retries | **[Production]** |
| Same interval | A surgical rebuild is queued, subsequently runs, and a full rebuild immediately follows | **[Production]** |
| Later | 450 chunks, 431 null warmup signatures; later warmup logs about 447 total / 445 pending and `signature_changed=false` | **[Production]** |

### Source-level event sequence (not a reconstructed production trace)

1. A normal generation creates a blank assistant message in `generate.service.ts`, then later calls `chatsSvc.updateMessage()` with completed content. **[Code]**
2. `updateMessage()` detects an active-content change and, absent `skipChunkRebuild: true`, starts `rebuildChatChunksFromMessages()` asynchronously. **[Code]**
3. That function places a promise in `_rebuildInflight` before `enqueueChatPipelineTask()` has obtained the per-chat lane. **[Code]**
4. If `cortex_ingest` is active in that lane, the exclusive chunk rebuild is queued. The promise remains in `_rebuildInflight` while queued. **[Code]**
5. Another surgical request during that time sees the map entry and turns the coalesced follow-up into `rebuildChatChunks()` (full). **[Code]**
6. A full rebuild deletes all chunk rows, creates new rows, and queues vectorization. New rows do not inherit old Cortex warmup signatures. **[Code]**
7. Coverage then counts the new rows as pending; if derived Cortex data remains while no rows have the current signature, it asks for a full Cortex rebuild. **[Code]**

## Architecture / Relevant Code Paths

| Concern | Relevant files and functions | Established behavior |
| --- | --- | --- |
| Canonical messages | `src/services/chats.service.ts`: `getMessages`, `updateMessage` | Messages carry `index_in_chat`; active content changes request a chunk rebuild unless skipped. **[Code]** |
| LTM chunks | `src/services/chats.service.ts`: `getChatChunks`, `findAnchorChunkForMessages`, `_rebuildChatChunksFromBody`, `_rebuildChatChunksFromBody` | Multiple readers use `ORDER BY created_at ASC`; full rebuild deletes all chunks and re-chunks visible messages. **[Code]** |
| Rebuild coalescing | `src/services/chats.service.ts`: `_rebuildInflight`, `_rebuildPending`, `rebuildChatChunks`, `rebuildChatChunksFromMessages` | An overlapping surgical request has an intentional conservative full-rebuild follow-up. **[Code]** |
| Per-chat scheduler | `src/services/chat-pipeline-coordinator.service.ts`: `enqueueChatPipelineTask`, `pumpLane` | One FIFO lane per chat; tasks await completion one at a time. `exclusive` supersedes queued ingests but cannot preempt the active ingest. **[Code]** |
| Live Cortex ingest | `src/services/chats.service.ts`: chunk post-create hook; `src/services/memory-cortex/index.ts`: `scheduleProcessChunk`, `processChunk` | New chunks schedule `cortex_ingest` on the same lane. The post-create hook uses `setTimeout(..., 0)`. **[Code]** |
| Cortex warmup/rebuild | `src/routes/memory-cortex.routes.ts`; `src/services/memory-cortex/index.ts`: `getCortexWarmupCoverage`, `rebuildCortex` | Warmups and explicit rebuilds also enqueue exclusive work on the same lane; completion is tracked by structural signature on each chunk. **[Code]** |

### SQL ordering at issue

The checked-out code contains these materially relevant forms:

```sql
SELECT * FROM chat_chunks WHERE chat_id = ? ORDER BY created_at ASC
```

They are used by `getChatChunks()`, `findAnchorChunkForMessages()`, surgical rebuild selection, and Cortex rebuild/warmup selection. `getLastChatChunk()` uses `ORDER BY created_at DESC`. **[Code]** `chat_chunks.created_at` is stored at second resolution (`Math.floor(Date.now() / 1000)` in the normal chunk creation path), so a bulk rebuild can create many tied rows. **[Code]** The branch’s `tests/chat-chunk-ordering.test.ts` independently reproduces both out-of-order timestamps and same-second ties; it is a failing characterization test until ordering is corrected. **[Code]**

The correct ordering must be defined by canonical visible-message position, not by chunk insertion time. Candidate SQL can join `messages` through `start_message_id` and use `m.index_in_chat ASC`, with deterministic secondary keys only as a defensive tie-breaker. The exact treatment of malformed/orphan chunks is an implementation decision to test. **[Inference]**

### Normal-generation staged-message behavior

For `genType === "normal"`, `generate.service.ts` calls `createMessage()` with assistant content `""`, stores `stagedMessageId`, excludes that blank message from prompt assembly, and later calls `updateMessage()` with final/closed content. **[Code]** The update calls shown in the normal staged completion paths set `skipCouncilCacheInvalidation`, not `skipChunkRebuild`. **[Code]** Therefore `updateMessage()`'s active-content branch requests `rebuildChatChunksFromMessages(userId, chatId, [updated.id])`. **[Code]**

This is why ordinary chat traffic belongs in the causal investigation: it creates a normal content update after the staged blank. It does not mean every ordinary message causes a full rebuild; escalation needs the overlap or another full-rebuild fallback condition. **[Code + Inference]**

### Cortex signatures and maintenance scheduling

`scheduleProcessChunk()` snapshots the row's `updated_at`, queues a `cortex_ingest`, and preflights it against row existence, revision, and `cortex_warmup_signature === getCortexStructuralSignature(config)`. Successful `processChunk()` writes `cortex_warmup_signature` and completion time to the chunk. **[Code]**

`getCortexWarmupCoverage()` counts rows with the requested signature. It returns `requiresFullRebuild` when `completedChunks === 0` and any derived Cortex data exists. In that case, a resumable warmup clears derived Cortex data (preserving salience) and selects all chunks. **[Code]** This explains the *appearance* of “Cortex rebuilding everything” after signatures are absent; it is the response to chunk-row coverage, not proof that Cortex independently recreated the LTM rows.

## Bug A: Canonical Chunk Ordering

### Root defect

`chat_chunks.created_at` is being treated as an ordering key in LTM and Cortex maintenance, although it expresses creation time rather than visible-message order. **[Code]** In a batch insert it can be identical for many rows; with a tie, SQLite is not being given a canonical secondary sort in these queries. **[Code]**

### Why it matters

`findAnchorChunkForMessages()` walks chunks in timestamp order and returns the first chunk whose JSON `message_ids` contains an affected message. Surgical rebuild then preserves the prefix before that returned row. `_rebuildChatChunksFromBody()` also indexes the timestamp-ordered list to determine the preserved prefix. **[Code]** If timestamp order differs from canonical message order, the “earliest affected chunk” and preserved suffix/prefix can be incorrect. **[Inference]**

The `getChatChunks()` API and Cortex rebuild queries use the same timestamp ordering, so consumers can observe/process rows in a non-canonical sequence. **[Code]** Whether this ordering defect alone can create duplicate chunks is **[Open]**; the code establishes bad ordering, not a direct duplicate insert from ordering alone.

### Required correction

- Define one reusable canonical chunk-order query/helper based on the visible start message's `index_in_chat`.
- Use it in chunk listing, last-chunk lookup, anchor selection, surgical selection, salience snapshots where ordering is semantically relevant, and Cortex chunk selection.
- Explicitly decide and test fallback ordering for legacy/orphan chunks rather than silently relying on `created_at`.

## Bug B: Rebuild Coalescing / Full-Rebuild Escalation

### Patch B implementation status

Patch B replaces the boolean-like `_rebuildInflight` / `_rebuildPending` pairing with one per-chat owner state containing a shared completion promise and a pending `RebuildIntent`. Surgical intents union their materialized affected-message ID sets. Empty affected-message input is normalized to explicit full intent before coalescing, so a later surgical merge cannot weaken its existing safe full-rebuild semantics. A pending explicit-full intent dominates surgical intent, while a surgical request arriving after a full generation has been claimed is retained for the next generation. **[Implemented and regression-tested]**

The owner atomically claims and clears one pending generation, submits one exclusive `chunk_rebuild`, and drains any intent accumulated during execution as a later generation. Surgical anchors are resolved inside the pipeline task's `run` callback against Patch A's current canonical topology; the surgical body retains its independent execution-time topology validation. Safety fallbacks call the private full rebuild body directly and do not re-enter the public coalescer. Owner installation is synchronous, quiescent removal occurs without an intervening await, and rejection centrally removes both the owner and pending intent before rejecting the shared promise. **[Implemented and regression-tested]**

Dedicated regression coverage was added in `tests/chat-chunk-rebuild-coalescing.test.ts` for two and many overlapping surgical requests, replacement chunk IDs, queued overlap, pending-full dominance, surgical work arriving during an executing full rebuild, invalid follow-up topology, shared completion, failure cleanup, and empty affected-message input. Patch A's completed validation record is unchanged. Bug C's queued-versus-running semantics and `chat-pipeline-coordinator` remain unchanged. **[Implemented and regression-tested]**

### Patch B validation results

| Selection | Result | Assertions | Files |
| --- | --- | ---: | ---: |
| Dedicated Patch B coalescing suite (`tests/chat-chunk-rebuild-coalescing.test.ts`) | 12 pass / 0 fail | 37 | 1 |
| Patch A + Patch B interaction set | 37 pass / 0 fail | 129 | 4 |
| Broader memory/chat regression selection | 146 pass / 0 fail | 455 | 20 |

The broader `chats.service` selection emitted the already-known, caught asynchronous reduced-fixture errors about missing `settings` and `chat_chunks` tables. They did not fail any tests and are not classified as Patch B regressions. Production deployment is not claimed. Bug C remains unfixed.

### Root defect

`rebuildChatChunksFromMessages()` first resolves an anchor. If `_rebuildInflight` has an entry, it marks `_rebuildPending`, awaits the promise, consumes that marker, and returns `rebuildChatChunks(userId, chatId)`. The code comment calls this a conservative full follow-up because the previously chosen anchor may be stale. **[Code]**

This is a direct surgical-to-full escalation path. It is not merely a possible race inferred from logs.

### Important semantics

- A missing anchor also calls the full rebuild path. That is a distinct, documented fallback and must not be conflated with the overlap escalation. **[Code]**
- `_rebuildPending` is a set keyed only by chat, not by affected message IDs, canonical range, or generation/revision. **[Code]**
- The first waiter that finds the set marker consumes it; later waiters can return. This coalesces demand but does not preserve a surgical scope. **[Code]**
- The full body deletes all `chat_chunks` for the chat and creates replacement chunks. **[Code]**

### Downstream consequences (not root bugs)

Full reconstruction invalidates per-row chunk identity and omits prior warmup signatures. The subsequent need to vectorize and warm Cortex is expected after full recreation. **[Code]** The incident's large pending-signature counts are compatible with this effect. **[Inference]** They do not prove a Cortex signature algorithm changed, especially because the later log reported `signature_changed=false`. **[Production]**

## Bug C: Pipeline Starvation / Queued-vs-Running Semantics

### Root defect

`_rebuildChatChunksImpl()` and `_rebuildChatChunksFromImpl()` insert their promise in `_rebuildInflight` before the queued task actually starts. The promise wraps `enqueueChatPipelineTask()`, so it remains pending during lane wait time. **[Code]** `isChatChunkRebuildInProgress()` consequently reports true for both a running rebuild and a rebuild merely queued behind another task. **[Code]**

The per-chat coordinator has one FIFO `queue`, one `activeTask`, and `pumpLane()` awaits each `task.run()` before moving on. **[Code]** It is deliberately serial. `cortex_ingest`, `chunk_rebuild`, `cortex_rebuild`, and `cortex_warmup` all use this lane. **[Code]** An exclusive chunk rebuild removes queued ingest tasks but cannot interrupt an already-active ingest; it waits for that task's retries/provider latency. **[Code]**

### Why this magnifies Bug B

An active long Cortex ingest can make a rebuild appear in-flight for minutes before it begins. Any later normal-generation update that requests a surgical rebuild then satisfies Bug B's overlap predicate, even though no chunk rebuild body is running yet. **[Code + Inference]** The critical 00:55–00:59 incident ordering matches this condition: an ingest was active with retries, a surgical rebuild was queued, then a full rebuild followed. **[Production]** The logs cited here do not expose the internal map state, so the exact map observation remains **[Inference]**.

### Required correction

Separate lifecycle states at minimum: `queued`, `running`, and `follow-up-required`. The surgical decision must not use an umbrella promise as evidence that a rebuild body is currently modifying the chunk graph. **[Inference]** A stronger design records and merges canonical affected ranges/revisions while queued and lets the single eventual task calculate a fresh anchor at execution time. **[Inference]**

### Patch C implementation

Patch C addresses only the demonstrated active-live-ingest delay. Every queued `cortex_ingest` is still superseded by an exclusive task as before. In addition, submission of `chunk_rebuild` records `superseded_by_chunk_rebuild` on an active `cortex_ingest` and aborts that task's coordinator-owned controller exactly once. The lane does not race or detach the cancelled promise: it awaits the ingest until it actually unwinds, settles the ingest as `superseded`, and only then starts the rebuild. An active `cortex_rebuild` or `cortex_warmup` is not preempted. **[Implemented and regression-tested]**

Scheduler supersession is classified from the coordinator's recorded reason plus its controller state, not from an exception name. Consequently an ordinary provider `AbortError`, a per-attempt timeout, and other task failures retain ordinary failure/retry behavior. Live sidecar attempts combine the external scheduler signal with a separate timeout controller; the external signal stops RPM waiting, provider work, retry backoff, fallback, warmup stamping, post-transaction work, and consolidation launch. Attempt timeout remains eligible for the configured retry/fallback policy. **[Implemented and regression-tested]**

Live ingestion now reads one coherent current `chat_chunks` source row. That same row supplies both the scheduled ingestion payload (`content`, parsed `message_ids`, and `created_at`) and a stable local fingerprint of the exact stored source fields: `id`, `chat_id`, `start_message_id`, `end_message_id`, raw stored `message_ids`, `content`, `token_count`, `message_count`, `updated_at`, and `created_at`. Delayed caller payload is therefore never paired with a newer database fingerprint. Preflight compares the current row to that snapshot. Immediately before main persistence, the same fields are re-read and compared inside the synchronous SQLite transaction that performs salience, entity, relation, font-attribution, and warmup-signature writes. A missing or changed row performs none of those main writes; same-second changes are detected independently of `updated_at`. **[Implemented and regression-tested]**

Font parsing now supports analysis without persistence. Live ingestion retains pending sample excerpts and applies deduplicated heuristic/existing-map reinforcement plus sidecar color attribution only inside the validated main transaction. Fact Auto-Pilot and relationship reactivation receive the external signal, do not start after cancellation/staleness, and re-check cancellation and source generation after an awaited sidecar call before their final mutation. A stale or superseded live ingest does not launch `maybeConsolidate()`. **[Implemented and regression-tested]**

Regression tests cover signal-aware and signal-ignoring coordinator tasks, unwind-before-rebuild ordering, explicit supersession classification, ordinary failures, queued supersession, repeated rebuild submission, cross-chat independence, lane continuation, coherent delayed source payloads, source fingerprint changes (including same-second changes), missing/stale transactional rejection, cancellation versus timeout/retry behavior, abort-aware backoff, deferred font writes and sample evidence, consolidation suppression, Patch B coalesced caller settlement, surgical scope during cancellation, and no ingest/rebuild persistence overlap. **[Implemented and regression-tested]**

### Patch C validation results

| Selection | Result | Assertions | Files |
| --- | --- | ---: | ---: |
| Targeted Patch C suite | 73 pass / 0 fail | 219 | 4 |
| Patch A + Patch B + Patch C interaction set | 96 pass / 0 fail | 301 | 6 |
| Broader memory/chat regression | 166 pass / 0 fail | 519 | 21 |

`git diff --check` passed. Git for Windows emitted LF-to-CRLF conversion warnings only. The broader `chats.service` reduced-fixture tests emitted the already-known, caught asynchronous `no such table: settings` and `no such table: chat_chunks` logs. Those logs did not fail tests and are not classified as Patch C regressions. Production deployment is not claimed.

Explicit follow-up scope remains unchanged: priority/preemption for active or queued `cortex_rebuild` and `cortex_warmup`, stale work from an already-detached consolidation launched by an earlier successful ingest, and graceful shutdown/draining. Patch C does not add a general priority queue, migration, consolidation redesign, or shutdown architecture.

## Combined Failure Loop

```text
ordinary normal generation
  -> blank staged assistant message
  -> final updateMessage(content)
  -> surgical chunk rebuild requested
  -> task registered as inflight, but queued behind slow cortex_ingest       [Bug C]
  -> another content update requests surgical rebuild
  -> sees _rebuildInflight; coalescer performs full follow-up rebuild        [Bug B]
  -> all chunk rows replaced; warmup signatures absent
  -> warmup sees nearly all chunks pending / may select all chunks
  -> slow Cortex activity again extends future queued-rebuild window
```

Every arrow through the scheduler and coalescer is **[Code]**. The assertion that this exact loop caused the reported 847 rows is **[Inference]**, supported but not uniquely proven by the supplied timeline. Bug A is an independent correctness defect that can select/process chunks in non-canonical order anywhere timestamp ordering remains.

## Why Cortex Itself Appears to Rebuild Everything

Cortex does not own the LTM full chunk deletion/recreation shown in `_rebuildChatChunksBody()`; that body is in `chats.service.ts`. **[Code]** Cortex reacts to the resulting rows:

1. New/recreated rows have null `cortex_warmup_signature` unless and until `processChunk()` completes. **[Code]**
2. Coverage compares each row to the current structural signature. **[Code]**
3. If no rows match and derived data exists, `requiresFullRebuild` is true and a resumable warmup selects all chunks after clearing derived Cortex data (with salience preservation in that branch). **[Code]**
4. Route diagnostics calculate `signature_changed` by comparing stored and current chat-level freshness signatures. **[Code]**

Thus a report of about 447 total / 445 pending with `signature_changed=false` is consistent with row replacement/signature loss rather than a configuration signature change. **[Production + Inference]** It is not proof that the Cortex extractor independently chose an unnecessary full LTM rebuild.

## Regression Test Plan

Tests should be deterministic and avoid real providers.

| Test | Setup | Required assertion |
| --- | --- | --- |
| Canonical ordering | Insert chunks with reverse timestamps and with same-second timestamps; map each to ordered messages | Listing, anchor lookup, surgical preserved prefix, and Cortex selection follow `index_in_chat`, not timestamps. |
| Out-of-order legacy rows | Insert a chunk whose start message is missing/hidden | Defined deterministic fallback; no accidental timestamp dependence. |
| Single surgical update | Seed a multi-chunk chat; update a middle/late message | Only canonical suffix is replaced; prefix IDs and warmup signatures remain. |
| Overlapping surgical requests | Block first rebuild body with a deferred gate; submit a second affected range | One merged/fresh surgical plan executes; no call to full rebuild unless an explicit validated fallback condition occurs. |
| Active live-ingest preemption | Start a signal-aware `cortex_ingest`, enqueue a surgical rebuild, then send another edit while cancellation unwinds | Ingest settles superseded; rebuild starts only after unwind; coalesced edits stay surgical with no persistence overlap. |
| Active rebuild overlap | Hold a rebuild after its body starts; submit another edit | Correct range/revision follow-up after the active body; test the intended policy explicitly. |
| Normal generation | Exercise staged blank message followed by final `updateMessage` | Exactly one intended chunk-maintenance request; behavior remains correct under an active Cortex ingest. |
| Cortex signatures | Full and surgical rebuild fixtures with completed prefix | Preserved rows retain signatures; replaced rows are pending; coverage totals/pending values are correct. |
| Cortex route telemetry | Fixture with unchanged structural signature and null chunk signatures | `signature_changed=false` can coexist with high pending counts; diagnostic labels do not imply config drift. |
| Retry starvation | Fake sidecar/ingest delay and retries | Scheduler cancellation stops live retry/fallback promptly while attempt timeout retains ordinary retry policy. |

The existing `tests/chat-chunk-ordering.test.ts` is the initial characterization test for Bug A. It should pass only after the ordering correction; it is not evidence that Bugs B or C are covered.

## Patch Plan

1. **Canonical ordering helper.** Introduce a single SQL/helper definition ordered by the canonical visible-message position, then replace all semantically ordered `chat_chunks` reads identified above. Do not change incidental display sort without reviewing callers. Add an index only after checking `EXPLAIN QUERY PLAN` against realistic chat sizes. **[Proposed]**
2. **Range-aware rebuild coordinator.** Replace `_rebuildInflight`/`_rebuildPending`'s boolean-like coalescing with a per-chat rebuild request state that records queued/running status and affected message IDs or the earliest canonical position. Resolve the current anchor immediately before the rebuild body executes. **[Proposed]**
3. **No automatic surgical-to-full escalation.** Merge overlapping surgical requests to the earliest affected canonical range. Reserve a full rebuild for documented, checked conditions: no valid anchor, anchor/preserved boundary invalid at execution, disabled vectorization, or an explicit operator/full request. Log the exact fallback reason. **[Proposed]**
4. **Scheduler observability and semantics.** Expose queued and active task identity/durations in logs/status; make `isChatChunkRebuildInProgress` either mean active-only or replace it with explicit predicates. Keep Cortex and chunk writes serialized unless a transactionally safe concurrency model is designed. **[Proposed]**
5. **Signature-safe maintenance.** Preserve signatures only for genuinely preserved rows; newly created rows remain pending. Do not paper over the issue by stamping signatures without processing. **[Proposed]**
6. **Backfill/recovery.** Ship a diagnostic and an operator-triggered canonical recompile/warmup for already affected chats. Do not auto-recompile every chat on upgrade without capacity review. **[Proposed]**

## Validation Matrix

| Dimension | Validate | Pass criterion |
| --- | --- | --- |
| Correctness | Message order, anchor selection, preserved prefix | Matches `messages.index_in_chat` for shuffled/tied chunk timestamps. |
| Concurrency | Ingest active; one/many edits; full request | No implicit full escalation from queued or overlapping surgical requests. |
| Durability | Crash/retry, stale queued task, deleted/revised chunk | Preflight skips invalid work; no orphaned/duplicate chunk graph. |
| Cortex | Signatures, derived entities, salience, warmup | Only replacement suffix is pending; full Cortex action occurs only under coverage policy. |
| Retrieval | LTM/Cortex prompt retrieval after edit | Returns canonical chronological context; no stale vectors selected. |
| Performance | 400–900-message chats; slow sidecar retries | Queue wait is observable; chat remains usable; no rebuild storm. |
| Compatibility | Existing chats and disabled vectorization | Explicit fallback/recovery behavior; no data loss beyond intended derived-data replacement. |

## Production Rollout

1. Land unit/integration tests and run them with deterministic gated scheduler fixtures.
2. Add structured logs/metrics before enabling broad repair: chat ID, request kind, queued/started/finished times, canonical affected range, whether a full fallback occurred, and reason.
3. Deploy to a small monitored cohort. Watch full-vs-surgical ratio, queue wait behind `cortex_ingest`, chunk/message ratio, vectorization completion, warmup pending ratio, and retry durations.
4. Provide a targeted canonical LTM recompile plus Cortex warmup for known affected chats, confirming chunk count and vectorization after each operation.
5. Expand only after ordinary chat under deliberately slow Cortex ingestion shows no automatic full-rebuild escalation.

No claim is made that a schema migration is required; determine that after implementation and query-plan review. **[Open]**

## Rollback Plan

- Gate the new coordinator/order implementation behind a server-side feature flag or a narrowly reversible release if project conventions permit. **[Proposed]**
- On regression, stop the new scheduling behavior, retain structured diagnostics, and avoid destructive automatic repair.
- Recover affected derived state with the existing canonical full LTM recompile followed by vectorization and Cortex warmup, verifying counts before and after. The incident demonstrates that this procedure restored 379/379 for the affected chat at that time. **[Production]**
- Do not restore timestamp ordering as a data repair: it changes ordering behavior but cannot reconstruct canonical intent. **[Inference]**

## Open Questions

1. Which exact production callers made the overlapping surgical requests in the critical interval, and what were their affected message IDs?
2. Did the 847 chunk count include duplicate message coverage, orphan chunks, or a chunking configuration that legitimately grouped/split differently? Preserve a per-chunk `message_ids` export before any future repair.
3. Which `ORDER BY created_at` sites are semantic ordering sites versus harmless recency/display queries? The patch audit must enumerate them all.
4. What fallback policy should apply to chunks whose `start_message_id` no longer resolves to a visible message?
5. Should live ingest remain in the same exclusive lane as destructive chunk maintenance, or should the coordinator support cancellation/preemption at a safe unit-of-work boundary?
6. Can any `updateMessage()` completion path safely set `skipChunkRebuild`, or must final staged content always request maintenance? This must be decided against retrieval correctness, not merely throughput.
7. Are Cortex signature writes transactionally coupled strongly enough to distinguish a chunk deleted/recreated between processing and signature update under all lane paths?
8. What retention and redaction rules permit collecting the diagnostic journal needed to prove the next incident's exact causal chain?

## Commit/Test Log

| Item | Result |
| --- | --- |
| `2f3a049e` — `test: reproduce chat chunk timestamp ordering bug` | Adds `tests/chat-chunk-ordering.test.ts`, covering shuffled timestamps and same-second chunk ties. **[Code]** |
| Source inspection | Confirmed timestamp ordering in LTM/Cortex paths, `_rebuildInflight`/`_rebuildPending` full escalation, and the serial per-chat coordinator. **[Code]** |
| This document | Investigation/documentation only; it makes no source-code or README change outside `docs/`. |
| Test execution | Attempted `bun test tests/chat-chunk-ordering.test.ts`; blocked because `bun` is not installed/available on this environment's `PATH`. The ordering test is expected to characterize the current defect until the corresponding patch is implemented. |


### Patch A implementation and validation

- **[Historical implementation]** The first Patch A revision made `getChatChunkTopology(userId, chatId)` map contained chunk message IDs to positions in `getMessages(...).filter(m => m.extra?.hidden !== true)`, grounded in `messages.index_in_chat`. It also put full topology loading on the ordinary append path. The final implementation supersedes that last-chunk design.
- **[Code]** Validation requires nonempty string-ID arrays, visible membership, ordered contiguous slices, matching start/end boundaries, unique canonical message indexes, and a gap-free partition beginning at the first visible message. An uncovered trailing message suffix is allowed. Duplicate coverage, overlaps, gaps, orphan/hidden IDs, and malformed JSON invalidate the graph. Validation runs both during anchor lookup and inside the surgical body; invalid topology uses the existing full rebuild path without preserving a prefix.
- **[Code]** Raw diagnostic rows with no visible position sort last; chunk IDs only break ambiguous position ties, never define valid topology. These ambiguous graphs cannot be surgically preserved. The patch does not proactively repair stored corruption on reads.
- **Initial stock regression before Patch A:** `tests/chat-chunk-ordering.test.ts`: **0 pass / 2 fail**.
- **Final targeted Patch A regression:** **21 pass / 0 fail**, 69 assertions.
- **Combined targeted memory regression:** **23 pass / 0 fail**, 82 assertions.
- **Broader regression selection:** **134 pass / 0 fail** across 19 files, 418 assertions.
- `chats.service.test.ts` emitted caught asynchronous errors about missing `settings` and `chat_chunks` tables in reduced test fixtures. They did not fail any tests and are not classified as Patch A regressions.
- **Additional existing suite:** `bun test tests/temporary-chats.test.ts`: **6 pass / 5 fail**, 25 assertions. The five failures report `table characters has no column named library_scope` in the existing character-creation fixture; this patch does not change that schema or fixture. No commit was made because not all targeted tests passed.
- Bugs B/C, concurrent mutation during existing asynchronous rebuild operations, and production-scale performance validation remain outside Patch A. Historical incident evidence and the proposed B/C work above are unchanged.

### Final Patch A design

- **[Code]** `chat-chunk-ordering.ts` is the low-level dependency shared by chats, LTM fallback, and Memory Cortex. Its cheap path orders chunks with SQL joins from `start_message_id`/`end_message_id` to `messages.index_in_chat`; `created_at` is not a logical-order key. This removes the chats.service-to-memory-cortex reverse dependency.
- **[Code]** Ordinary chunk listing, recent fallback/candidate queries, consolidation batch selection, and `getLastChatChunk()` use the SQL path. In particular, normal append selection is bounded (`LIMIT 1`) and does not load or parse the visible chat or all chunk `message_ids`.
- **[Code]** Full topology validation remains explicit for anchor selection and surgical execution. It preserves visible-message ordering, excludes hidden messages, permits only contiguous visible slices, rejects malformed/non-string/orphan/hidden/duplicate/overlapping/gapped chunks and bad boundaries, permits an unchunked trailing suffix, and now also rejects `message_count !== message_ids.length`.
- **[Code]** Topology reports structural `valid`, coverage `complete`, `coveredMessageCount`, and `visibleMessageCount` separately. A gap-free chunk prefix with an unchunked visible suffix is valid but incomplete; visible messages with zero chunks are likewise unambiguously incomplete.
- **[Code]** Surgical rebuild and consolidation require structural validity only because they can safely operate on a valid prefix. Cortex rebuild/warmup and vault snapshot/reindex require both validity and complete visible-message coverage; they throw before destructive/copying work and direct repair ownership to chat-memory rebuild.
- **[Compatibility follow-up]** Existing `memory_consolidations.message_range_start/end` rows contain chunk `created_at` timestamps and existing queries order by those columns. Patch A continues writing timestamp-valued ranges to avoid mixed persisted units. Changing these fields to message indexes requires an explicit compatibility and migration decision outside this patch.
- **[Schema follow-up]** Patch A does not treat `cortex_vault_chunks.rowid` as durable semantic order. Vault fallback recency retains its existing `source_created_at` behavior. Portable canonical vault ordering requires an explicit `source_order` column or another schema-backed representation in a future patch.
- **[Audit]** Remaining `chat_chunks.created_at` semantics are intentionally separated: Cortex time-range filtering and decay plus vault `source_created_at` are wall-clock metadata; vectorization queue ordering is work-queue priority; the Cortex chunks route is UI/diagnostic ordering.
- **[Validated]** Regression coverage includes count mismatch, append fast-path last selection, LTM fallback recency, Cortex candidate recency, consolidation batch order, and structural-validity versus complete-coverage topology state. Patch A is implemented and regression-tested with the final results recorded above.
- **[Follow-up]** Persisted consolidation `message_range_start/message_range_end` values retain their timestamp-valued historical meaning. Canonical message-index-backed ranges require an explicit migration and compatibility decision before changing these units.
- **[Follow-up]** Portable vault source ordering remains schema-limited. A future schema-backed `source_order` column or equivalent is required; SQLite `rowid` is not accepted as a durable semantic ordinal.
- **[Follow-up]** Production-scale performance validation remains outstanding.
