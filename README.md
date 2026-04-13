# BudgeTrak

Android budgeting app by **Tech Advantage LLC** — package `com.techadvantage.budgetrak`.

## Where to find things

### Current state / todos
- **`memory/`** — single source of truth for project context. Read `memory/MEMORY.md` first; it indexes every memory file (specs, project notes, feedback rules, references).
- **`memory/project_prelaunch_todo.md`** — the active todo list. _(Replaces the old `Todo.txt` at repo root, deleted 2026-04-13.)_

### Docs
- **`docs/BudgeTrak_SSD_v2.6.md`** — system specification.
- **`docs/BudgeTrak_LLD_v2.6.md`** — low-level design.
- **`docs/RECEIPT_PHOTO_DESIGN.md`** — receipt photo design notes (folded into `memory/spec_receipt_photos.md`; kept here as historical).

### Code
- **`app/src/main/java/com/techadvantage/budgetrak/`** — Android Kotlin source. 47 k lines / 94 files.
- **`app/src/main/AndroidManifest.xml`** — declares only `INTERNET`; camera/media go through runtime request + photo picker.

### Backend
- **`functions/`** — Firebase Cloud Functions (Node.js 22). Deployed from this dir via `firebase deploy --only functions`.
- **`firebase.json`** / **`.firebaserc`** — Firebase project config (project ID: `sync-23ce9`).
- **`firebase-config-reference.txt`** — full settings snapshot (security rules, App Check, TTLs, Cloud Functions, BigQuery). Keep this in sync with Firebase Console changes.

### Tools
- **`tools/query-crashlytics.js`** — Node BigQuery query tool for Crashlytics export. See `memory/reference_crashlytics_bigquery.md` for usage.

## Build (Termux)

```
export JAVA_HOME=/data/data/com.termux/files/usr
./gradlew assembleDebug --no-daemon
```

APK ends up at `app/build/outputs/apk/debug/app-debug.apk`. Copy to `/storage/emulated/0/Download/` to install.

## Memory system

`memory/` is symlinked from `~/.claude/projects/-data-data-com-termux-files-home-dailyBudget/memory` so Claude Code reads the same files that are tracked in git. `/push` covers memory changes automatically.

## Branches

`dev` (working) → `main` (releases). Default push: `dev` only.
