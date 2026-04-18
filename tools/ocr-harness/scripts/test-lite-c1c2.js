#!/usr/bin/env node
// Lite Call 1 + Call 2 only — inspect item names and category assignments
// without running the price-extraction Call 3. Purpose: analyse how accurate
// Call 2's description + categoryId output is on its own.
//
// Outputs human-readable per-receipt dumps + a categorised summary, plus a
// JSON file for deeper inspection.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import "dotenv/config";
import { GoogleGenAI } from "@google/genai";

import { TEST_CATEGORIES } from "../src/categories.js";

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), "..");
const LITE = "gemini-2.5-flash-lite";

const TEST_FILES = [
  "target_long_1.jpg", "target_long_2.jpg", "target.jpg",
  "walmart_1.jpg", "walmart_2.jpg",
  "sams_1.jpg", "sams_2.jpg", "sams_club.jpg",
  "costco_3.jpg",
  "sroie_0024.jpg", "sroie_0070.jpg", "sroie_0096.jpg",
  "Screenshot_20260415_191342_Amazon Shopping.jpg",
  "Screenshot_20260415_191443_Amazon Shopping.jpg",
];

const LABELS = JSON.parse(fs.readFileSync(path.join(ROOT, "test-data", "labels.json"), "utf8"));
const labelByFile = new Map(LABELS.map(l => [l.file, l]));
const catName = new Map(TEST_CATEGORIES.map(c => [c.id, c.name]));

function categoryList(cats) {
  return cats
    .filter(c => c.tag !== "supercharge" && c.tag !== "recurring_income" && !c.deleted)
    .map(c => c.tag ? `  - id=${c.id} name="${c.name}" tag="${c.tag}"` : `  - id=${c.id} name="${c.name}"`)
    .join("\n");
}

