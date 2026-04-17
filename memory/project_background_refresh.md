---
name: Background Sync & Period Refresh
description: How foreground and background share sync/merge/period-refresh logic; history of why this refactor happened
type: project
---

Background sync + period refresh consolidation implemented 2026-03-29 (supersedes `WidgetRefreshWorker` and the old `SyncWorker`).

**Problem the refactor solved.** Period refresh and Firestore sync only ran in the foreground, so the widget showed stale cash after period boundaries or after remote transactions landed while the app was closed.

## Shared components

1. **`SyncMergeProcessor`** (`data/sync/`) — extracted merge logic from MainActivity's `onBatchChanged`. Handles category tag dedup, conflict detection, SharedSettings application. Foreground and background call it identically.

2. **`PeriodRefreshService`** (`data/`) — extracted period refresh logic from MainActivity. Loads from disk, creates ledger entries, accrues SG / RE, computes `budgetAmount` via `BudgetCalculator.computeFullBudgetAmount()`, saves to disk. `@Synchronized` prevents foreground/background race.

3. **`BackgroundSyncWorker`** (`data/sync/`) — every 15 min via WorkManager. Three tiers:
   - App visible (`isAppActive`) → skip.
   - App stopped, ViewModel alive → App Check refresh + listener health + RTDB ping.
   - ViewModel dead → full sync: opens short-lived `FirestoreDocSync` listener (~5–10 s, served largely from Firestore offline cache) → `SyncMergeProcessor` → `PeriodRefreshService` → push pending via `FirestoreDocService` directly (not `SyncWriteHelper` — that requires foreground init) → `recomputeCash()` (catches remote transactions even without a period boundary) → widget update + device metadata (including cash fingerprint).

   **Double-fire guard (2026-04-16).** Added `internal val isRunning = AtomicBoolean(false)` at the companion level. `doWork()` opens with `compareAndSet(false, true)` and returns early (logging `"Worker skipped: another run already in progress"`) when the flag is already set. Why: the periodic worker uses unique name `WORK_NAME = "period_refresh"` and the FCM one-shot uses `ONESHOT_WORK_NAME = "period_refresh_oneshot"` — WorkManager's KEEP policy doesn't dedupe across different names, so without this guard an FCM arriving during the 15-min periodic run spawns a parallel Tier 3 execution (observed in Kim's 2026-04-16 14:08 log: two runs 118ms apart, doubled listeners, doubled RTDB pings).

4. **`DiagDumpBuilder`** (`data/`) — background-capable diagnostic dump generator. `BackgroundSyncWorker` generates fresh dumps on FCM debug requests instead of uploading stale files. Also houses `writeDiagToMediaStore()` and `sanitizeDeviceName()`.

5. **`FcmService.handleWakeForSync()`** — called on `heartbeat` and `sync_push` FCMs. Enqueues `BackgroundSyncWorker.runOnce()` then **busy-waits up to 9 seconds** on the worker's `isRunning` flag.

   Why the busy-wait matters: `onMessageReceived` has a ~10s execution budget. If the FCM handler returns immediately after enqueueing (as it did pre-2026-04-16), Android kills the process before WorkManager dispatches the worker. On Samsung/Xiaomi devices in Doze / App Standby "rare" bucket, even expedited work gets deferred for hours — we saw this in Kim's dump: five `heartbeat` FCMs at 15-min intervals, all enqueuing workers, none actually running until the user hit the dump button. The busy-wait keeps the FCM process alive during the critical "waiting for WorkManager to pick up the work" window (~100–500ms typical). Once the worker starts, WorkManager's service binding pins the process — the full pipeline (Firestore sync, period refresh, Firestore push, RTDB lastSeen ping, receipt sync, widget update) completes even if the FCM handler releases at the 9s mark.

## Widget throttle

`BudgetWidgetProvider.updateAllWidgets()` debounces to once per 5 seconds, preventing frame drops from rapid listener callbacks during period-refresh RE/SG accrual pushes.

## Firestore offline cache

Enabled by default in the Firebase Android SDK. The short-lived background listener gets its initial snapshot from the local cache (free, instant) and only fetches server-side changes.

## JIT lesson (2026-03-30)

Extracting Compose screen branches into wrapper functions creates lambda overhead at the call site — each `onSetFoo = { foo = it }` parameter generates a lambda object (~5 DEX instructions). For branches with many state setters (like `BudgetConfigScreen` with 18 lambdas), the overhead can exceed the instruction savings, making the parent method larger. Pure function extraction (no lambdas) is always safe. See `feedback_jit_extraction.md`.

## How to apply

When modifying sync merge logic, edit `SyncMergeProcessor` — foreground and background both use it. When modifying period refresh, edit `PeriodRefreshService`. `BackgroundSyncWorker` orchestrates both but has no business logic of its own.

There is no longer a `WidgetRefreshWorker` — it was fully absorbed into `BackgroundSyncWorker`.
