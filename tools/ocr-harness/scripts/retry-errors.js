#!/usr/bin/env node
// Post-run retry helper. Takes a results JSON saved by test-pro-prompts.js
// (or any script using the same result shape), finds all entries with an
// `error` field, re-runs just those calls with longer backoffs to ride out
// Pro capacity dips, and patches the JSON in place.
//
// Usage: node scripts/retry-errors.js <results-json-path> [--waitSec=45]
//
// Between retries we sleep for waitSec (default 45s) — longer than the
// ~4s total backoff in the inline retry — so we actually outlast cluster
// outages. Each errored call gets up to 3 additional attempts.

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
const PRO = "gemini-2.5-pro";

const args = process.argv.slice(2);
const resultsPath = args.find(a => !a.startsWith("--"));
const waitSec = parseInt((args.find(a => a.startsWith("--waitSec=")) || "--waitSec=45").split("=")[1], 10);
if (!resultsPath) {
  console.error("Usage: retry-errors.js <results-json-path> [--waitSec=45]");
  process.exit(1);
}

// ── Mirror the prompt fragments / variants from test-pro-prompts.js ──
// Keep in sync with the source script; edits there need corresponding edits here.
const C3 = `\n\nCATEGORY RULE — itemize then consolidate:\nStep 1: For each line item, assign {description, price, categoryId}. Step 2: Group by categoryId and sum. Step 3: Return one categoryAmounts entry per distinct categoryId.`;
const C4 = `\n\nCATEGORY RULE — use tax markers:\nReceipts often mark each item with tax codes (T, F, N, S, O). Taxed non-food (T) → Home Supplies (30186) or Other (30426); non-taxed (N, F) → Groceries (22695).`;
const C6 = `\n\nCATEGORY RULE — detailed category→item mapping:\nFood/produce/meat/pantry → 22695 Groceries.\nBeverages from a cafe → 21716; bottled drinks from a supermarket → 22695.\nCleaning, paper towels, ziploc/foil, pet items → 30186 Home Supplies.\nBatteries, stationery, pens, office supplies → 30426 Other.\nKids' toys, school workbooks, kids clothes → 1276 Kid's Stuff.\nPharmacy/OTC medicine → 17351 Health/Pharmacy.\nFuel, parking, tolls → 48281 Transportation/Gas.\nWork safety gear, uniforms → 47837 Employment Expenses.\nHardware, electrical, lighting, paint → 30186 Home Supplies.`;
const MP = `\n\nPRIORITY REMINDER: merchant and amount are the most important fields. Do not compromise them while attending to category work. Merchant MUST be the consumer brand (not a cashier name, customer name, or translated English word).`;

const T1_THEMATIC = `\n\nCATEGORY RULE — thematic first-pass:\nBefore applying per-item category mapping, scan the full receipt for seasonal or thematic patterns. If you see items whose descriptions clearly tie to a holiday or theme, route them first:\n  • Easter eggs, Easter bunnies, Easter baskets, jelly beans in Easter packaging → 49552 Holidays/Birthdays\n  • Christmas ornaments, stockings, holiday gift items → 49552 Holidays/Birthdays\n  • Halloween candy, costumes, decor → 49552 Holidays/Birthdays\n  • Valentine candy, cards → 49552 Holidays/Birthdays\n  • Back-to-school workbooks, kids' crayons, lunchboxes → 1276 Kid's Stuff\nOnly items that DON'T match a theme fall through to the generic mappings below.`;
const T2_SECTION = `\n\nCATEGORY RULE — use printed section subtotals when available:\nBig-box store receipts (Target, Walmart, Costco, Sam's Club) sometimes print section headers followed by a list of items and a section subtotal. When a section subtotal is clearly printed (e.g., 'APPAREL 240.14', 'GROCERY 65.48'), use that subtotal directly as your categoryAmounts entry for that section's category. Only sum individual items when no section subtotal is printed. Section headers to recognize: APPAREL → 52714 Clothes, GROCERY → 22695 Groceries, HEALTH & BEAUTY → 17351 Health/Pharmacy, HOME → 30186 Home Supplies, KITCHEN → 30186 Home Supplies, GARAGE & HARDWARE → 30186 Home Supplies, LAUNDRY CLEANING → 30186 Home Supplies, ELECTRONICS → 30426 Other (unless clearly Entertainment), TOYS → 1276 Kid's Stuff.`;
const T3_DIGITCHECK = `\n\nAMOUNT VERIFICATION — re-read the total:\nBefore returning, re-read the printed TOTAL line of the receipt carefully. The amount field MUST equal that printed number. Common OCR digit confusions to double-check: 5↔6, 0↔8, 3↔8, 1↔7, 2↔Z. If the amount you're about to return disagrees with the TOTAL line by more than \$0.05, re-examine the TOTAL line digits; your amount was probably misread. Never adjust individual item prices to match a suspected total.`;
const T4_COTITEMS = `\n\nCHAIN-OF-THOUGHT — itemize in lineItems:\nFor this multi-category receipt, populate the lineItems field as an array of strings, one per purchased item, in the format "DESCRIPTION $PRICE → CATEGORY_ID" (e.g., "Banana $1.99 → 22695"). Emit all visible items. Then compute categoryAmounts by grouping the lineItems by categoryId and summing. This self-check catches items that would otherwise drift between buckets.`;

