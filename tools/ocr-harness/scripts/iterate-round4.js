#!/usr/bin/env node
// Round 4 — 10 category-focused prompt additions tested on BOTH Flash (v0.4)
// and Lite (R11) bases. Subset: the 10 hardest English receipts for category
// (all 5 multi-category + 5 single-category disagreements between models).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import "dotenv/config";
import { GoogleGenAI } from "@google/genai";

import { TEST_CATEGORIES } from "../src/categories.js";
import { gradeResult } from "../src/grader.js";
import { buildPrompt } from "../src/prompt.js";

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), "..");
const LITE = "gemini-2.5-flash-lite";
const FLASH = "gemini-2.5-flash";

const SUBSET = [
  // 5 multi-category
  "target.jpg", "sams_club.jpg", "sroie_0024.jpg", "sroie_0070.jpg", "sroie_0096.jpg",
  // 5 hard single-category
  "sroie_0004.jpg", "sroie_0038.jpg", "sroie_0072.jpg", "sroie_0084.jpg", "sroie_0100.jpg",
];

const categoryList = TEST_CATEGORIES
  .map(c => c.tag ? `  - id=${c.id} name="${c.name}" tag="${c.tag}"` : `  - id=${c.id} name="${c.name}"`)
  .join("\n");

// ── Flash base (v0.4) ──
const FLASH_BASE = buildPrompt(TEST_CATEGORIES);

// ── Lite base (R11: integer cents + transcribe) ──
const LITE_COMMON = `- date MUST be YYYY-MM-DD ISO (never the original format). Parse DD/MM for non-US, MM/DD for US, then reformat.
- merchant is the consumer brand. Preserve original language.
- merchantLegalName is optional (legal entity if distinct).
- Do NOT return a cashier/customer personal name as merchant.
- Category ids must come from:
${categoryList}`;

const LITE_BASE = `Extract receipt data as JSON: {transcription, merchant, merchantLegalName?, date, amountCents (integer), categoryAmounts?}.

Stage 1 — transcription: plain-text transcription of every line on the receipt.
Stage 2 — extract: fill remaining fields from your transcription.

Amount is INTEGER CENTS. Examples: "5.35" → 535. "169.78" → 16978. Ignore GST-summary pre-tax rows.

${LITE_COMMON}`;

