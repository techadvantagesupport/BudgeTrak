---
name: BudgeTrak AI features — explicit trigger, tier per-feature
description: AI/OCR features trigger on explicit user action (tap), not automatically. Tier gating is decided per-feature: OCR is Subscriber-only, CSV categorization is Paid+Subscriber.
type: feedback
originSessionId: a00b436a-3ced-4e78-a40e-780a8f5acff8
---
AI features in BudgeTrak must be triggered explicitly by the user — never automatically on photo capture, share, import, or dialog open.

**Why:** Automatic AI would waste API quota on non-receipt images (selfies, item closeups, storefronts) or on low-value CSV rows the on-device matcher already handles. Explicit-trigger also gives the user clear intent and control.

**How to apply (general rules):**
- AI runs only when the user taps a specific AI affordance — the `AutoAwesome` sparkle icon for OCR, the "Enable AI categorization" checkbox in Settings for CSV.
- Never run AI on photo capture, share, or CSV import by itself.
- AI-provided fields never set `verified = true` — the user must review.

**Tier gating is per-feature, not a blanket rule:**
- **Receipt OCR (in TransactionDialog)** → `isSubscriber` only. Free and Paid users see an upgrade toast. OCR processes whichever slot the user has highlighted via long-press (blue outline) in the dialog's photo bar; extra slots sit un-highlighted. Historical note: prior to 2026-04-18 OCR always read slot 1 (the `runOcrOnSlot1` function name is a vestige).
- **CSV Categorization (during import)** → `isPaidUser || isSubscriber` (checked in SettingsScreen for the toggle; checked again at import time). This differs from OCR because CSV categorization runs on text-only rows, not images — cheaper per call and a natural complement to the Paid-tier import feature itself.

**OCR target-selection UX specifics (post 2026-04-18):**
- Long-press a thumbnail in the photo bar → blue 2dp outline marks it as the AI scan target.
- If the user taps the sparkle without any highlighted photo, toast: "Long-press a photo to highlight it as the scan target".
- If the user has zero photos, toast: "Add a receipt photo first".
- Long-press the already-highlighted slot to clear; long-press a different slot to move. Long-press + drag reorders photos among occupied slots.

**OCR prefill rules (post 2026-04-18):**
- **Merchant, date, amount, and per-cat amounts** — always overwritten by OCR output. The user asked for OCR; they want the result. `verified` is still reset to `false` so they must review before save.
- **Category selection (checkboxes)** — preserved if the user had any category pre-selected at the moment the sparkle was tapped. Otherwise OCR's category set replaces the selection.
- **The AI does NOT modify the user's category selection itself** — it only fills amounts. So on an existing transaction where (say) only "Other" is checked, OCR will route the entire receipt total into "Other" even if it reads grocery + home items on the receipt. To let the AI re-evaluate categories, the user must deselect all cats first. A tappable banner above the category picker (subscriber dialogs only) deep-links to this explanation in the help screen under "Pre-selected categories & receipt scanning".

**CSV Categorization privacy (2026-04-18):**
- Payload sent to Gemini contains only the transaction's `merchant` + `amount` (plus its batch index). The `date` is NOT sent. `CategorizerPromptBuilder.kt` + `AiCategorizerService.kt` must stay aligned: if a future change adds or removes fields, update both files AND the `aiCsvCategorizeHelpBody` strings (en + es) so the privacy claim stays accurate. The on-device matcher handles learned merchants first; the AI only sees rows it couldn't match.