const VARIANTS = {
  B_base:    { useLineItems: false, build: (cats) => C3 + C4 + C6 + MP + "\n\n" + buildPrompt(cats) },
  T1_theme:  { useLineItems: false, build: (cats) => C3 + C4 + C6 + T1_THEMATIC + MP + "\n\n" + buildPrompt(cats) },
  T2_section:{ useLineItems: false, build: (cats) => C3 + C4 + C6 + T2_SECTION + MP + "\n\n" + buildPrompt(cats) },
  T3_digit:  { useLineItems: false, build: (cats) => C3 + C4 + C6 + MP + T3_DIGITCHECK + "\n\n" + buildPrompt(cats) },
  T4_cot:    { useLineItems: true,  build: (cats) => C3 + C4 + C6 + MP + T4_COTITEMS + "\n\n" + buildPrompt(cats) },
  T5_nomp:   { useLineItems: false, build: (cats) => C3 + C4 + C6 + "\n\n" + buildPrompt(cats) },
};

const SCHEMA_NOLI = {
  type: "object",
  properties: {
    merchant: { type: "string" }, merchantLegalName: { type: "string" },
    date: { type: "string" }, amount: { type: "number" },
    categoryAmounts: { type: "array", items: { type: "object", properties: { categoryId: { type: "integer" }, amount: { type: "number" } }, required: ["categoryId", "amount"] } },
    notes: { type: "string" },
  },
  required: ["merchant", "date", "amount"],
};
const SCHEMA_LI = { ...SCHEMA_NOLI, properties: { ...SCHEMA_NOLI.properties, lineItems: { type: "array", items: { type: "string" } } } };

const client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

async function call({ imageBytes, mimeType, prompt, schema }) {
  let lastErr;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await client.models.generateContent({
        model: PRO,
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

async function main() {
  const data = JSON.parse(fs.readFileSync(resultsPath, "utf8"));
  const labels = JSON.parse(fs.readFileSync(path.join(ROOT, "test-data", "labels.json"), "utf8"));
  const errors = data.results.filter(r => r.error);
  console.log(`Found ${errors.length} errored calls to retry. Waiting ${waitSec}s between each.\n`);
  if (errors.length === 0) return;

  let fixed = 0;
  const maxRetries = 3;
  for (let i = 0; i < errors.length; i++) {
    const row = errors[i];
    const label = labels.find(l => l.file === row.file);
    const variantDef = VARIANTS[row.variant];
    if (!label || !variantDef) {
      console.log(`  skip ${row.file} ${row.variant}: config missing`);
      continue;
    }
    const groundCatIds = label.categoryAmounts.map(c => c.categoryId);
    const cats = TEST_CATEGORIES.filter(c => groundCatIds.includes(c.id));
    const prompt = variantDef.build(cats);
    const schema = variantDef.useLineItems ? SCHEMA_LI : SCHEMA_NOLI;
    const img = fs.readFileSync(path.join(ROOT, "test-data", "images", label.file));
    const mime = mimeFor(label.file);

    let resolved = false;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      process.stdout.write(`[${i+1}/${errors.length}] ${row.variant} ${row.file} run${row.run} attempt${attempt} ... `);
      try {
        const t0 = Date.now();
        const r = await call({ imageBytes: img, mimeType: mime, prompt, schema });
        const ms = Date.now() - t0;
        const grade = gradeResult(label, r.parsed);
        const ca = r.parsed.categoryAmounts || [];
        const sumCA = ca.reduce((s, c) => s + (c.amount || 0), 0);
        const modelAmt = r.parsed.amount || 0;
        const drift = Math.abs(sumCA - modelAmt);
        // Replace the errored entry in-place
        const idx = data.results.indexOf(row);
        data.results[idx] = { file: row.file, variant: row.variant, run: row.run, grade, sumMatch: drift <= 0.05, drift, modelAmt, sumCA, tokens: r.tokens, ms };
        fixed++;
        console.log(`ok m${grade.merchant.pass?"✓":"✗"} d${grade.date.pass?"✓":"✗"} a${grade.amount.pass?"✓":"✗"} cset${grade.categoryAmounts?.setMatch?"✓":"✗"} cshr${grade.categoryAmounts?.shareMatch?"✓":"✗"} ${ms}ms`);
        resolved = true;
        break;
      } catch (e) {
        console.log(`ERR ${e.message.slice(0, 60)}`);
        if (attempt < maxRetries) {
          process.stdout.write(`    sleeping ${waitSec}s before retry...\n`);
          await new Promise(r => setTimeout(r, waitSec * 1000));
        }
      }
    }
    if (!resolved) console.log(`    gave up after ${maxRetries} retries`);
    if (i < errors.length - 1) await new Promise(r => setTimeout(r, waitSec * 1000));
  }

  fs.writeFileSync(resultsPath, JSON.stringify(data, null, 2));
  console.log(`\nResolved ${fixed}/${errors.length} errored calls. Patched → ${resultsPath}`);
}

main().catch(e => { console.error("Fatal:", e.stack || e.message); process.exit(1); });