// ── 10 category-focused additions ──
const CAT_ADDITIONS = [
  ["C1 consolidate",           `\n\nCATEGORY RULE — consolidation:\nReturn ONE entry per distinct categoryId in the categoryAmounts array, with the summed amount. Do NOT return one entry per line item. If 20 line items are all Groceries, return a single {categoryId: 22695, amount: <sum>} entry — not 20 entries.`],

  ["C2 merchant-type default", `\n\nCATEGORY RULE — start with merchant type:\nBefore splitting, identify the merchant type from the header and address (supermarket, warehouse, restaurant, gas station, pharmacy, hardware store, stationery/bookstore, general retail). The merchant type implies a default category for items. Supermarket/warehouse → Groceries default; restaurant → Restaurants/Prepared Food; hardware → Home Supplies; etc. Split into multiple categories ONLY when specific items clearly fall outside the default (e.g., non-food items at a supermarket).`],

  ["C3 itemize-then-consolidate", `\n\nCATEGORY RULE — itemize first, consolidate second:\nStep 1: For each purchased line item, mentally assign {description, price, categoryId}. Step 2: Group all line items by categoryId. Step 3: Sum each group's prices. Step 4: Return one categoryAmounts entry per distinct categoryId, summed. The sum across all entries must equal the receipt total.`],

  ["C4 tax-column hint",       `\n\nCATEGORY RULE — use tax markers:\nMany receipts mark each line item with tax codes (T, F, N, S, O, etc.). These often distinguish taxable non-food items (T) from non-taxed food (N or F). Use tax markers as hints: food-coded items typically group into Groceries (22695); taxed non-food items often group into Home Supplies (30186) or Other (30426). Do not rely on this alone — use alongside item descriptions.`],

  ["C5 min-split threshold",   `\n\nCATEGORY RULE — minimum split threshold:\nOnly create a separate categoryAmounts entry if that category represents AT LEAST $5 OR 10% of the total — whichever is smaller. Items below that threshold should be merged into the dominant category for the receipt. This prevents fragmenting a large supermarket receipt into 15 tiny entries.`],

  ["C6 category walkthrough",  `\n\nCATEGORY RULE — detailed walkthrough:\nFood, produce, meat, pantry → 22695 Groceries (even at warehouse stores).\nBeverages from a cafe/restaurant → 21716 Restaurants/Prepared Food. Bottled drinks from a supermarket → 22695.\nCleaning supplies, paper towels, ziploc/foil, pet items → 30186 Home Supplies.\nBatteries, stationery, pens, paper, office supplies → 30426 Other.\nChildren's toys, school workbooks/textbooks, kids clothes → 1276 Kid's Stuff.\nPharmacy items, OTC medicine, bandages → 17351 Health/Pharmacy.\nFuel, parking, tolls → 48281 Transportation/Gas.\nWork-specific items like safety shoes, uniforms → 47837 Employment Expenses.\nHardware, electrical, lighting, paint → 30186 Home Supplies.`],

  ["C7 store-type defaults",   `\n\nCATEGORY RULE — store-type default:\nApply the merchant type's natural category first, then split only for clear exceptions. Examples:\n- Supermarket / grocery mart / warehouse store → default Groceries. Split: non-food items get their own categories.\n- Restaurant / cafe / food court → default Restaurants/Prepared Food. Rarely split.\n- Gas station (with fuel purchase) → default Transportation/Gas. Split: in-store snacks → Groceries.\n- Pharmacy → default Health/Pharmacy. Split: non-medicine personal care → Home Supplies.\n- Hardware / electrical / lighting → default Home Supplies.\n- Stationery / bookstore (adult) → default Other. Split: kids school supplies → Kid's Stuff.\n- General retail (Target, Walmart) → no default; split by item type.`],

  ["C8 balance check",         `\n\nCATEGORY RULE — sum verification:\nThe sum of categoryAmounts MUST equal amount to within $0.02. Before finalizing your response, compute the sum of your categoryAmounts entries. If it doesn't match amount, adjust. For single-category receipts, categoryAmounts is one entry with amount equal to the total.`],

  ["C9 few-shot splits",       `\n\nCATEGORY RULE — examples of correct multi-category splits:\nExample 1 (Target receipt): BUBBL'R $6.20, Lean Cuisine $3.59, Milk $6.38 (groceries); Dog Treats $7.99, Dog Toy $16.99 (household/pet); tax $2.30. Total $43.45. Correct split: [{categoryId: 22695, amount: 16.63}, {categoryId: 30186, amount: 26.82}].\nExample 2 (Sam's Club): Most items are groceries, but batteries, ziploc bags, and shampoo are separate categories. Three-way split: Groceries (bulk of items), Home Supplies (ziploc, shampoo), Other (batteries).\nExample 3 (supermarket single-bucket): All food items → single entry {categoryId: 22695, amount: <total>}. Do not fragment.`],

  ["C10 grouping-by-intent",   `\n\nCATEGORY RULE — group by purchase intent:\nAsk yourself: what was the shopper's primary intent in this trip? Grocery run, restaurant meal, home improvement, quick gas, pharmacy visit? A grocery run is mostly Groceries even if it includes one bottle of cleaner. Don't over-split — a few line items from a secondary category don't warrant their own bucket unless they clearly form a distinct spending intent (e.g., Target's "food + pet supplies" is two genuine intents; Sam's Club's "groceries + one ziploc box" is one intent with a minor extra).`],
];

// ── Gemini call ──
const client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const FLASH_SCHEMA = {
  type: "object",
  properties: {
    merchant: { type: "string" }, merchantLegalName: { type: "string" },
    date: { type: "string" }, amount: { type: "number" },
    categoryAmounts: { type: "array", items: { type: "object", properties: { categoryId: { type: "integer" }, amount: { type: "number" } }, required: ["categoryId", "amount"] } },
    lineItems: { type: "array", items: { type: "string" } }, notes: { type: "string" },
  },
  required: ["merchant", "date", "amount"],
};

const LITE_SCHEMA = {
  type: "object",
  properties: {
    transcription: { type: "string" },
    merchant: { type: "string" }, merchantLegalName: { type: "string" },
    date: { type: "string" }, amountCents: { type: "integer" },
    categoryAmounts: { type: "array", items: { type: "object", properties: { categoryId: { type: "integer" }, amount: { type: "number" } }, required: ["categoryId", "amount"] } },
    lineItems: { type: "array", items: { type: "string" } }, notes: { type: "string" },
  },
  required: ["transcription", "merchant", "date", "amountCents"],
};

