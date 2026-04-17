#!/usr/bin/env node
// 5 prompt variants on Pro, tested against the 5 worst English multi-cat
// receipts. Baseline included (B_base) so we can A/B every variant head-to-head
// even on receipts where prior Pro runs errored (sams_2 specifically).

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

// ── The 5 worst English multi-cat receipts ──
const TEST_FILES = [
  "target_long_1.jpg",
  "target_long_2.jpg",
  "walmart_1.jpg",
  "sams_2.jpg",
  "sams_club.jpg",
];

// ── Prompt fragments ──
const C3 = `\n\nCATEGORY RULE — itemize then consolidate:\nStep 1: For each line item, assign {description, price, categoryId}. Step 2: Group by categoryId and sum. Step 3: Return one categoryAmounts entry per distinct categoryId.`;
const C4 = `\n\nCATEGORY RULE — use tax markers:\nReceipts often mark each item with tax codes (T, F, N, S, O). Taxed non-food (T) → Home Supplies (30186) or Other (30426); non-taxed (N, F) → Groceries (22695).`;
const C6 = `\n\nCATEGORY RULE — detailed category→item mapping:\nFood/produce/meat/pantry → 22695 Groceries.\nBeverages from a cafe → 21716; bottled drinks from a supermarket → 22695.\nCleaning, paper towels, ziploc/foil, pet items → 30186 Home Supplies.\nBatteries, stationery, pens, office supplies → 30426 Other.\nKids' toys, school workbooks, kids clothes → 1276 Kid's Stuff.\nPharmacy/OTC medicine → 17351 Health/Pharmacy.\nFuel, parking, tolls → 48281 Transportation/Gas.\nWork safety gear, uniforms → 47837 Employment Expenses.\nHardware, electrical, lighting, paint → 30186 Home Supplies.`;
const MP = `\n\nPRIORITY REMINDER: merchant and amount are the most important fields. Do not compromise them while attending to category work. Merchant MUST be the consumer brand (not a cashier name, customer name, or translated English word).`;

// ── New test directives ──
const T1_THEMATIC = `\n\nCATEGORY RULE — thematic first-pass:\nBefore applying per-item category mapping, scan the full receipt for seasonal or thematic patterns. If you see items whose descriptions clearly tie to a holiday or theme, route them first:\n  • Easter eggs, Easter bunnies, Easter baskets, jelly beans in Easter packaging → 49552 Holidays/Birthdays\n  • Christmas ornaments, stockings, holiday gift items → 49552 Holidays/Birthdays\n  • Halloween candy, costumes, decor → 49552 Holidays/Birthdays\n  • Valentine candy, cards → 49552 Holidays/Birthdays\n  • Back-to-school workbooks, kids' crayons, lunchboxes → 1276 Kid's Stuff\nOnly items that DON'T match a theme fall through to the generic mappings below.`;

const T2_SECTION = `\n\nCATEGORY RULE — use printed section subtotals when available:\nBig-box store receipts (Target, Walmart, Costco, Sam's Club) sometimes print section headers followed by a list of items and a section subtotal. When a section subtotal is clearly printed (e.g., 'APPAREL 240.14', 'GROCERY 65.48'), use that subtotal directly as your categoryAmounts entry for that section's category. Only sum individual items when no section subtotal is printed. Section headers to recognize: APPAREL → 52714 Clothes, GROCERY → 22695 Groceries, HEALTH & BEAUTY → 17351 Health/Pharmacy, HOME → 30186 Home Supplies, KITCHEN → 30186 Home Supplies, GARAGE & HARDWARE → 30186 Home Supplies, LAUNDRY CLEANING → 30186 Home Supplies, ELECTRONICS → 30426 Other (unless clearly Entertainment), TOYS → 1276 Kid's Stuff.`;

const T3_DIGITCHECK = `\n\nAMOUNT VERIFICATION — re-read the total:\nBefore returning, re-read the printed TOTAL line of the receipt carefully. The amount field MUST equal that printed number. Common OCR digit confusions to double-check: 5↔6, 0↔8, 3↔8, 1↔7, 2↔Z. If the amount you're about to return disagrees with the TOTAL line by more than \$0.05, re-examine the TOTAL line digits; your amount was probably misread. Never adjust individual item prices to match a suspected total.`;

const T4_COTITEMS = `\n\nCHAIN-OF-THOUGHT — itemize in lineItems:\nFor this multi-category receipt, populate the lineItems field as an array of strings, one per purchased item, in the format "DESCRIPTION $PRICE → CATEGORY_ID" (e.g., "Banana $1.99 → 22695"). Emit all visible items. Then compute categoryAmounts by grouping the lineItems by categoryId and summing. This self-check catches items that would otherwise drift between buckets.`;

// ── Base prompt (unchanged R7-T10) ──
function buildBase(categories) {
  return C3 + C4 + C6 + MP + "\n\n" + buildPrompt(categories);
}

