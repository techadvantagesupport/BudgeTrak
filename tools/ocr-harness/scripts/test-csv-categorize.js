#!/usr/bin/env node
// Accuracy test for AI CSV categorization (Flash-Lite text-only).
// 50 unique USA retailers with labeled categories — single batch call,
// report per-category accuracy and confusions.

import "dotenv/config";
import { GoogleGenAI } from "@google/genai";
import { TEST_CATEGORIES } from "../src/categories.js";

const LITE = "gemini-2.5-flash-lite";
const client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// 50 labeled USA retailers. Amounts chosen to reflect realistic spend at each.
// Where amount is meaningful for disambiguation (gas-station snack vs. pump),
// the amount nudges toward the intended category.
const TEST_SET = [
  // Groceries (8)
  { i:  1, merchant: "Whole Foods Market",     amount: 124.87, date: "2026-04-02", expected: 22695 },
  { i:  2, merchant: "Trader Joe's",           amount:  62.14, date: "2026-04-05", expected: 22695 },
  { i:  3, merchant: "Kroger",                 amount:  89.42, date: "2026-04-07", expected: 22695 },
  { i:  4, merchant: "Safeway",                amount:  76.50, date: "2026-04-09", expected: 22695 },
  { i:  5, merchant: "Publix",                 amount:  98.33, date: "2026-04-11", expected: 22695 },
  { i:  6, merchant: "H-E-B",                  amount: 112.77, date: "2026-04-12", expected: 22695 },
  { i:  7, merchant: "Aldi",                   amount:  54.21, date: "2026-04-03", expected: 22695 },
  { i:  8, merchant: "Costco Wholesale",       amount: 287.65, date: "2026-04-06", expected: 22695 },

  // Restaurants / Prepared Food (8)
  { i:  9, merchant: "Starbucks",              amount:   6.75, date: "2026-04-01", expected: 21716 },
  { i: 10, merchant: "Dunkin'",                amount:   5.40, date: "2026-04-02", expected: 21716 },
  { i: 11, merchant: "McDonald's",             amount:  12.65, date: "2026-04-03", expected: 21716 },
  { i: 12, merchant: "Chipotle",               amount:  14.20, date: "2026-04-04", expected: 21716 },
  { i: 13, merchant: "Chick-fil-A",            amount:  11.45, date: "2026-04-05", expected: 21716 },
  { i: 14, merchant: "Olive Garden",           amount:  67.30, date: "2026-04-06", expected: 21716 },
  { i: 15, merchant: "DoorDash",               amount:  32.50, date: "2026-04-07", expected: 21716 },
  { i: 16, merchant: "Domino's Pizza",         amount:  28.90, date: "2026-04-08", expected: 21716 },

  // Transportation / Gas (5)
  { i: 17, merchant: "Shell",                  amount:  48.23, date: "2026-04-01", expected: 48281 },
  { i: 18, merchant: "Chevron",                amount:  52.10, date: "2026-04-02", expected: 48281 },
  { i: 19, merchant: "ExxonMobil",             amount:  41.87, date: "2026-04-03", expected: 48281 },
  { i: 20, merchant: "BP",                     amount:  56.33, date: "2026-04-04", expected: 48281 },
  { i: 21, merchant: "Uber",                   amount:  24.50, date: "2026-04-05", expected: 48281 },

  // Health / Pharmacy (4)
  { i: 22, merchant: "CVS Pharmacy",           amount:  23.15, date: "2026-04-01", expected: 17351 },
  { i: 23, merchant: "Walgreens",              amount:  18.90, date: "2026-04-02", expected: 17351 },
  { i: 24, merchant: "Rite Aid",               amount:  15.65, date: "2026-04-03", expected: 17351 },
  { i: 25, merchant: "GoodRx",                 amount:  12.40, date: "2026-04-04", expected: 17351 },

  // Home Supplies (4)
  { i: 26, merchant: "The Home Depot",         amount: 127.43, date: "2026-04-01", expected: 30186 },
  { i: 27, merchant: "Lowe's",                 amount:  89.76, date: "2026-04-02", expected: 30186 },
  { i: 28, merchant: "Ace Hardware",           amount:  34.21, date: "2026-04-03", expected: 30186 },
  { i: 29, merchant: "Bed Bath & Beyond",      amount:  56.70, date: "2026-04-04", expected: 30186 },

  // Phone / Internet / Computer (5)
  { i: 30, merchant: "Best Buy",               amount: 459.99, date: "2026-04-01", expected: 62776 },
  { i: 31, merchant: "Apple Store",            amount:1299.00, date: "2026-04-02", expected: 62776 },
  { i: 32, merchant: "Verizon Wireless",       amount:  85.00, date: "2026-04-03", expected: 62776 },
  { i: 33, merchant: "AT&T",                   amount: 120.00, date: "2026-04-04", expected: 62776 },
  { i: 34, merchant: "Comcast Xfinity",        amount:  95.50, date: "2026-04-05", expected: 62776 },

  // Entertainment (5)
  { i: 35, merchant: "Netflix",                amount:  15.49, date: "2026-04-01", expected: 57937 },
  { i: 36, merchant: "Spotify",                amount:  10.99, date: "2026-04-02", expected: 57937 },
  { i: 37, merchant: "Hulu",                   amount:  12.99, date: "2026-04-03", expected: 57937 },
  { i: 38, merchant: "AMC Theatres",           amount:  18.50, date: "2026-04-04", expected: 57937 },
  { i: 39, merchant: "GameStop",               amount:  59.99, date: "2026-04-05", expected: 57937 },

  // Clothes (5)
  { i: 40, merchant: "Nike",                   amount:  89.00, date: "2026-04-01", expected: 52714 },
  { i: 41, merchant: "Old Navy",               amount:  45.60, date: "2026-04-02", expected: 52714 },
  { i: 42, merchant: "Gap",                    amount:  72.30, date: "2026-04-03", expected: 52714 },
  { i: 43, merchant: "Macy's",                 amount: 134.80, date: "2026-04-04", expected: 52714 },
  { i: 44, merchant: "Nordstrom",              amount: 187.45, date: "2026-04-05", expected: 52714 },

  // Kid's Stuff (2)
  { i: 45, merchant: "The Children's Place",   amount:  49.99, date: "2026-04-01", expected: 1276 },
  { i: 46, merchant: "Build-A-Bear Workshop",  amount:  34.50, date: "2026-04-02", expected: 1276 },

  // Insurance (2)
  { i: 47, merchant: "State Farm",             amount: 134.00, date: "2026-04-01", expected: 36973 },
  { i: 48, merchant: "Geico",                  amount:  98.50, date: "2026-04-02", expected: 36973 },

  // Charity (1)
  { i: 49, merchant: "American Red Cross",     amount:  50.00, date: "2026-04-01", expected: 35856 },

  // Farm (1)
  { i: 50, merchant: "Tractor Supply Co",      amount:  87.50, date: "2026-04-01", expected: 50371 },
];

