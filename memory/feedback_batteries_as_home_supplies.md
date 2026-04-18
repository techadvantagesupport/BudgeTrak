---
name: Batteries categorize as Home Supplies (not Other)
description: User prefers batteries/office supplies/stationery to be categorized as Home Supplies (30186) rather than Other (30426). This affects OCR labeling, prompt rules, and future category guidance.
type: feedback
originSessionId: a00b436a-3ced-4e78-a40e-780a8f5acff8
---
When categorizing receipt items for BudgeTrak, treat batteries, office supplies, and stationery as **Home Supplies (30186)**, not Other (30426).

**Why:** User stated on 2026-04-16 during OCR multi-category testing: "batteries categorized as Home Supplies is probably better than Other anyway." This reflects how batteries and everyday stationery feel like household-stocking items in a budgeting context, not miscellaneous.

**How to apply:**
- In OCR labeling (test bank, Opus agents, harness): batteries/pens/paper/office → 30186 Home Supplies.
- In OCR prompt (C6 rule in `OcrPromptBuilder`): existing mapping says "Batteries, stationery, pens, office supplies → 30426 Other" — consider updating to 30186 next time the prompt is iterated, but verify on harness first.
- Current grader already accepts any returned categoryId that matches the label set, so changing the labeling convention is backward compatible.
