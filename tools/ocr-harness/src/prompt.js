// Prompt template for receipt extraction.
//
// This is the source-of-truth prompt for v0 harness iteration. When we're
// happy with per-field accuracy here, the same text ports to Kotlin and
// lives in Firebase Remote Config (keyed on `promptVersion` for A/B).
//
// Edit freely — the runner logs `promptVersion` into each result so we can
// trace accuracy changes back to prompt revisions.

export const PROMPT_VERSION = "v0.3";

export function buildPrompt(categories) {
  const categoryList = categories
    .map(c => c.tag ? `  - id=${c.id} name="${c.name}" tag="${c.tag}"`
                    : `  - id=${c.id} name="${c.name}"`)
    .join("\n");

  return `You are a receipt-reading assistant. Extract purchase details from the image and return JSON that matches the provided schema.

Required fields:
- merchant: the business or retailer name. Prefer the common consumer name (e.g., "Chipotle", not "Chipotle Mexican Grill #1234"). If the receipt is from a food-delivery app (DoorDash, Uber Eats, Grubhub), use the *restaurant* name as merchant and mention the delivery app in notes. Preserve the merchant name in its original language — do not translate it to English (e.g., "NHÀ SÁCH GD-TC CẨM PHẢ" stays as written, not "GD-TC Cẩm Phả Bookstore").
- date: the transaction date in YYYY-MM-DD. Receipts often print multiple dates; prefer the transaction/purchase date over print or due dates.
- amount: the final total paid, including tax and tip. Receipts often print the total twice; use the final printed total, not the subtotal. If the receipt has a separate GST/VAT/Tax summary table at the bottom, ignore any 'Total' row inside that table — it shows the pre-tax net amount, not the transaction total. Use the transaction total printed above the summary. Amount must be a positive number. Number formatting varies by locale: US/UK receipts use comma as thousand separator and period as decimal (e.g. 1,234.56); many European and Asian receipts use period as thousand separator and comma as decimal (e.g. 1.234,56). Vietnamese đồng (VND) has no fractional unit, so dots in VND amounts are always thousand separators — 49.500 VND means 49500, not 49.5.

Optional fields:
- categoryAmounts: if the receipt contains items from clearly different categories, return an array of {categoryId, amount} where the sum equals amount to the cent. Otherwise, return a single-entry array for the best-fit category. Use only categoryIds from the list below.
- lineItems: visible product names, SKU descriptions, or category codes as plain strings. Do not guess products from a UPC code alone.
- notes: short free-form note if something unusual is worth flagging (refund, tip line, delivery app, non-English, low-confidence fields).

Available categories:
${categoryList}

Do not invent categoryIds that are not in the list. If no category fits, omit categoryAmounts.
If a required field is genuinely not visible on the receipt, omit it rather than guessing.`;
}
