---
name: Minimum sync version protocol
description: Devices post appVersion and minSyncVersion to Firestore; sync blocks if any device requires a higher version than yours
type: project
---

Minimum sync version — implemented. Devices post their version and minimum required sync version to Firestore device metadata.

**Why:** Prevents data corruption when a new app version introduces breaking sync changes (new data types, changed field formats, etc.).

**How to apply:** When making a breaking sync change (new synced data type, changed serialization format, removed field), increment `MIN_SYNC_VERSION` in SyncEngine.kt companion object. Non-breaking changes (UI, bug fixes, new non-synced features) do NOT require incrementing.

**Current value:** MIN_SYNC_VERSION = 1 (initial release)

**History:**
- v1.0.0 / v1.1.0: MIN_SYNC_VERSION = 1 (original sync protocol)