// ─── Shared preamble — identical bytes across every call in a pipeline run.
// Placed AFTER the image and BEFORE the call-specific task so that both the
// image and this text form a common prefix that Gemini's implicit caching
// (1024-token minimum on Flash-Lite) can hit on calls 2, 3, ... within a run.
function sharedPreamble(cats) {
  return `You are analysing a retail receipt. This request is one step in a multi-step pipeline; the same receipt image is sent on every step, but each step asks for a different slice of the data. Apply the rules below to whichever task is at the end of this message.

CATEGORY LIST (use these exact integer IDs):
${categoryList(cats)}

GENERAL RULES (apply to every step of the pipeline):

## Lines to EXCLUDE when enumerating purchased items

The following are NOT purchased products and must not appear as items:
- Promo / gift-card reward earn lines (e.g. "$5 GC Circle", "PROMO GFTCRD", "Earned $X in rewards"). These describe a reward the shopper received, not a product bought.
- Coupon / discount lines, negative-amount adjustments, manufacturer rebates, member savings lines.
- Balance-inquiry, subtotal, tax-summary, loyalty-point balance, membership-fee balance lines.
- "Regular Price \$X" / "Was \$X" reference lines that appear under an actual item — these are metadata on the previous item.
- Tender and payment lines (VISA, MASTERCARD, CASH, CHANGE DUE, CARD ENDING IN, AUTH CODE, APPROVED).
- Header/footer decoration (store address, phone, barcode, survey invitation, return policy, welcome text).

When unsure if a line is an item vs a non-item row, err toward excluding it.

## How to categorize a purchased item

Apply these steps in order; the first rule that clearly matches wins.

1. IDENTIFY THE PRODUCT NOUN. Receipts often use cryptic store-brand prefixes (GV, KS, MM, TMK, SB, HS, BR, UP&UP, PPR, SLT, EM, FB, MM CF, …) or SKU codes followed by an abbreviated product word. Categorize by the trailing product noun, not the prefix. Examples: "GV BOW TIE" is bow-tie pasta (Groceries), not a clothing accessory; "BARNUMS ANI" is animal crackers (Groceries); "NEKOT VAN" is vanilla snack cookies (Groceries); "MM CF LG AA" is a large-size battery (Home Supplies). A short alphanumeric prefix nearly always means "store brand" — look past it to the item noun.

2. PRODUCT-TYPE OVERRIDES beat shallow word matches:
   - Pet food, treats, chews, toys, litter, grooming, collars, leashes → 30186 Home Supplies. (BudgeTrak groups pet items with household; do not pick Groceries.)
   - Batteries of any kind (AA, AAA, C, D, 9V, button, watch, hearing-aid, lithium-ion packs) → 30186 Home Supplies.
   - Vitamins, minerals, supplements, daily multivitamins (including gender/age-targeted: "Men's", "Women's", "Senior", "Kids Gummy", "50+") → 17351 Health/Pharmacy. The gender/age word describes the intended consumer, NOT apparel.
   - OTC medicine, allergy tablets/syrup, pain relievers, first-aid supplies, thermometers, diagnostic tests → 17351 Health/Pharmacy.
   - Personal-care liquids and toiletries (shampoo, conditioner, body wash, deodorant, toothpaste, feminine care, lotion, sunscreen, razors) → 17351 Health/Pharmacy.
   - Paper goods, cleaning, laundry, ziploc/foil/wrap, trash bags, storage bins, light bulbs, tools, hardware, paint, office supplies, stationery, adhesives, tape → 30186 Home Supplies.
   - Seasonal holiday items (items that would only exist for a specific holiday: pastel bunnies or eggs, pumpkin-shaped, heart-shaped, Santa figures, menorahs, 4th-of-July/fireworks, obvious seasonal stickers or banners) → 49552 Holidays/Birthdays. Generic chocolate bars or packaged candy with no seasonal branding stay in Groceries.
   - Books, magazines, video games, board games, dice, puzzles, media discs — adult/general audience → 57937 Entertainment; clearly branded for children → 1276 Kid's Stuff.
   - Children's toys, school workbooks, kids' apparel, baby products clearly for young children → 1276 Kid's Stuff. Adult apparel → 52714 Clothes. Jewellery (necklaces, rings, earrings, watches) and small fashion accessories → 52714 Clothes (the apparel/accessories bucket).
   - Fuel, parking, tolls, rideshare fares, public transit passes → 48281 Transportation/Gas.
   - Hot-deli items or in-store food-court meals eaten on site → 21716 Restaurants/Prepared Food. Frozen or packaged ready-meals sold in the grocery aisle (frozen pizza, microwave dinners, bagged salads) stay in 22695 Groceries.
   - Flowers / bouquets / plants, greeting cards → 49552 Holidays/Birthdays when the purchase looks like a gift (single bouquet with no other seasonal cues); otherwise 30186 Home Supplies (home decor).

3. USE CONTEXT for still-ambiguous items. If the receipt prints section headings (e.g. "APPAREL", "HOME", "GARDEN & HARDWARE", "KITCHEN", "ELECTRONICS"), trust the heading over a brand-name guess. If there is no heading, look at the category you assigned to the items printed immediately before and after the ambiguous line: if the neighbouring items are all groceries, "groceries" is the most likely answer for an unclear mid-list item; if the neighbours are all apparel, lean apparel. Use this nearest-neighbour signal only when direct rules are inconclusive.

4. If an item is TRULY ambiguous across categories (a bouquet could fit Holidays, Home Supplies, or Other), pick the single best household-budget bucket. Do NOT invent exotic categorizations to avoid choosing.

## Sales tax

If enumerating items, include the printed sales-tax line as a separate item with description "Sales Tax" and categoryId set to the receipt's dominant NON-grocery category (the biggest non-food bucket represented on the receipt). Use 30186 Home Supplies if the receipt has no clear non-grocery section.

## Formatting conventions

- All monetary values you return are numbers (use integer cents where asked, else decimal dollars).
- Dates are ISO "YYYY-MM-DD". If only a short date is printed, infer the century sensibly.
- merchant is the consumer-facing brand (e.g. "Target", not "Target Corporation"). merchantLegalName is the legal entity if it clearly differs on the receipt.
- Item descriptions should be the printed text, cleaned up where abbreviations are obvious (e.g. "CHDR" → "Cheddar") but do not invent detail the receipt doesn't show.

---

`;
}

function call1Task() {
  return `CURRENT TASK — CALL 1 (header + total only):
Return JSON with these fields:
  - transcription: every line of the receipt as plain text (optional if tokens are tight; still encouraged)
  - merchant: the consumer brand
  - merchantLegalName: only if different from merchant on the receipt; else omit
  - date: "YYYY-MM-DD"
  - amountCents: INTEGER cents for the paid total. Ignore pre-tax/subtotal and tax-summary rows.
  - categoryAmounts (optional): if you can confidently split the paid total by category using the rules above, return an array of {categoryId, amount}; otherwise omit.
  - notes (optional)`;
}

const CALL1_SCHEMA = {
  type: "object",
  properties: {
    transcription: { type: "string" },
    merchant: { type: "string" }, merchantLegalName: { type: "string" },
    date: { type: "string" }, amountCents: { type: "integer" },
    categoryAmounts: {
      type: "array",
      items: {
        type: "object",
        properties: { categoryId: { type: "integer" }, amount: { type: "number" } },
        required: ["categoryId", "amount"],
      },
    },
    notes: { type: "string" },
  },
  required: ["transcription", "merchant", "date", "amountCents"],
};

function call2Task() {
  return `CURRENT TASK — CALL 2 (itemised list with categories, no prices):
Return JSON with a single field lineItems — an array of {description, categoryId} for every PURCHASED line on the receipt. Apply the exclusion and categorization rules from the preamble above. Include a "Sales Tax" entry as instructed. DO NOT include merchant, date, total, or per-item prices — those are handled by other calls.`;
}

