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

### RTDB presence writable without membership check
`database.rules.json:7-10` → `.write: auth != null` for `groups/$groupId/presence/$deviceId`. Any authenticated user can inject fake presence entries. **Cannot escalate to FCM spam**: `presenceHeartbeat` Cloud Function filters stale devices via `tokensForDevices(groupId, staleIds)` which reads Firestore `devices/{id}` — attacker-injected presence entries won't have a matching Firestore devices doc (that requires `isMember`), so no FCM sent. Worst case is RTDB node bloat that could slow `RealtimePresenceService.getDevices()` reads for real users. RTDB rules can't cross-reference Firestore; tightening requires Cloud Functions (periodic prune of orphan presence entries) or migrating presence to Firestore. Low priority — vandalism only.

### No explicit App Check check in rules
App Check enforcement lives at the project/bucket level (Firebase Console), not in rule expressions. If that toggle is ever flipped off, rules alone don't catch it. Mitigation: a monitoring alert on `request.auth.token.firebase_app_check == null` rejected requests — not currently set up.

### No explicit App Check check in rules
App Check enforcement lives at the project/bucket level (Firebase Console), not in rule expressions. If that toggle is ever flipped off, rules alone don't catch it. Mitigation: a monitoring alert on `request.auth.token.firebase_app_check == null` rejected requests — not currently set up.

## Related pre-existing memory files
- `memory/project_prelaunch_todo.md` — general hardening checklist.
- `memory/feedback_image_ledger_no_create_bump.md` — photo-sync-specific design invariant.
