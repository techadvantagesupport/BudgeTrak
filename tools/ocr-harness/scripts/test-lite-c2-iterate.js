#!/usr/bin/env node
// Call 2 prompt iteration study.
// Fixes receipts to 3 long/diverse multi-cat receipts; runs N prompt variants
// once each (single pass, no variance runs); scores category recall + item
// count + distinct-cats returned so variants are directly comparable.
//
// Usage:
//   node scripts/test-lite-c2-iterate.js --round 1
//   (round number selects which variant set below; results saved per round)

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import "dotenv/config";
import { GoogleGenAI } from "@google/genai";

import { TEST_CATEGORIES } from "../src/categories.js";

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), "..");
const LITE = "gemini-2.5-flash-lite";

const RECEIPTS = ["target_long_1.jpg", "target_long_2.jpg", "walmart_2.jpg"];

const LABELS = JSON.parse(fs.readFileSync(path.join(ROOT, "test-data", "labels.json"), "utf8"));
const labelByFile = new Map(LABELS.map(l => [l.file, l]));
const catName = new Map(TEST_CATEGORIES.map(c => [c.id, c.name]));

function categoryList(cats) {
  return cats
    .filter(c => c.tag !== "supercharge" && c.tag !== "recurring_income" && !c.deleted)
    .map(c => c.tag ? `  - id=${c.id} name="${c.name}" tag="${c.tag}"` : `  - id=${c.id} name="${c.name}"`)
    .join("\n");
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

// ═══════════════════════════════════════════════════════════════════
// VARIANTS — each is a function that returns a Call 2 prompt string.
// ═══════════════════════════════════════════════════════════════════

const ROUND_1_VARIANTS = {
  "v1-baseline-terse": (cats) => `List every purchased item on this receipt with a category. Return JSON {lineItems: [{description, categoryId}]}. Include a "Sales Tax" entry. Use these category IDs:
${categoryList(cats)}`,

  "v2-ultra-brief": () => `JSON {lineItems: [{description, categoryId}]} for every purchased line on this receipt. Pick the best categoryId from the schema's enum.`,

  "v3-think-aloud": (cats) => `You will list purchased items with categories. First THINK: what kinds of things are on this receipt? Then list each item. For each item ask "what bucket does a household budget put this in?".

Return JSON {lineItems: [{description, categoryId}]}. Include "Sales Tax". Categories:
${categoryList(cats)}`,

  "v4-section-first": (cats) => `Receipts often print section headings (APPAREL, HOME, KITCHEN, GROCERY, HEALTH & BEAUTY, ELECTRONICS, etc). Items printed below a heading belong to that section.

1. Identify the receipt's section headings in order.
2. For each purchased line under a heading, assign the category that matches the heading.
3. Include "Sales Tax" as its own item.

Return JSON {lineItems: [{description, categoryId}]}. Category IDs:
${categoryList(cats)}`,

  "v5-line-walk": (cats) => `Walk the receipt line by line from top to bottom. For each printed line ask:
  a) Is this a purchased product? (NO if it's a coupon, reward earn, tender, header, or subtotal.)
  b) What is the item? (Strip store-brand prefixes; focus on the product noun.)
  c) What household-budget bucket fits best?

Return JSON {lineItems: [{description, categoryId}]}. Tax is its own item. Categories:
${categoryList(cats)}`,

  "v6-by-example": (cats) => `Extract purchased items and categorize them. Return JSON {lineItems: [{description, categoryId}]}.

Worked examples:
  "GV BOW TIE $1.98" → pasta → Groceries.
  "MM AA-48 $17.98" → batteries → Home Supplies.
  "OAD MENS 300 $18.99" → multivitamin → Health/Pharmacy.
  "$5 GC Circle" → reward earned (NOT a product) → skip.
  "PNK BUNNY8C $1.52" → Easter candy → Holidays/Birthdays.
  "DOG FOOD $64.98" → pet item → Home Supplies.

Always include a Sales Tax item. Categories:
${categoryList(cats)}`,

  "v7-negative-rules": (cats) => `List items purchased. Return {lineItems: [{description, categoryId}]}.

DO NOT include as items:
  - promo reward lines ("$5 GC Circle", rewards earned)
  - coupon / discount / negative adjustments
  - subtotal, tax-summary, balance, membership lines
  - tender lines (VISA, CASH, CHANGE DUE, AUTH CODE)
  - "Regular Price" reference text beneath an item
  - store address/phone/survey text

DO include: every printed product line + one "Sales Tax" line.

Categories (use integer id only):
${categoryList(cats)}`,

  "v8-permissive-other": (cats) => `List each purchased item with its category. Return {lineItems: [{description, categoryId}]}.

When the item is clear, pick the matching category. When the item is cryptic or ambiguous, assign id=30426 (Other) rather than guessing randomly. Include a "Sales Tax" entry. Categories:
${categoryList(cats)}`,

  "v9-long-rubric": (cats) => `You are a budgeting assistant cataloguing items from a retail receipt.

OUTPUT: JSON {lineItems: [{description, categoryId}]}. One entry per purchased line, plus a Sales Tax entry.

RULES:
  R1. Skip non-items: promo earns, coupons, discounts, subtotals, tax summaries, tenders, auth codes, "Regular Price" refs, address/phone/survey text.
  R2. Identify the product noun: store-brand prefixes like GV, KS, MM, TMK, UP&UP, PPR are generic; categorize by the trailing word.
  R3. Overrides (apply these over word-match):
        • pet food/treats/toys/chews/litter → 30186 Home Supplies
        • batteries (AA AAA C D 9V etc.) → 30186 Home Supplies
        • vitamins/supplements (incl "Men's"/"Women's"/"Kids") → 17351 Health/Pharmacy
        • shampoo/conditioner/body wash/deodorant/toothpaste → 17351 Health/Pharmacy
        • paper/cleaning/ziploc/trash/hardware/office → 30186 Home Supplies
        • seasonal holiday items (bunnies/eggs/pumpkins/hearts/Santas) → 49552 Holidays/Birthdays
        • jewelry/necklaces/rings/earrings → 52714 Clothes
        • frozen or packaged ready meals → 22695 Groceries (NOT Restaurants)
        • books/dice/games (adult) → 57937 Entertainment; (kids) → 1276 Kid's Stuff
  R4. Use the receipt's printed section heading if present; override word-level guesses.
  R5. When genuinely ambiguous, look at the category of neighbouring items.

Categories:
${categoryList(cats)}`,

  "v10-transcribe-first": (cats) => `Two-stage task.

STAGE 1 (mental, not returned): read the entire receipt and note every printed item line with its printed price.

STAGE 2 (returned as JSON): for each purchased line from stage 1, emit {description, categoryId}. Skip non-purchase lines (promos, coupons, tax summary, tender, headers, footers). Add a "Sales Tax" entry.

Return {lineItems: [...]}. Categories:
${categoryList(cats)}`,
};

// ─── Round 2 — iterate on Round 1 winners (v1, v3, v7) ────────────

function enumCategoryIds(cats) {
  return cats
    .filter(c => c.tag !== "supercharge" && c.tag !== "recurring_income" && !c.deleted)
    .map(c => c.id);
}

const ROUND_2_VARIANTS = {
  // Control — same as round 1 v1 so we can detect run-to-run drift
  "v1-control": (cats) => `List every purchased item on this receipt with a category. Return JSON {lineItems: [{description, categoryId}]}. Include a "Sales Tax" entry. Use these category IDs:
${categoryList(cats)}`,

  // v1 + the skip-rules that gave v7 its filtering win
  "v11-terse+exclusions": (cats) => `List every PURCHASED item on this receipt with a category. Return JSON {lineItems: [{description, categoryId}]}.

SKIP (not items): promos, gift-card reward earn lines, coupons, discounts, subtotals, tax summaries, tender/auth-code lines, "Regular Price" reference text, store address/phone/survey text.

Include a "Sales Tax" entry. Categories:
${categoryList(cats)}`,

  // v11 + the three most common real-world overrides
  "v12-exclusions+overrides": (cats) => `List every PURCHASED item with a category. Return JSON {lineItems: [{description, categoryId}]}.

SKIP (not items): promos, gift-card reward earns, coupons, discounts, subtotals, tax summaries, tenders, "Regular Price" refs, header/footer text.

OVERRIDES: pet food/treats/chews → 30186 Home Supplies. Batteries → 30186 Home Supplies. Vitamins/supplements incl. gendered ("Men's", "Women's") → 17351 Health/Pharmacy.

Include a "Sales Tax" entry. Categories:
${categoryList(cats)}`,

  // Combine think-aloud framing with exclusions (v3 + v7)
  "v13-think+exclude": (cats) => `For each purchased line, ask: what household-budget bucket fits? Skip non-items (promos, gift-card rewards, coupons, discounts, subtotals, tax summaries, tenders, "Regular Price" refs).

Return JSON {lineItems: [{description, categoryId}]}. Include "Sales Tax". Categories:
${categoryList(cats)}`,

  // Hard-lock categoryId via JSON-schema enum (uses the round-2 custom schema)
  "v14-schema-enum": (cats) => `List every PURCHASED item on this receipt with a category. Return JSON {lineItems: [{description, categoryId}]}. Include "Sales Tax". Pick each categoryId from the provided enum. Category names for reference:
${categoryList(cats)}`,

  // Discourage "Other" as a lazy default
  "v15-no-lazy-other": (cats) => `List every PURCHASED item with a category. Return JSON {lineItems: [{description, categoryId}]}.

Rules:
  - Skip promos, coupons, discounts, tenders, subtotals.
  - Prefer a concrete category (Groceries, Home Supplies, Health/Pharmacy, Clothes, Entertainment, Holidays, Kid's Stuff, etc.) over "Other" (30426). Only use Other when no concrete category plausibly applies.

Include "Sales Tax". Categories:
${categoryList(cats)}`,

  // Micro-hint: games/books/media to Entertainment (saw target_long_2 miss this)
  "v16-games-entertainment": (cats) => `List every PURCHASED item with a category. Return JSON {lineItems: [{description, categoryId}]}. Skip promos/coupons/tenders/subtotals.

Hint: video games, board games, puzzles, books for adults, media discs, dice → 57937 Entertainment (not Electronics or Other).

Include "Sales Tax". Categories:
${categoryList(cats)}`,

  // Micro-hint: frozen/packaged meals stay in Groceries (saw HB PIZZA → Restaurants)
  "v17-frozen-stays-grocery": (cats) => `List every PURCHASED item with a category. Return JSON {lineItems: [{description, categoryId}]}. Skip promos/coupons/tenders/subtotals.

Hint: frozen meals, frozen pizza, microwave dinners, bagged salads, deli-case packaged trays sold for home consumption → 22695 Groceries. Only food eaten on site or hot-deli meals go to Restaurants (21716).

Include "Sales Tax". Categories:
${categoryList(cats)}`,

  // Soft section-heading hint (without forcing like v4 did)
  "v18-section-if-present": (cats) => `List every PURCHASED item with a category. Return JSON {lineItems: [{description, categoryId}]}.

Skip promos/coupons/tenders/subtotals.

If the receipt prints section headings (APPAREL, HOME, KITCHEN, GROCERY, HEALTH & BEAUTY, ELECTRONICS, etc.), use the heading to categorize items printed beneath it. If there are no headings, categorize each line on its own.

Include "Sales Tax". Categories:
${categoryList(cats)}`,

  // Compact "best of all rules" consolidation
  "v19-compact-best": (cats) => `List every PURCHASED item with a category. Return JSON {lineItems: [{description, categoryId}]}.

Skip: promos, gift-card rewards, coupons, discounts, subtotals, tax summaries, tenders, "Regular Price" refs, header/footer.

Apply: pet items → Home Supplies. Batteries → Home Supplies. Vitamins/supplements (incl. "Men's"/"Women's") → Health/Pharmacy. Games/books/dice/media (adult) → Entertainment. Frozen/packaged meals → Groceries. Jewelry/accessories → Clothes. Section headings override word matches.

Include "Sales Tax". Use concrete categories over Other. IDs:
${categoryList(cats)}`,
};

// ─── Round 3 — build on round 2 winners (v15, v19) ─────────────────

const ROUND_3_VARIANTS = {
  "v15-control": (cats) => `List every PURCHASED item with a category. Return JSON {lineItems: [{description, categoryId}]}.

Rules:
  - Skip promos, coupons, discounts, tenders, subtotals.
  - Prefer a concrete category (Groceries, Home Supplies, Health/Pharmacy, Clothes, Entertainment, Holidays, Kid's Stuff, etc.) over "Other" (30426). Only use Other when no concrete category plausibly applies.

Include "Sales Tax". Categories:
${categoryList(cats)}`,

  // Fixed schema-enum (strings, matching Gemini's OpenAPI schema expectations)
  "v20-enum-fixed": (cats) => `List every PURCHASED item on this receipt with a category. Return JSON {lineItems: [{description, categoryId (string)}]}. Include "Sales Tax". Category names for reference:
${categoryList(cats)}`,

  // Stack the two Round 2 winners
  "v21-v15+think": (cats) => `For each purchased line, ask: what household-budget bucket fits? Skip non-items (promos, coupons, discounts, tenders, subtotals, "Regular Price" refs).

Prefer a concrete category over "Other" — only use Other if no other category plausibly fits.

Return JSON {lineItems: [{description, categoryId}]}. Include "Sales Tax". Categories:
${categoryList(cats)}`,

  // Reverse mental frame: iterate categories, list items per category
  "v22-category-first": (cats) => `Walk through each category below. For each, identify which printed lines on this receipt belong in it, and list those items. An item only goes in one category.

Skip non-items (promos, coupons, tenders, subtotals, "Regular Price" refs).

Return JSON {lineItems: [{description, categoryId}]} with one entry per item (ordering doesn't matter). Add a "Sales Tax" entry at the end. Categories:
${categoryList(cats)}`,

  // Preserve receipt print order — may help the model process sequentially
  "v23-order-preserved": (cats) => `List every PURCHASED item on this receipt, IN THE ORDER PRINTED from top to bottom. Skip non-items (promos, coupons, tenders, subtotals, "Regular Price" refs).

Return JSON {lineItems: [{description, categoryId}]}. Include "Sales Tax" as the final entry. Prefer concrete categories over "Other". Categories:
${categoryList(cats)}`,

  // Warn off rarely-correct categories
  "v24-avoid-rare": (cats) => `List every PURCHASED item with a category. Return JSON {lineItems: [{description, categoryId}]}.

Skip non-items (promos, coupons, tenders, subtotals).

Avoid these categories unless the item is unambiguously that type:
  - 42007 Mortgage/Insurance/PropTax
  - 36973 Insurance
  - 48281 Transportation/Gas (only fuel, parking, transit)
  - 17132 Electric/Gas (only utility bills)
  - 62776 Phone/Internet/Computer (only service bills)
  - 47479 Business, 47837 Employment Expenses, 50371 Farm, 35856 Charity

Prefer concrete consumer categories (Groceries, Home Supplies, Health/Pharmacy, Clothes, Entertainment, Holidays, Kid's Stuff). Only use "Other" when nothing else plausibly fits.

Include "Sales Tax". Categories:
${categoryList(cats)}`,

  // Add a per-item confidence field — not a constraint, just see if quality shifts
  "v25-confidence-tag": (cats) => `List every PURCHASED item with a category. Return JSON {lineItems: [{description, categoryId, confidence}]} where confidence is "high" | "medium" | "low".

Skip non-items (promos, coupons, tenders, subtotals). Prefer concrete categories over "Other". Mark confidence:low for truly ambiguous items.

Include "Sales Tax". Categories:
${categoryList(cats)}`,

  // Dedupe quantity multipliers ("2 AT 1 FOR $X" → one entry)
  "v26-dedupe-multi": (cats) => `List every PURCHASED item with a category. Return JSON {lineItems: [{description, categoryId}]}.

Skip non-items (promos, coupons, tenders, subtotals, "Regular Price" refs, "N AT 1 FOR $X" quantity lines — these are metadata on the item above).

Prefer concrete categories over "Other". Include "Sales Tax". Categories:
${categoryList(cats)}`,

  // Domain framing
  "v27-expert-framing": (cats) => `You are a household-budget expert categorizing a retail receipt for a family's monthly budget. Only list actual purchases — skip promo rewards, coupons, discounts, tenders, and subtotals.

For each purchased item, pick the single category that matches where the item belongs in a typical household budget. Prefer concrete categories (Groceries, Home Supplies, Health/Pharmacy, Clothes, Entertainment, Holidays, Kid's Stuff) over "Other".

Return JSON {lineItems: [{description, categoryId}]}. Include "Sales Tax". Categories:
${categoryList(cats)}`,

  // Minimal — just "skip non-items" added to v1
  "v28-minimal-delta": (cats) => `List every PURCHASED item on this receipt with a category. Skip promos, coupons, tenders, subtotals. Return JSON {lineItems: [{description, categoryId}]}. Include "Sales Tax". Categories:
${categoryList(cats)}`,

  // v15 + output constraint: require description to be <= N chars (forces focus on noun)
  "v29-short-desc": (cats) => `List every PURCHASED item with a category. Return JSON {lineItems: [{description, categoryId}]}.

Keep description short (≤30 chars); the product noun matters more than the full printed line. Skip promos, coupons, tenders, subtotals. Prefer concrete categories over "Other".

Include "Sales Tax". Categories:
${categoryList(cats)}`,
};

// ─── Round 4 — squeeze extras on top of v15 (100% recall, 4 extras) ──

const ROUND_4_VARIANTS = {
  // Control (same as Round 3's v15-control — variance check)
  "v15-control": (cats) => `List every PURCHASED item with a category. Return JSON {lineItems: [{description, categoryId}]}.

Rules:
  - Skip promos, coupons, discounts, tenders, subtotals.
  - Prefer a concrete category (Groceries, Home Supplies, Health/Pharmacy, Clothes, Entertainment, Holidays, Kid's Stuff, etc.) over "Other" (30426). Only use Other when no concrete category plausibly applies.

Include "Sales Tax". Categories:
${categoryList(cats)}`,

  // Re-run v15 to measure its run-to-run variance at temperature=0
  "v15-variance-check": (cats) => `List every PURCHASED item with a category. Return JSON {lineItems: [{description, categoryId}]}.

Rules:
  - Skip promos, coupons, discounts, tenders, subtotals.
  - Prefer a concrete category (Groceries, Home Supplies, Health/Pharmacy, Clothes, Entertainment, Holidays, Kid's Stuff, etc.) over "Other" (30426). Only use Other when no concrete category plausibly applies.

Include "Sales Tax". Categories:
${categoryList(cats)}`,

  // Stack the two best: v15 + v24's "avoid rare categories"
  "v30-v15+avoid-rare": (cats) => `List every PURCHASED item with a category. Return JSON {lineItems: [{description, categoryId}]}.

Rules:
  - Skip promos, coupons, discounts, tenders, subtotals.
  - Prefer a concrete consumer category (Groceries, Home Supplies, Health/Pharmacy, Clothes, Entertainment, Holidays, Kid's Stuff) over "Other".
  - Avoid these unless the item is unambiguously that type: Mortgage/Insurance/PropTax (42007), Insurance (36973), Transportation/Gas (48281 — only fuel/parking/transit), Electric/Gas (17132 — only utility bills), Phone/Internet/Computer (62776 — only service bills), Business, Employment, Farm, Charity.

Include "Sales Tax". Categories:
${categoryList(cats)}`,

  // Tight negative rule: kill the Restaurants overuse (SBUX / snack bars)
  "v31-no-restaurants-default": (cats) => `List every PURCHASED item with a category. Return JSON {lineItems: [{description, categoryId}]}.

Rules:
  - Skip promos, coupons, discounts, tenders, subtotals.
  - Packaged retail food items (coffee beans, K-cups, snack bars, frozen meals, branded food items sold in aisles) → 22695 Groceries, NOT Restaurants. Only assign 21716 Restaurants/Prepared Food to hot-deli meals / food-court items eaten on site.
  - Prefer concrete categories over "Other".

Include "Sales Tax". Categories:
${categoryList(cats)}`,

  // Ultra-minimal: what's the shortest prompt that still hits 100%?
  "v32-ultra-min": (cats) => `List every purchased item with categoryId. JSON {lineItems: [{description, categoryId}]}. Skip promos/coupons/tenders/subtotals. Prefer concrete categories over "Other" (30426). Add Sales Tax. IDs:
${categoryList(cats)}`,

  // Positive whitelist: "pick from these 8 consumer buckets only"
  "v33-concrete-whitelist": (cats) => `List every PURCHASED item with a category. Return JSON {lineItems: [{description, categoryId}]}.

Pick categoryId from this whitelist for typical retail receipts:
  1276 Kid's Stuff
  17351 Health/Pharmacy
  21716 Restaurants/Prepared Food (only hot-deli / food-court eaten on site)
  22695 Groceries
  30186 Home Supplies
  30426 Other (last-resort, only when nothing else fits)
  49552 Holidays/Birthdays
  52714 Clothes
  57937 Entertainment
Use other categoryIds (from the complete list below) only if the receipt is for that domain (utilities, insurance, mortgage, fuel, etc.).

Skip promos/coupons/tenders/subtotals. Include "Sales Tax". Complete list:
${categoryList(cats)}`,

  // JSON field reorder — categoryId first might affect decoding
  "v34-categoryid-first": (cats) => `List every PURCHASED item with a category. Return JSON {lineItems: [{categoryId, description}]}.

Rules:
  - Skip promos, coupons, tenders, subtotals.
  - Prefer concrete categories over "Other".

Include "Sales Tax". Categories:
${categoryList(cats)}`,

  // Two-pass in one call: instruct model to self-review
  "v35-self-review": (cats) => `List every PURCHASED item with a category. FIRST pass: enumerate items. SECOND pass (mental): review each item's categoryId — if an item feels like a stretch for its category, reconsider before emitting. Then output final JSON {lineItems: [{description, categoryId}]}.

Skip promos/coupons/tenders/subtotals. Prefer concrete categories over "Other". Include "Sales Tax". Categories:
${categoryList(cats)}`,

  // Family-budget reality framing (stronger than v27)
  "v36-family-budget": (cats) => `You are categorizing a receipt for a real family's monthly budget tracker. The family has these category buckets; they've never used Mortgage/Insurance/Electric/Phone/Business/Employment/Farm/Charity for retail-store receipts, only for dedicated bills. Map retail-store items to the consumer buckets (Groceries, Home Supplies, Health/Pharmacy, Clothes, Entertainment, Holidays, Kid's Stuff, Other).

Skip promos/coupons/tenders/subtotals. Prefer concrete over "Other". Return JSON {lineItems: [{description, categoryId}]}. Include "Sales Tax". Categories:
${categoryList(cats)}`,

  // Ambiguous items: force a guess rather than Other
  "v37-guess-dont-other": (cats) => `List every PURCHASED item with a category. Return JSON {lineItems: [{description, categoryId}]}.

Rules:
  - Skip promos, coupons, tenders, subtotals.
  - When an item is ambiguous, pick the MOST LIKELY concrete category based on context (section heading, neighbouring items, typical consumer intent). Only use "Other" (30426) if you genuinely cannot place it in any consumer bucket.

Include "Sales Tax". Categories:
${categoryList(cats)}`,

  // Combine v15 + v31 (no-restaurants) + v30 (avoid-rare) into one
  "v38-combined-guardrails": (cats) => `List every PURCHASED item with a category. Return JSON {lineItems: [{description, categoryId}]}.

Rules:
  - Skip promos, coupons, discounts, tenders, subtotals.
  - Packaged retail food (coffee beans, K-cups, snack bars, frozen meals) → 22695 Groceries, NOT Restaurants.
  - Avoid Mortgage/Insurance/Electric/Phone/Business/Farm/Charity unless the item is unambiguously that type.
  - Prefer concrete consumer categories (Groceries, Home Supplies, Health/Pharmacy, Clothes, Entertainment, Holidays, Kid's Stuff) over "Other".

Include "Sales Tax". Categories:
${categoryList(cats)}`,
};

const ROUND_BANK = {
  "1": ROUND_1_VARIANTS,
  "2": ROUND_2_VARIANTS,
  "3": ROUND_3_VARIANTS,
  "4": ROUND_4_VARIANTS,
};

// Round 2 introduces an optional schema override for v14 (enum categoryId)
function schemaForVariant(name, cats) {
  // Gemini's OpenAPI-subset JSON schema wants enum values as STRINGS, even
  // when the underlying type is integer. We declare categoryId as string-enum
  // and convert back to integer post-parse (see postProcess below).
  if (name === "v14-schema-enum" || name === "v20-enum-fixed") {
    const ids = enumCategoryIds(cats).map(String);
    return {
      type: "object",
      properties: {
        lineItems: {
          type: "array",
          items: {
            type: "object",
            properties: {
              description: { type: "string" },
              categoryId: { type: "string", enum: ids },
            },
            required: ["description", "categoryId"],
          },
        },
      },
      required: ["lineItems"],
    };
  }
  if (name === "v25-confidence-tag") {
    return {
      type: "object",
      properties: {
        lineItems: {
          type: "array",
          items: {
            type: "object",
            properties: {
              description: { type: "string" },
              categoryId: { type: "integer" },
              confidence: { type: "string", enum: ["high", "medium", "low"] },
            },
            required: ["description", "categoryId"],
          },
        },
      },
      required: ["lineItems"],
    };
  }
  return CALL2_SCHEMA;
}

// Normalize string categoryId → integer for the enum-schema variants so
// scoring code downstream doesn't need to special-case.
function normalizeItems(name, items) {
  if ((name === "v14-schema-enum" || name === "v20-enum-fixed") && Array.isArray(items)) {
    return items.map(it => ({
      ...it,
      categoryId: typeof it.categoryId === "string" ? parseInt(it.categoryId, 10) : it.categoryId,
    }));
  }
  return items;
}

// ═══════════════════════════════════════════════════════════════════

const client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

async function liteCall({ imageBytes, mimeType, prompt, schema }) {
  let lastErr;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await client.models.generateContent({
        model: LITE,
        contents: [{ role: "user", parts: [{ text: prompt }, { inlineData: { mimeType, data: imageBytes.toString("base64") } }] }],
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

function scoreCall2(items, label) {
  const expected = new Set((label.categoryAmounts || []).map(c => c.categoryId));
  const actual = new Set(items.map(it => it.categoryId).filter(Number.isFinite));
  const hits = [...expected].filter(id => actual.has(id)).length;
  const extras = [...actual].filter(id => !expected.has(id)).length;
  return {
    itemCount: items.length,
    expected: expected.size,
    actualDistinct: actual.size,
    recall: hits / expected.size,            // fraction of expected cats found
    extras,                                  // unexpected buckets
    actualCats: [...actual],
  };
}

async function runVariant(name, promptFn, cats) {
  const perReceipt = [];
  for (const file of RECEIPTS) {
    const imgPath = path.join(ROOT, "test-data", "images", file);
    const imageBytes = fs.readFileSync(imgPath);
    const mimeType = mimeFor(file);
    const label = labelByFile.get(file);
    try {
      const { parsed, tokens } = await liteCall({
        imageBytes, mimeType,
        prompt: promptFn(cats),
        schema: schemaForVariant(name, cats),
      });
      const items = normalizeItems(name, parsed.lineItems || []);
      const score = scoreCall2(items, label);
      perReceipt.push({
        file, ok: true,
        score,
        items,
        tokIn: tokens?.promptTokenCount || 0,
        tokOut: tokens?.candidatesTokenCount || 0,
      });
    } catch (e) {
      perReceipt.push({ file, ok: false, error: e.message });
    }
  }
  return { name, perReceipt };
}

(async () => {
  const roundArg = process.argv.indexOf("--round");
  const roundKey = roundArg >= 0 ? process.argv[roundArg + 1] : "1";
  const variants = ROUND_BANK[roundKey];
  if (!variants) {
    console.error(`No variant bank for round "${roundKey}". Available: ${Object.keys(ROUND_BANK).join(", ")}`);
    process.exit(1);
  }

  console.log(`═════ ROUND ${roundKey} — ${Object.keys(variants).length} variants × ${RECEIPTS.length} receipts ═════\n`);

  const results = [];
  for (const [name, fn] of Object.entries(variants)) {
    process.stdout.write(`▶ ${name.padEnd(26)}  `);
    const r = await runVariant(name, fn, TEST_CATEGORIES);
    results.push(r);
    const recalls = r.perReceipt.filter(p => p.ok).map(p => p.score.recall);
    const avgRecall = recalls.length ? recalls.reduce((s, x) => s + x, 0) / recalls.length : 0;
    const counts = r.perReceipt.filter(p => p.ok).map(p => p.score.itemCount);
    const failures = r.perReceipt.filter(p => !p.ok).length;
    console.log(`recall=${(avgRecall * 100).toFixed(0)}%  items=${counts.join("/")}  fails=${failures}`);
  }

  // ─── Summary table ───
  console.log("\n" + "═".repeat(90));
  console.log("SUMMARY — Call 2 prompt iteration, round " + roundKey);
  console.log("═".repeat(90));
  console.log(
    "variant".padEnd(26) +
    " | " + RECEIPTS.map(f => f.replace(".jpg", "").slice(0, 10).padEnd(11)).join(" | ") +
    " | avg-recall | avg-items"
  );
  console.log("─".repeat(90));
  for (const r of results) {
    const cols = r.perReceipt.map(p => {
      if (!p.ok) return "FAIL".padEnd(11);
      return `r=${(p.score.recall * 100).toFixed(0)}% i=${p.score.itemCount} x=${p.score.extras}`.padEnd(11);
    }).join(" | ");
    const recalls = r.perReceipt.filter(p => p.ok).map(p => p.score.recall);
    const avgR = recalls.length ? recalls.reduce((s, x) => s + x, 0) / recalls.length : 0;
    const counts = r.perReceipt.filter(p => p.ok).map(p => p.score.itemCount);
    const avgI = counts.length ? Math.round(counts.reduce((s, x) => s + x, 0) / counts.length) : 0;
    console.log(`${r.name.padEnd(26)} | ${cols} | ${(avgR * 100).toFixed(0).padStart(3)}%       | ${avgI}`);
  }

  // ─── Per-receipt: show top-variant items for manual sanity ───
  console.log("\n" + "═".repeat(90));
  console.log("PER-RECEIPT — items returned by each variant (truncated)");
  console.log("═".repeat(90));
  for (let i = 0; i < RECEIPTS.length; i++) {
    const receipt = RECEIPTS[i];
    const label = labelByFile.get(receipt);
    console.log(`\n### ${receipt}  expected cats=[${(label.categoryAmounts || []).map(c => `${c.categoryId}=${catName.get(c.categoryId)}`).join(", ")}]`);
    for (const r of results) {
      const p = r.perReceipt[i];
      if (!p.ok) { console.log(`  ${r.name.padEnd(26)} — FAIL: ${p.error}`); continue; }
      // Group by cat
      const byCat = new Map();
      for (const it of p.items) {
        const arr = byCat.get(it.categoryId) || [];
        arr.push(it.description);
        byCat.set(it.categoryId, arr);
      }
      const summary = [...byCat.entries()]
        .map(([cid, descs]) => `${String(catName.get(cid) || `id:${cid}`).slice(0, 8)}:${descs.length}`)
        .join(" ");
      console.log(`  ${r.name.padEnd(26)} ${p.score.itemCount} items — ${summary}`);
    }
  }

  const outPath = path.join(ROOT, "results", `lite-c2-iter-round${roundKey}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(results, null, 2));
  console.log(`\nSaved → ${path.relative(ROOT, outPath)}`);
})();
