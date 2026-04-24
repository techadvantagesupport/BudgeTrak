---
name: Firebase rules — source of truth + audit findings
description: firestore.rules, storage.rules, database.rules.json now live in the repo root; firebase.json references them. Fetch script at tools/fetch-rules.js. Photo-sync surface is correctly gated; three general-security ⚠️ items flagged separately.
type: reference
originSessionId: ea9e173a-ca3d-4f87-b67a-ceac73953250
---
# Firebase Rules

## Source of truth (added 2026-04-23)

- **Firestore rules**: `firestore.rules` at repo root.
- **Cloud Storage rules**: `storage.rules` at repo root.
- **RTDB rules**: `database.rules.json` at repo root.
- **Deploy config**: `firebase.json` now lists all three so `firebase deploy --only firestore:rules` / `storage:rules` / `database` work.
- **Refresh from live project**: `node tools/fetch-rules.js` — uses the debug-only service-account JSON (gitignored) to call the Firebase Rules API. Writes all three rule files, overwriting the local copies. Run when rules are modified via Firebase Console.

## Photo-sync rule correctness

- `firestore.rules` — `imageLedger/{docId}` and all other sync-data collections gate on `isMember(groupId)`. The `{document=**}` catch-all denies everything else.
- `storage.rules` — `groups/{gid}/**` requires auth + Firestore membership lookup. Covers `receipts/*.enc`, `photoSnapshot.enc`, `joinSnapshot.enc`.
- RTDB — not used for photo sync (only presence).

**Verdict:** photo sync surface is properly gated. FCM fan-out via `onImageLedgerWrite` + the v2.7 writer-membership check in `collectRecipientTokens` is a defense-in-depth layer on top.

## General-security fixes (deployed 2026-04-23)

### ✅ Group doc: split `read` into `get`/`list`, forbid `list`
`firestore.rules` — was `allow read: if request.auth != null` on `match /groups/{groupId}`. Now `allow get: if request.auth != null; allow list: if false;`. Blocks authenticated-but-non-member attackers from enumerating every group's `deviceChecksums`, flag clocks, metadata. `get`-by-ID is preserved so `getGroupHealthStatus` (dissolution detection) still works. No client code relied on `list` of groups; `presenceHeartbeat` Cloud Function uses Admin SDK (rules bypass).

### ✅ Pairing codes: split `read` into `get`/`list`, forbid `list`
`firestore.rules` — pairing code doc IDs ARE the 6-character codes. With `allow read` (including `list`), any authenticated user could have enumerated every active code. Now `allow get: if request.auth != null; allow list: if false;`. The redeem flow uses `get` by ID (the joining device must already know the code). `create`/`delete` unchanged. Deployed 2026-04-23.

## Remaining observations

### ✅ RTDB orphan presence sweep (mitigates the RTDB write gap)
`database.rules.json:7-10` allows any authenticated user to write `groups/$groupId/presence/$deviceId`. RTDB rules can't cross-reference Firestore, so this gap can't be closed at the rule level. Attack ceiling is node bloat — `presenceHeartbeat` Cloud Function filters stale devices via Firestore `devices/{id}/fcmToken` (gated by `isMember`), so orphan presence entries can't escalate to FCM spam.

**Cloud Function `presenceOrphanCleanup`** (deployed 2026-04-23) runs every Sunday 03:00 UTC. Walks each group's RTDB presence node, bulk-fetches the corresponding Firestore `devices/{deviceId}` docs via `db().getAll(...refs)`, and removes any RTDB presence entry whose matching Firestore device doesn't exist or has `removed: true`. Log-only when nothing to prune; groupsChecked + totalPruned counters at end.

Not a strict replacement for rule enforcement (fresh orphans live up to a week between sweeps) but mitigates long-term bloat. Same O(n) sequential scaling concern as `presenceHeartbeat` — acceptable at current scale, tracked alongside in `project_prelaunch_todo.md`.

### No explicit App Check check in rules
App Check enforcement lives at the project/bucket level (Firebase Console), not in rule expressions. If that toggle is ever flipped off, rules alone don't catch it. Mitigation: a monitoring alert on `request.auth.token.firebase_app_check == null` rejected requests — not currently set up.

### No explicit App Check check in rules
App Check enforcement lives at the project/bucket level (Firebase Console), not in rule expressions. If that toggle is ever flipped off, rules alone don't catch it. Mitigation: a monitoring alert on `request.auth.token.firebase_app_check == null` rejected requests — not currently set up.

## Related pre-existing memory files
- `memory/project_prelaunch_todo.md` — general hardening checklist.
- `memory/feedback_image_ledger_no_create_bump.md` — photo-sync-specific design invariant.
