---
name: Claude family unsuitable for BudgeTrak multi-cat receipt OCR
description: After 3 waves × 10 prompt variants each (30 variants) plus Sonnet 4.5 and Opus 4.1 ceiling checks, Claude models cannot hit per-category dollar-split accuracy (cshr) on the app-compressed 5-worst-English multi-cat bank. Don't re-run this experiment.
type: feedback
originSessionId: a00b436a-3ced-4e78-a40e-780a8f5acff8
---
The OCR harness ran 30 Claude prompt variants across three iterative waves (plus Sonnet 4.5 and Opus 4.1 ceiling checks) on the 5 worst English multi-cat receipts (target_long_1, target_long_2, walmart_1, sams_2, sams_club). All three Claude tiers hit a hard ceiling on cshare 0/10 and cset ≤ 7/10.

**Waves summary** (each = 5 receipts × 10 variants × 2 runs = 100 calls):
- **Wave 1** (2026-04-17): baseline + 9 prompt styles (XML, few-shot, CoT, items-only, verify, merchant hints, etc.). Best: H8 merchant-aware, cset 6/10 cshr 0/10.
- **Wave 2**: fixed errored variants + iterated on merchant hints + attacked cshare specifically. Best: W2_03/W2_06/W2_09 all tied at cset 6/10 cshr 0/10.
- **Wave 3**: pivoted to Sonnet + Opus ceiling checks and salvage attempts. Best: W3_05 Haiku mega-prompt (XML + merchant + verify) at cset 7/10 cshr 0/10. Sonnet 4.5 scored WORSE than Haiku (cset 3/9). Opus 4.1 was disastrous (amount 0/10, cset 2/10, $0.03/call).

**Why Claude fails where Gemini Pro wins**: our production images are 1000px max (app-style preprocessing) and the worst receipts compress tall Target/Walmart scans to ~150-300px wide. Gemini 2.5 Pro@1024 reads them at cset 10/10 cshr 5/10; Claude's vision pipeline appears to struggle with compressed tile layouts regardless of tier or prompt.

**cshare 0/10 was constant across every Claude variant**. Extended thinking didn't help. Multi-shot examples didn't help. XML structure didn't help. Step-by-step discipline didn't help. Opus didn't help.

**Don't re-run this experiment unless**:
- Anthropic ships a new vision backbone (would show up in a new model version).
- The app image pipeline changes to keep higher resolution (unlikely — app's 1000px cap + JPEG compression is fixed by `ReceiptManager.kt`).

**Decision**: Pro@1024 ships as the multi-cat tier. Lite stays single-cat. Claude is not a candidate for receipt OCR on BudgeTrak's image profile. Evidence: `results/haiku-10-variants-*.json`, `results/haiku-wave2-*.json`, `results/haiku-wave3-*.json`.
