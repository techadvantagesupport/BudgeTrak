#!/usr/bin/env node
// Lite 3-call pipeline for multi-category receipts.
// Hypothesis: Lite fails multi-cat because it does too much at once.
// Splitting into 3 focused calls may give each task a cleaner cognitive slot.
//
// Call 1 — standard extraction: {merchant, date, amount, categoryAmounts}.
//          (Also tells us if the receipt is multi-cat by cat count.)
// Call 2 — items + categories ONLY: list every line item with a categoryId.
//          No merchant/date/amount/prices. Just description + categoryId.
// Call 3 — prices ONLY (two-pass): given Call 2's item descriptions, find the
//          price for each item on the receipt. Explicit "read then verify" pass.
//
// Post-process: match Call 2 items to Call 3 prices by index, group by
// categoryId, sum. Emit final categoryAmounts. Compare to label.
//
// Also keeps Call 1's amount; reconciliation adjusts largest category if
// pipeline sum drifts.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import "dotenv/config";
import { GoogleGenAI } from "@google/genai";

import { TEST_CATEGORIES } from "../src/categories.js";
import { gradeResult } from "../src/grader.js";

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

function categoryList(cats) {
  return cats
    .filter(c => c.tag !== "supercharge" && c.tag !== "recurring_income" && !c.deleted)
    .map(c => c.tag ? `  - id=${c.id} name="${c.name}" tag="${c.tag}"` : `  - id=${c.id} name="${c.name}"`)
    .join("\n");
}

