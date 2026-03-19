# syncBudget Project Memory

## Project Overview
- Android budgeting app called "syncBudget"
- Package: `com.syncbudget.app`
- Working dir: `/data/data/com.termux/files/home/dailyBudget`

## Build Environment (Termux)
- **JAVA_HOME**: Must set `export JAVA_HOME=/data/data/com.termux/files/usr` before builds
- **Android SDK**: `~/android-sdk` (set in `local.properties`, NOT in env vars)
- **aapt2 issue**: AGP-bundled aapt2 is x86_64, won't run on ARM. Build-tools 35+ also ships x86_64 aapt2. Build-tools 34.0.0 has ARM aapt2 (symlink to `/usr/bin/aapt2`). Fix: `android.aapt2FromMavenOverride` in gradle.properties
- **aapt2 + compileSdk**: The Termux aapt2 (v2.19 from bt34) **cannot** load android-35 android.jar. Must use `compileSdk = 34`
- **No Gradle binary**: Uses downloaded wrapper (gradlew from Gradle GitHub v8.9.0)
- **Build command**: `export JAVA_HOME=/data/data/com.termux/files/usr && ./gradlew assembleDebug --no-daemon`
- **APK install**: Copy to `/storage/emulated/0/Download/` and install from file manager

## Dependencies (compileSdk 34 compatible)
- AGP 8.7.3, Gradle 8.9, Kotlin 2.0.21
- Compose BOM: 2024.09.03
- core-ktx: 1.13.1, lifecycle: 2.8.6, activity-compose: 1.9.2
- Firebase BOM: 32.7.0, firebase-firestore, work-runtime-ktx: 2.9.1
- google-services plugin: 4.4.2 (placeholder google-services.json present)
- Do NOT use core-ktx 1.15.0+ or BOM 2024.12.01+ (require compileSdk 35)

## Architecture
- Kotlin + Jetpack Compose, single Activity
- Key files: see `memory/architecture.md`

## Family Sync (Phase 1+2 implemented)
- Per-field LWW-Register CRDTs with Lamport timestamps
- All data classes have sync fields: `deviceId`, `deleted`, per-field `_clock` values
- Repositories save/load sync fields with backward-compatible defaults
- `safeBudgetAmount` and `budgetAmount` are `derivedStateOf` (auto-recalculate)
- Deletes use tombstones (`deleted=true`) instead of removal; UI gets `.active` filtered lists
- Period ledger records budget amounts at each period refresh
- Sync engine files in `data/sync/`: LamportClock, SyncIdGenerator, SyncFilters, CrdtMerge, PeriodLedger, DeltaSerializer, DeltaBuilder, FirestoreService, SyncEngine, PeriodLedgerCorrector, SnapshotManager, SyncWorker, IntegrityChecker
- CryptoHelper has `encryptWithKey`/`decryptWithKey` (direct 256-bit key, no PBKDF2)
- Placeholder `google-services.json` in app/ — replace with real one before Firebase works
- **Sync reliability fixes**: `lastPushedClock` advanced AFTER successful Firestore push (not before); skeleton guard accepts+logs instead of silently dropping; per-field rescue (not blanket); continuous clk=0 fix for critical fields
- **Integrity check**: Every 30min on quiet cycles, devices publish segmented fingerprints (16 segments per collection) to device metadata. Surgical auto-repair: XOR trick pinpoints single missing records; segment fallback for multi-record divergence; 200-record safety cap; multi-device aware (up to 5 peers)

## Transaction Linking & Remembered Amounts
- Transactions remember the linked entry's amount at link time: `linkedRecurringExpenseAmount`, `linkedIncomeSourceAmount`
- `amortizationAppliedAmount` tracks how much was already deducted when an amortization entry is deleted
- `BudgetCalculator.recomputeAvailableCash` uses remembered amounts (not live lookups) for deltas
- Deleting RE/income source: unlinks transactions but preserves remembered amounts (correct delta)
- Manual unlink: clears remembered amounts to 0 (linked-in-error, full amount applies)
- Editing RE/income amount: confirmation dialog asks "apply to past transactions?"
- Migration `migration_backfill_linked_amounts` backfills remembered amounts on existing data

## Home Screen Widget
- Single widget: `BudgetWidgetProvider` with `WidgetRenderer` (Canvas bitmap)
- Solari flip-display renders as bitmap, button bar is XML layout below it
- Cards top-aligned, bitmap auto-sized to card content height (max 75% of widget)
- Theme-aware: light mode uses blue cards (`#305880`), dark mode uses dark cards (`#1A1A1A`)
- Logo (blue tint `#305880`) visibility controlled by `showWidgetLogo` pref (Settings checkbox)
- Button bar: +/- buttons aligned with card edges via `setViewPadding`, logo centered between
- `ic_minus.xml` custom vector drawable for the red minus button
- Non-paid users: overlay "Upgrade for full widget" text on Solari, 1 widget transaction/day limit
- Paid status tracked via `isPaidUser` boolean in `app_prefs` SharedPreferences
- Widget updates triggered from: MainActivity, SyncWorker, WidgetTransactionActivity, Settings changes
- Min size: 2x1 (110dp x 40dp), default 4x1 (250dp), no max limits

## Output & Diagnostic Files
- **Admin device files** → `/storage/emulated/0/Download/`
- **Non-admin device files** → `/storage/emulated/0/Download/Quick Share/` (transferred via Quick Share)
- Files to check frequently for debugging:
  - `sync_diag.txt` — Full CRDT state dump: all transactions, categories, recurring expenses, income sources, amortization entries, period ledger, shared settings, sync metadata. Generated from app's "Export Sync Diagnostics" button.
  - `sync_log.txt` — File-based sync log written by SyncEngine during sync operations. Shows step-by-step progress, delta counts, merge details, errors.
  - `Credit.csv`, `General Checking - *.csv` — Bank CSV files imported by the user for transaction loading
  - `app-debug.apk` — Built APK copied here for installation

## i18n / Translation
- [Translation context for new strings](feedback_translation_context.md) — Always add `TranslationContext.kt` entries for new UI strings

## Planned Features
- [Receipt photo design](project_receipt_photos.md) — Photo capture, Cloud Storage sync, image ledger, deterministic upload, 14-day pruning

## Sync Protocol
- [Min sync version](project_min_sync_version.md) — Bump MIN_SYNC_VERSION when making breaking sync changes (new data types, changed formats)

## Important Feedback
- [Preserve existing fixes](feedback_preserve_fixes.md) — Never undo previous bug fixes when working on audit items
- [Keep .claude-memory current](feedback_claude_memory_sync.md) — Always sync memory files to .claude-memory/ in project root

## UI Design Preferences
- HTML mockups to `/storage/emulated/0/Download/` are a great design tool for iterating on UI
- Dialog style preferences: Option D (icon indicators) + Option E (highlighted differences)
- Dialogs should have: colored header, colored footer with buttons, clear item distinction
- [Dialog design guide](feedback_dialog_design_guide.md) — Full standard for all dialogs, popups, toasts, buttons