async function call({ model, imageBytes, mimeType, prompt, schema }) {
  let lastErr;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await client.models.generateContent({
        model,
        contents: [{ role: "user", parts: [{ text: prompt }, { inlineData: { mimeType, data: imageBytes.toString("base64") } }] }],
        config: { responseMimeType: "application/json", responseSchema: schema, temperature: 0 },
      });
      try {
        const parsed = JSON.parse(res.text);
        if (model === LITE && typeof parsed.amountCents === "number") parsed.amount = parsed.amountCents / 100;
        return { ok: true, parsed };
      }
      catch (e) { return { ok: false, error: e.message, raw: res.text }; }
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

async function runTestOnModel(testAdd, labels, model, basePrompt, schema) {
  const prompt = basePrompt + testAdd;
  const stats = { m: 0, d: 0, a: 0, cs: 0, csh: 0, mcs: 0, mcsh: 0, total: 0, multiTotal: 0, perReceipt: [] };
  for (const label of labels) {
    const imgPath = path.join(ROOT, "test-data", "images", label.file);
    const imageBytes = fs.readFileSync(imgPath);
    const mimeType = mimeFor(label.file);
    let extracted;
    try { extracted = (await call({ model, imageBytes, mimeType, prompt, schema })).parsed; }
    catch (e) { console.log(`    [err ${label.file}] ${e.message.slice(0,50)}`); continue; }
    if (!extracted) continue;
    const grade = gradeResult(label, extracted);
    stats.total++;
    if (grade.merchant.pass) stats.m++;
    if (grade.date.pass) stats.d++;
    if (grade.amount.pass) stats.a++;
    const ca = grade.categoryAmounts;
    if (ca && !ca.skipped) {
      if (ca.setMatch) stats.cs++;
      if (ca.shareMatch) stats.csh++;
      if (ca.expected && ca.expected.length > 1) {
        stats.multiTotal++;
        if (ca.setMatch) stats.mcs++;
        if (ca.shareMatch) stats.mcsh++;
      }
    }
    stats.perReceipt.push({ file: label.file, grade, extracted });
  }
  return stats;
}

async function main() {
  const labels = JSON.parse(fs.readFileSync(path.join(ROOT, "test-data", "labels.json"), "utf8"));
  const subset = SUBSET.map(f => labels.find(l => l.file === f)).filter(Boolean);
  console.log(`Round 4 — category-focused iteration\nSubset: ${subset.length} receipts (${subset.filter(l=>l.categoryAmounts?.length>1).length} multi-category, ${subset.filter(l=>l.categoryAmounts?.length===1).length} hard single)\n`);

  // Baselines
  console.log(`Baselines (no category additions):`);
  const liteBaseStats = await runTestOnModel("", subset, LITE, LITE_BASE, LITE_SCHEMA);
  console.log(`  LITE R11        m ${liteBaseStats.m}/${liteBaseStats.total}  d ${liteBaseStats.d}/${liteBaseStats.total}  a ${liteBaseStats.a}/${liteBaseStats.total}  cset ${liteBaseStats.cs}/${liteBaseStats.total}  cshare ${liteBaseStats.csh}/${liteBaseStats.total}  multi-set ${liteBaseStats.mcs}/${liteBaseStats.multiTotal}  multi-share ${liteBaseStats.mcsh}/${liteBaseStats.multiTotal}`);
  const flashBaseStats = await runTestOnModel("", subset, FLASH, FLASH_BASE, FLASH_SCHEMA);
  console.log(`  FLASH v0.4      m ${flashBaseStats.m}/${flashBaseStats.total}  d ${flashBaseStats.d}/${flashBaseStats.total}  a ${flashBaseStats.a}/${flashBaseStats.total}  cset ${flashBaseStats.cs}/${flashBaseStats.total}  cshare ${flashBaseStats.csh}/${flashBaseStats.total}  multi-set ${flashBaseStats.mcs}/${flashBaseStats.multiTotal}  multi-share ${flashBaseStats.mcsh}/${flashBaseStats.multiTotal}`);

  const results = [];
  console.log();
  for (const [name, addition] of CAT_ADDITIONS) {
    process.stdout.write(`${name.padEnd(32)}  `);
    const lite = await runTestOnModel(addition, subset, LITE, LITE_BASE, LITE_SCHEMA);
    const flash = await runTestOnModel(addition, subset, FLASH, FLASH_BASE, FLASH_SCHEMA);
    console.log(`LITE m${lite.m} d${lite.d} a${lite.a} cset${lite.cs} cshr${lite.csh} mset${lite.mcs} mshr${lite.mcsh}  |  FLASH m${flash.m} d${flash.d} a${flash.a} cset${flash.cs} cshr${flash.csh} mset${flash.mcs} mshr${flash.mcsh}`);
    results.push({ name, lite, flash });
  }

  const outFile = path.join(ROOT, "results", `iterate-round4-${new Date().toISOString().replace(/[:.]/g,"-")}.json`);
  fs.writeFileSync(outFile, JSON.stringify({ round: 4, subset: SUBSET, baseline: { lite: liteBaseStats, flash: flashBaseStats }, results }, null, 2));
  console.log(`\nSaved → ${path.relative(ROOT, outFile)}`);
}

main().catch(e => { console.error("Fatal:", e.stack || e.message); process.exit(1); });
