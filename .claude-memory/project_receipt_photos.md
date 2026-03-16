---
name: Receipt photo feature design
description: Architecture for receipt photo capture, sync via Cloud Storage, image ledger with hash-based upload assignment, P2P-inspired load distribution, and 14-day pruning
type: project
---

Receipt photo feature — designed but not yet implemented. Subscriber-tier.

**Why:** Users can photograph receipts or purchases, link to transactions, and sync photos across devices without bloating delta payloads.

**How to apply:** When implementing, follow the design in `docs/RECEIPT_PHOTO_DESIGN.md` in the project root. Key files needed: ReceiptManager, ImageLedger, Cloud Storage upload/download, placeholder thumbnail UI. Do NOT put images in Firestore deltas — use Firebase Cloud Storage separately.

**Core design decisions:**
- Max 1000px longest dimension, JPEG 70% quality (~50-150KB)
- Encrypted locally before upload (same key as deltas)
- Separate from delta sync — images travel alongside deltas, not inside them
- P2P-inspired hash-based upload assignment distributes load across devices
- 5-minute failover timeout; duplicate uploads are harmless (same content overwrites)
- Devices finish their own upload queue before volunteering for others' failed assignments
- 5-minute cooldown after own last upload before picking up others' work
- 14-day pruning of cloud files; local copies persist indefinitely
- Missing images show camera placeholder thumbnail until obtained
- Image ledger in Firestore tracks possession per device, upload assignment, and timestamps