const CALL2_SCHEMA = {
  type: "object",
  properties: {
    lineItems: {
      type: "array",
      items: {
        type: "object",
        properties: {
          description: { type: "string" },
          categoryId: { type: "integer" },
        },
        required: ["description", "categoryId"],
      },
    },
  },
  required: ["lineItems"],
};

const client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

async function liteCall({ imageBytes, mimeType, prompt, schema }) {
  let lastErr;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await client.models.generateContent({
        model: LITE,
        // parts order: image FIRST, then text. The image bytes + shared preamble
        // form a common prefix across every call within a pipeline run, which
        // lets Gemini 2.5 implicit prefix caching discount input tokens on
        // calls 2+ (1024-token minimum on Flash-Lite).
        contents: [{ role: "user", parts: [{ inlineData: { mimeType, data: imageBytes.toString("base64") } }, { text: prompt }] }],
        config: { responseMimeType: "application/json", responseSchema: schema, temperature: 0 },
      });
      return { parsed: JSON.parse(res.text), tokens: res.usageMetadata };
    } catch (e) {
      lastErr = e;
      const msg = String(e.message || e);
      const transient = /503|UNAVAILABLE|overloaded|429|RESOURCE_EXHAUSTED|deadline|fetch failed|network|ECONNRESET|ETIMEDOUT|socket/i.test(msg);
      if (!transient || attempt === 4) throw e;
      await new Promise(r => setTimeout(r, 500 * Math.pow(2, attempt - 1)));
    }
  }
  throw lastErr;
}

function mimeFor(f) {
  const e = path.extname(f).toLowerCase();
  if (e === ".png") return "image/png";
  if (e === ".webp") return "image/webp";
  return "image/jpeg";
}

async function runOne(file) {
  const imgPath = path.join(ROOT, "test-data", "images", file);
  const imageBytes = fs.readFileSync(imgPath);
  const mimeType = mimeFor(file);

  const preamble = sharedPreamble(TEST_CATEGORIES);
  const c1 = await liteCall({ imageBytes, mimeType, prompt: preamble + call1Task(), schema: CALL1_SCHEMA });
  const c2 = await liteCall({ imageBytes, mimeType, prompt: preamble + call2Task(), schema: CALL2_SCHEMA });
  return { c1: c1.parsed, c2: c2.parsed, tokens: { c1: c1.tokens, c2: c2.tokens } };
}

(async () => {
  const out = [];
  for (const file of TEST_FILES) {
    process.stdout.write(`Running ${file}… `);
    try {
      const { c1, c2, tokens } = await runOne(file);
      const label = labelByFile.get(file);
      const items = c2.lineItems || [];
      // Categorise items for easier eyeball
      const byCat = new Map();
      for (const it of items) {
        const arr = byCat.get(it.categoryId) || [];
        arr.push(it.description);
        byCat.set(it.categoryId, arr);
      }
      out.push({ file, label, c1, items, byCat: [...byCat.entries()], tokens });
      const c1In = tokens?.c1?.promptTokenCount || 0;
      const c2In = tokens?.c2?.promptTokenCount || 0;
      const c1Cached = tokens?.c1?.cachedContentTokenCount || 0;
      const c2Cached = tokens?.c2?.cachedContentTokenCount || 0;
      console.log(`${items.length} items  c1_in=${c1In} (cache ${c1Cached})  c2_in=${c2In} (cache ${c2Cached})`);
    } catch (e) {
      console.log("FAIL:", e.message);
      out.push({ file, error: e.message });
    }
  }

  // ─── Pretty-print ────────────────────────────────────────────────
  console.log("\n" + "=".repeat(78));
  for (const row of out) {
    if (row.error) { console.log(`\n### ${row.file} — ERROR: ${row.error}`); continue; }
    const { file, label, c1, items, byCat } = row;
    const amt = (c1.amountCents / 100).toFixed(2);
    console.log(`\n### ${file}`);
    console.log(`   c1: merchant="${c1.merchant}" date=${c1.date} amount=$${amt}`);
    console.log(`   label: merchant="${label?.merchant}" date=${label?.date} amount=$${label?.amount} expectedCats=[${(label?.categoryAmounts || []).map(c => c.categoryId).join(",")}]`);
    console.log(`   c2: ${items.length} items, ${byCat.length} distinct categories`);
    for (const [cid, descs] of byCat) {
      console.log(`     ── ${catName.get(cid) || `[unknown id ${cid}]`} (${descs.length}):`);
      for (const d of descs) console.log(`          • ${d}`);
    }
  }

  const outPath = path.join(ROOT, "results", `lite-c1c2-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log(`\nSaved → ${path.relative(ROOT, outPath)}`);
})();