// ── Variants ──
const VARIANTS = [
  {
    id: "B_base",
    label: "baseline R7-T10",
    build: (cats) => buildBase(cats),
    useLineItems: false,
  },
  {
    id: "T1_theme",
    label: "thematic first-pass",
    build: (cats) => C3 + C4 + C6 + T1_THEMATIC + MP + "\n\n" + buildPrompt(cats),
    useLineItems: false,
  },
  {
    id: "T2_section",
    label: "section-total priority",
    build: (cats) => C3 + C4 + C6 + T2_SECTION + MP + "\n\n" + buildPrompt(cats),
    useLineItems: false,
  },
  {
    id: "T3_digit",
    label: "amount digit double-check",
    build: (cats) => C3 + C4 + C6 + MP + T3_DIGITCHECK + "\n\n" + buildPrompt(cats),
    useLineItems: false,
  },
  {
    id: "T4_cot",
    label: "CoT itemize in lineItems",
    build: (cats) => C3 + C4 + C6 + MP + T4_COTITEMS + "\n\n" + buildPrompt(cats),
    useLineItems: true,
  },
  {
    id: "T5_nomp",
    label: "drop MP (merchant already 100%)",
    build: (cats) => C3 + C4 + C6 + "\n\n" + buildPrompt(cats),
    useLineItems: false,
  },
];

// ── Schemas ──
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
const SCHEMA_LI = {
  ...SCHEMA_NOLI,
  properties: {
    ...SCHEMA_NOLI.properties,
    lineItems: { type: "array", items: { type: "string" } },
  },
};

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
  const labels = JSON.parse(fs.readFileSync(path.join(ROOT, "test-data", "labels.json"), "utf8"));
  const receipts = TEST_FILES.map(f => labels.find(l => l.file === f)).filter(Boolean);
  console.log(`Pro prompt A/B/C/D/E on ${receipts.length} worst multi-cat × ${VARIANTS.length} variants × 2 runs = ${receipts.length*VARIANTS.length*2} Pro calls\n`);

  const results = [];
  for (const label of receipts) {
    const groundCatIds = label.categoryAmounts.map(c => c.categoryId);
    const cats = TEST_CATEGORIES.filter(c => groundCatIds.includes(c.id));
    const img = fs.readFileSync(path.join(ROOT, "test-data", "images", label.file));
    const mime = mimeFor(label.file);
    console.log(`=== ${label.file} (cats: ${groundCatIds.join(",")}) amount=$${label.amount} ===`);
    for (const variant of VARIANTS) {
      const prompt = variant.build(cats);
      const schema = variant.useLineItems ? SCHEMA_LI : SCHEMA_NOLI;
      for (const run of [1, 2]) {
        process.stdout.write(`  ${variant.id.padEnd(11)} run${run} `);
        try {
          const t0 = Date.now();
          const r = await call({ imageBytes: img, mimeType: mime, prompt, schema });
          const ms = Date.now() - t0;
          const grade = gradeResult(label, r.parsed);
          const ca = r.parsed.categoryAmounts || [];
          const sumCA = ca.reduce((s, c) => s + (c.amount || 0), 0);
          const modelAmt = r.parsed.amount || 0;
          const drift = Math.abs(sumCA - modelAmt);
          const sumMatch = drift <= 0.05;
          const cset = grade.categoryAmounts?.setMatch ? "✓" : "✗";
          const cshr = grade.categoryAmounts?.shareMatch ? "✓" : "✗";
          console.log(`m${grade.merchant.pass?"✓":"✗"} d${grade.date.pass?"✓":"✗"} a${grade.amount.pass?"✓":"✗"} sum${sumMatch?"✓":"✗"} cset${cset} cshr${cshr} drift $${drift.toFixed(2)} out=${r.tokens?.candidatesTokenCount||"?"}tok ${ms}ms`);
          results.push({ file: label.file, variant: variant.id, run, grade, sumMatch, drift, modelAmt, sumCA, tokens: r.tokens, ms });
        } catch (e) {
          console.log(`ERR ${e.message.slice(0,60)}`);
          results.push({ file: label.file, variant: variant.id, run, error: e.message });
        }
      }
    }
    console.log();
  }

  console.log(`=== Aggregate per variant (${receipts.length} receipts × 2 runs = ${receipts.length*2} calls/variant) ===`);
  const n = receipts.length * 2;
  for (const v of VARIANTS) {
    const rs = results.filter(r => r.variant === v.id && r.grade);
    const ok = rs.length;
    const m = rs.filter(r => r.grade.merchant.pass).length;
    const d = rs.filter(r => r.grade.date.pass).length;
    const a = rs.filter(r => r.grade.amount.pass).length;
    const sum = rs.filter(r => r.sumMatch).length;
    const cset = rs.filter(r => r.grade.categoryAmounts?.setMatch).length;
    const cshr = rs.filter(r => r.grade.categoryAmounts?.shareMatch).length;
    const avgOut = rs.reduce((s,r) => s + (r.tokens?.candidatesTokenCount || 0), 0) / (ok || 1);
    const avgMs = rs.reduce((s,r) => s + r.ms, 0) / (ok || 1);
    console.log(`${v.id.padEnd(11)} ${v.label.padEnd(38)}  ok ${ok}/${n}  m ${m}/${ok}  d ${d}/${ok}  a ${a}/${ok}  sum ${sum}/${ok}  cset ${cset}/${ok}  cshr ${cshr}/${ok}  out ${avgOut.toFixed(0)}tok  ${avgMs.toFixed(0)}ms`);
  }

  const outFile = path.join(ROOT, "results", `pro-prompts-${new Date().toISOString().replace(/[:.]/g,"-")}.json`);
  fs.writeFileSync(outFile, JSON.stringify({ run: "pro-prompts", results }, null, 2));
  console.log(`\nSaved → ${path.relative(ROOT, outFile)}`);
}

main().catch(e => { console.error("Fatal:", e.stack || e.message); process.exit(1); });