const categoriesForPrompt = TEST_CATEGORIES
  .map(c => `  - id=${c.id} name="${c.name}"${c.tag ? ` tag="${c.tag}"` : ""}`)
  .join("\n");

const SYSTEM_INSTRUCTION = `You are a transaction categorizer for a personal-finance app. Given a list of bank transactions (merchant, amount, date) and the user's categories, assign each transaction to the single best-matching category id.

Key guidance:
- Consider amount as a disambiguator. Examples: a small amount at a gas station often means food/snacks; a larger amount at the same gas station usually means fuel.
- "Electric/Gas" means utility gas/electric bills. "Transportation/Gas" means vehicle fuel and rides.
- Return category id 30426 (Other) only when no category clearly fits.

User's categories:
${categoriesForPrompt}

Return valid JSON matching the response schema.`;

const SCHEMA = {
  type: "object",
  properties: {
    results: {
      type: "array",
      items: {
        type: "object",
        properties: {
          i: { type: "integer" },
          categoryId: { type: "integer" },
        },
        required: ["i", "categoryId"],
      },
    },
  },
  required: ["results"],
};

const userPayload = JSON.stringify({
  transactions: TEST_SET.map(t => ({ i: t.i, merchant: t.merchant, amount: t.amount, date: t.date })),
}, null, 2);

async function run() {
  console.log(`Running Flash-Lite on ${TEST_SET.length} labeled retailers...\n`);
  const t0 = Date.now();
  let res;
  try {
    res = await client.models.generateContent({
      model: LITE,
      contents: [{ role: "user", parts: [{ text: SYSTEM_INSTRUCTION + "\n\nTransactions to categorize:\n" + userPayload }] }],
      config: { responseMimeType: "application/json", responseSchema: SCHEMA, temperature: 0 },
    });
  } catch (e) {
    console.error("API error:", e.message || e);
    process.exit(1);
  }
  const elapsed = ((Date.now() - t0) / 1000).toFixed(2);
  const usage = res.usageMetadata || {};

  let parsed;
  try {
    parsed = JSON.parse(res.text);
  } catch (e) {
    console.error("JSON parse error. Raw response:\n", res.text);
    process.exit(1);
  }

  const byIndex = new Map(parsed.results.map(r => [r.i, r.categoryId]));
  const catName = new Map(TEST_CATEGORIES.map(c => [c.id, c.name]));

  let correct = 0;
  const confusions = [];
  const perCategory = new Map();

  for (const t of TEST_SET) {
    const got = byIndex.get(t.i);
    const isCorrect = got === t.expected;
    if (isCorrect) correct++;
    else confusions.push({ merchant: t.merchant, amount: t.amount, expected: t.expected, got });

    const bucket = perCategory.get(t.expected) || { total: 0, hit: 0 };
    bucket.total += 1;
    if (isCorrect) bucket.hit += 1;
    perCategory.set(t.expected, bucket);
  }

  const overall = (100 * correct / TEST_SET.length).toFixed(1);

  console.log(`--- Results ---`);
  console.log(`Overall: ${correct}/${TEST_SET.length} = ${overall}%`);
  console.log(`Elapsed: ${elapsed}s`);
  if (usage.promptTokenCount !== undefined) {
    console.log(`Tokens: input=${usage.promptTokenCount}  output=${usage.candidatesTokenCount}  total=${usage.totalTokenCount}`);
    const inCost = (usage.promptTokenCount / 1e6) * 0.10;
    const outCost = (usage.candidatesTokenCount / 1e6) * 0.40;
    console.log(`Cost: $${(inCost + outCost).toFixed(6)}`);
  }

  console.log(`\n--- Per-category breakdown ---`);
  const sorted = [...perCategory.entries()].sort((a, b) => (b[1].hit / b[1].total) - (a[1].hit / a[1].total));
  for (const [catId, b] of sorted) {
    const pct = (100 * b.hit / b.total).toFixed(0).padStart(3);
    console.log(`  ${pct}%  ${b.hit}/${b.total}  ${catName.get(catId)} (${catId})`);
  }

  if (confusions.length > 0) {
    console.log(`\n--- Misclassifications (${confusions.length}) ---`);
    for (const c of confusions) {
      console.log(`  ${c.merchant.padEnd(26)} $${c.amount.toFixed(2).padStart(8)}  expected="${catName.get(c.expected)}" (${c.expected})  got="${catName.get(c.got) || "UNKNOWN"}" (${c.got})`);
    }
  }
}

run().catch(e => {
  console.error(e);
  process.exit(1);
});