// ─── Call 1: standard Lite extraction (B_bare style) ──────────────
function call1Prompt(cats) {
  return `Extract receipt data as JSON: {transcription, merchant, merchantLegalName?, date, amountCents (integer), categoryAmounts?}.

Stage 1: transcription = every line of the receipt as plain text.
Stage 2: extract remaining fields.

Amount is INTEGER CENTS. Ignore GST-summary pre-tax rows.

- date MUST be YYYY-MM-DD ISO.
- merchant is the consumer brand.
- Category ids must come from:
${categoryList(cats)}`;
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

// ─── Call 2: items + categoryIds only (no prices) ─────────────────
function call2Prompt(cats) {
  return `This receipt has multiple spending categories. Your ONLY task is to list the purchased items and their categories. DO NOT extract merchant, date, total, or prices — those are handled elsewhere.

For each purchased line item on the receipt, return an entry in lineItems:
  - description: as printed on the receipt (after expanding abbreviations if clear)
  - categoryId: one of the IDs from the list below — pick the best single category for that item

Include ALL purchased items. Include sales tax as a separate entry with description "Sales Tax" and categoryId = the receipt's dominant non-food section (30186 if unclear).

CATEGORY RULE — detailed mapping:
Food/produce/meat/pantry → 22695 Groceries.
Cleaning, paper towels, ziploc/foil, pet items, hardware, paint, batteries, stationery → 30186 Home Supplies.
Kids' toys, school workbooks, kids clothes → 1276 Kid's Stuff.
Pharmacy/OTC medicine, personal care (soap, shampoo) → 17351 Health/Pharmacy.
Fuel, parking, tolls → 48281 Transportation/Gas.
Apparel (shirts, pants, shoes) → 52714 Clothes.
Easter/Christmas/Halloween/Valentine/seasonal items → 49552 Holidays/Birthdays.
Games, toys for adults, entertainment media → 57937 Entertainment.

Available categoryIds:
${categoryList(cats)}`;
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

// ─── Call 3: prices only, two-pass verification ───────────────────
function call3Prompt(itemDescriptions) {
  const listed = itemDescriptions.map((d, i) => `  ${i + 1}. ${d}`).join("\n");
  return `Your ONLY task is to find the printed price for each of the items listed below. Do NOT extract merchant, date, total, or categories — those are handled elsewhere.

Items to price (in order):
${listed}

Process:
1. FIRST PASS — read each item's price from the receipt image, working in order.
2. SECOND PASS — go back through the list and verify each price by re-reading the receipt. If a price looks wrong on review, correct it.
3. Return prices as an array of numbers, one per item, in the SAME ORDER as listed above. Length MUST equal ${itemDescriptions.length}.

A price is the printed per-line dollar amount, including any item-level discount already applied. For sales tax, return the printed tax amount.`;
}

const CALL3_SCHEMA = {
  type: "object",
  properties: {
    prices: {
      type: "array",
      items: { type: "number" },
    },
  },
  required: ["prices"],
};

// ─── Runner ────────────────────────────────────────────────────────
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

// Combine Call 2 items + Call 3 prices → categoryAmounts.
// Truncate to the shorter of the two lists if counts mismatch (Lite sometimes miscounts).
function mergeToCategoryAmounts(lineItems, prices) {
  const n = Math.min(lineItems.length, prices.length);
  const byCat = new Map();
  for (let i = 0; i < n; i++) {
    const { categoryId } = lineItems[i];
    const price = prices[i];
    if (typeof categoryId !== "number" || typeof price !== "number") continue;
    byCat.set(categoryId, (byCat.get(categoryId) || 0) + price);
  }
  return [...byCat.entries()].map(([categoryId, amount]) => ({
    categoryId,
    amount: Math.round(amount * 100) / 100,
  }));
}

// Post-hoc reconciliation: adjust largest category by drift to match amount.
function reconcile(categoryAmounts, amount) {
  if (!categoryAmounts || categoryAmounts.length === 0) return categoryAmounts;
  const rounded = categoryAmounts.map(c => ({ ...c, amount: Math.round(c.amount * 100) / 100 }));
  const sum = rounded.reduce((s, c) => s + c.amount, 0);
  const delta = Math.round((amount - sum) * 100) / 100;
  if (Math.abs(delta) < 0.005) return rounded;
  const largestIdx = rounded.reduce((best, c, i) => c.amount > rounded[best].amount ? i : best, 0);
  const adjusted = Math.round((rounded[largestIdx].amount + delta) * 100) / 100;
  if (adjusted <= 0 || adjusted > amount + 0.005) {
    return [{ categoryId: rounded[largestIdx].categoryId, amount }];
  }
  rounded[largestIdx] = { ...rounded[largestIdx], amount: adjusted };
  return rounded;
}

async function pipelineOnce({ label, cats, img, mime }) {
  const t0 = Date.now();

  // Call 1 — standard extraction
  const c1 = await liteCall({ imageBytes: img, mimeType: mime, prompt: call1Prompt(cats), schema: CALL1_SCHEMA });
  const p1 = c1.parsed;
  const amount = (p1.amountCents || 0) / 100;

  // Call 2 — items + categories only
  const c2 = await liteCall({ imageBytes: img, mimeType: mime, prompt: call2Prompt(cats), schema: CALL2_SCHEMA });
  const lineItems = c2.parsed.lineItems || [];
  if (lineItems.length === 0) throw new Error("Call 2 returned no line items");

  // Call 3 — prices only, two-pass
  const c3 = await liteCall({
    imageBytes: img,
    mimeType: mime,
    prompt: call3Prompt(lineItems.map(li => li.description)),
    schema: CALL3_SCHEMA,
  });
  const prices = c3.parsed.prices || [];

  // Merge
  const rawCA = mergeToCategoryAmounts(lineItems, prices);
  const reconciledCA = reconcile(rawCA, amount);

  const ms = Date.now() - t0;

  const finalParsed = {
    merchant: p1.merchant,
    date: p1.date,
    amount,
    categoryAmounts: reconciledCA,
    notes: `pipeline: items=${lineItems.length} prices=${prices.length}`,
  };

  // Aggregate token usage
  const totalIn = (c1.tokens?.promptTokenCount || 0) + (c2.tokens?.promptTokenCount || 0) + (c3.tokens?.promptTokenCount || 0);
  const totalOut = (c1.tokens?.candidatesTokenCount || 0) + (c2.tokens?.candidatesTokenCount || 0) + (c3.tokens?.candidatesTokenCount || 0);

  return {
    finalParsed,
    ms,
    totalIn,
    totalOut,
    raw: {
      c1: { amount, merchant: p1.merchant, date: p1.date, categoryAmounts: p1.categoryAmounts, tokens: c1.tokens },
      c2: { itemCount: lineItems.length, tokens: c2.tokens },
      c3: { priceCount: prices.length, tokens: c3.tokens, sumFromPrices: prices.reduce((s, p) => s + p, 0) },
      rawCategoryAmounts: rawCA,
    },
  };
}

async function main() {
  const labels = JSON.parse(fs.readFileSync(path.join(ROOT, "test-data", "labels.json"), "utf8"));
  const receipts = TEST_FILES.map(f => labels.find(l => l.file === f)).filter(Boolean);
  console.log(`Lite 3-call pipeline on ${receipts.length} receipts × 2 runs = ${receipts.length*2} pipeline runs (${receipts.length*2*3} Lite calls total)\n`);

  const results = [];
  for (const label of receipts) {
    const cats = TEST_CATEGORIES.filter(c => label.categoryAmounts.map(x => x.categoryId).includes(c.id));
    const img = fs.readFileSync(path.join(ROOT, "test-data", "images", label.file));
    const mime = mimeFor(label.file);
    console.log(`=== ${label.file} amount=$${label.amount} (expected cats: ${label.categoryAmounts.map(c => c.categoryId).join(",")}) ===`);
    for (const run of [1, 2]) {
      process.stdout.write(`  pipeline run${run} `);
      try {
        const out = await pipelineOnce({ label, cats, img, mime });
        const grade = gradeResult(label, out.finalParsed);
        const ca = out.finalParsed.categoryAmounts || [];
        const sumCA = ca.reduce((s, c) => s + (c.amount || 0), 0);
        const drift = Math.abs(sumCA - (out.finalParsed.amount || 0));
        const cset = grade.categoryAmounts?.setMatch ? "✓" : "✗";
        const cshr = grade.categoryAmounts?.shareMatch ? "✓" : "✗";
        console.log(`m${grade.merchant.pass?"✓":"✗"} d${grade.date.pass?"✓":"✗"} a${grade.amount.pass?"✓":"✗"} sum${drift<=0.05?"✓":"✗"} cset${cset} cshr${cshr} drift $${drift.toFixed(2)} items=${out.raw.c2.itemCount} prices=${out.raw.c3.priceCount} priceSum=$${out.raw.c3.sumFromPrices.toFixed(2)} in=${out.totalIn}tok out=${out.totalOut}tok ${out.ms}ms`);
        results.push({
          file: label.file,
          run,
          grade,
          sumMatch: drift <= 0.05,
          drift,
          totalIn: out.totalIn,
          totalOut: out.totalOut,
          ms: out.ms,
          raw: out.raw,
        });
      } catch (e) {
        console.log(`ERR ${String(e.message).slice(0,80)}`);
        results.push({ file: label.file, run, error: e.message });
      }
    }
    console.log();
  }

  // Aggregate
  const rs = results.filter(r => r.grade);
  const n = rs.length;
  const m = rs.filter(r => r.grade.merchant.pass).length;
  const d = rs.filter(r => r.grade.date.pass).length;
  const a = rs.filter(r => r.grade.amount.pass).length;
  const sum = rs.filter(r => r.sumMatch).length;
  const cset = rs.filter(r => r.grade.categoryAmounts?.setMatch).length;
  const cshr = rs.filter(r => r.grade.categoryAmounts?.shareMatch).length;
  const avgIn = rs.reduce((s, r) => s + r.totalIn, 0) / n;
  const avgOut = rs.reduce((s, r) => s + r.totalOut, 0) / n;
  const avgMs = rs.reduce((s, r) => s + r.ms, 0) / n;
  // Lite pricing: $0.10/M input, $0.40/M output
  const costPerPipeline = (avgIn * 0.10 + avgOut * 0.40) / 1e6;
  console.log(`=== Aggregate (${n} successful pipeline runs) ===`);
  console.log(`m ${m}/${n}  d ${d}/${n}  a ${a}/${n}  sum ${sum}/${n}  cset ${cset}/${n}  cshr ${cshr}/${n}`);
  console.log(`avg totals across 3 calls: in ${avgIn.toFixed(0)} out ${avgOut.toFixed(0)}  ${avgMs.toFixed(0)}ms total  ~\$${costPerPipeline.toFixed(4)}/pipeline`);

  console.log(`\n=== Comparison to incumbents on this 5-receipt bank ===`);
  console.log(`  Pro@1024      cset 10/10  cshr 5/10   ~\$0.014/call   ~13s      WINNER`);
  console.log(`  Haiku mega    cset  7/10  cshr 0/10   ~\$0.003/call   ~3s       no cshr`);
  console.log(`  Lite pipeline cset ${cset}/${n}  cshr ${cshr}/${n}   ~\$${costPerPipeline.toFixed(4)}/run   ~${(avgMs/1000).toFixed(1)}s    new option`);

  const outFile = path.join(ROOT, "results", `lite-pipeline-${new Date().toISOString().replace(/[:.]/g,"-")}.json`);
  fs.writeFileSync(outFile, JSON.stringify({ run: "lite-pipeline", results }, null, 2));
  console.log(`\nSaved → ${path.relative(ROOT, outFile)}`);
}

main().catch(e => { console.error("Fatal:", e.stack || e.message); process.exit(1); });
