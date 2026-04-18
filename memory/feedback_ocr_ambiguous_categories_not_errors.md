---
name: Don't count reasonable-alternative categorizations as OCR errors
description: When grading receipt category extraction, accept any defensible categorization even if it doesn't exactly match the label. Many real-world items have multiple legitimate budget buckets.
type: feedback
originSessionId: a00b436a-3ced-4e78-a40e-780a8f5acff8
---
When analyzing OCR category-split results, do NOT count a mismatch as an error when the model's choice is a reasonable alternative to the ground-truth label. Examples the user explicitly called out on 2026-04-16:

- **Rotisserie chicken** → Groceries OR Restaurants/Prepared Food (both valid)
- **Steel-toed boots** → Clothes OR Employment Expenses OR Farm (all valid)
- **Soap/body wash/shampoo** → Health/Pharmacy OR Home Supplies (both valid)

**Why:** Grading category mismatches literally penalizes the model for judgment calls that a human user would also debate. Users won't perceive a "wrong" category when the model's choice is defensible — they'll just re-tap it if they disagree.

**How to apply:**
- When reporting OCR results, look at each cset-failing receipt individually. If the disagreement falls into a known-ambiguous axis (prepared-food-vs-grocery, work-gear-vs-apparel, personal-care-vs-pharmacy, toys-vs-kids-stuff-vs-entertainment, seasonal-candy-vs-grocery), count it as acceptable and note the rationale.
- When iterating on the harness prompt or grader, consider adding a "synonym group" concept so this becomes automatic: e.g. {21716, 22695} treated as equivalent for items like rotisserie chicken, {52714, 47837, 50371} for work-use apparel, {17351, 30186} for personal care.
- When defining new labels, pick the "most common user choice" for the label, but don't expect the model to match it on ambiguous items.
