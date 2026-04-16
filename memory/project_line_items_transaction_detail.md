---
name: Item-level view using OCR lineItems (future feature)
description: Future feature idea — show the OCR-extracted lineItems on a transaction-detail view, and eventually allow users to split by item or auto-create shopping lists.
type: project
---

Gemini returns `lineItems: List<String>` as part of the OCR response (e.g. `["Bananas $1.99", "Milk $3.49"]`). The v1 OCR integration does not display them anywhere, but they're useful for:

- **Transaction detail view**: show each item on a Sam's-Club-style detail screen under the transaction — lets the user audit what was actually purchased without needing to zoom into the photo.
- **Split-by-item**: let the user select items from the list and split them into a separate transaction or move them between categoryAmount buckets.
- **Shopping-list generation**: derive a recurring shopping list from frequent items.

**Why:** User asked to save this as a future direction during the v1 ship on 2026-04-16. The data is already in `OcrResult.lineItems` — just not consumed.

**How to apply:** When planning follow-up OCR work, pick up from `OcrResult.lineItems` rather than re-prompting. If the app-side response schema ever drops `lineItems` to save tokens, these features would need the schema restored.
