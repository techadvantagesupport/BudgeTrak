#!/usr/bin/env node
// Round 5 — combinations of Round 4 winners. C3/C4 help Lite; C6/C7 help Flash.
// Tests 6 and 7 run on the FULL 53-receipt English set to validate that gains
// generalize beyond the 10-receipt hard subset.

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

const HARD_SUBSET = ["target.jpg", "sams_club.jpg", "sroie_0024.jpg", "sroie_0070.jpg", "sroie_0096.jpg", "sroie_0004.jpg", "sroie_0038.jpg", "sroie_0072.jpg", "sroie_0084.jpg", "sroie_0100.jpg"];

const categoryList = TEST_CATEGORIES
  .map(c => c.tag ? `  - id=${c.id} name="${c.name}" tag="${c.tag}"` : `  - id=${c.id} name="${c.name}"`)
  .join("\n");

const FLASH_BASE = buildPrompt(TEST_CATEGORIES);

const LITE_COMMON = `- date MUST be YYYY-MM-DD ISO (never the original format).
- merchant is the consumer brand. Preserve original language.
- merchantLegalName is optional (legal entity if distinct).
- Do NOT return a cashier/customer personal name as merchant.
- Category ids must come from:
${categoryList}`;

const LITE_BASE = `Extract receipt data as JSON: {transcription, merchant, merchantLegalName?, date, amountCents (integer), categoryAmounts?}.

Stage 1: transcription = every line of the receipt as plain text.
Stage 2: extract remaining fields from your transcription.

Amount is INTEGER CENTS. Examples: "5.35" → 535. "169.78" → 16978. Ignore GST-summary pre-tax rows.

${LITE_COMMON}`;

// ── Proven category additions from Round 4 ──
const C3_ITEMIZE = `\n\nCATEGORY RULE — itemize then consolidate:\nStep 1: For each purchased line item, mentally assign {description, price, categoryId}. Step 2: Group by categoryId and sum. Step 3: Return one categoryAmounts entry per distinct categoryId.`;

const C4_TAX_HINT = `\n\nCATEGORY RULE — use tax markers:\nReceipts often mark each item with tax codes (T, F, N, S, O, etc.). Taxed non-food items (T) typically group into Home Supplies (30186) or Other (30426); non-taxed items (N, F) are usually Groceries (22695). Use these as hints.`;

const C5_MIN_SPLIT = `\n\nCATEGORY RULE — minimum split threshold:\nOnly create a separate categoryAmounts entry if that category represents at least $5 OR 10% of the total. Below that, merge into the dominant category.`;

const C6_WALKTHROUGH = `\n\nCATEGORY RULE — detailed category→item mapping:\nFood/produce/meat/pantry/bulk → 22695 Groceries (even at warehouse stores).\nBeverages from a cafe → 21716; bottled drinks from a supermarket → 22695.\nCleaning, paper towels, ziploc/foil, pet items → 30186 Home Supplies.\nBatteries, stationery, pens, office supplies → 30426 Other.\nChildren's toys, school workbooks, kids clothes → 1276 Kid's Stuff.\nPharmacy items, OTC medicine → 17351 Health/Pharmacy.\nFuel, parking, tolls → 48281 Transportation/Gas.\nWork safety gear, uniforms → 47837 Employment Expenses.\nHardware, electrical, lighting, paint → 30186 Home Supplies.`;

const C7_STORE_DEFAULT = `\n\nCATEGORY RULE — store-type default:\nApply the merchant's natural category first, then split for clear exceptions:\n- Supermarket / warehouse store → default Groceries; split non-food items.\n- Restaurant / cafe → default Restaurants/Prepared Food.\n- Gas station → default Transportation/Gas; split in-store snacks.\n- Pharmacy → default Health/Pharmacy.\n- Hardware / electrical / lighting → default Home Supplies.\n- Stationery / bookstore (adult) → default Other; split kids' school supplies.\n- General retail (Target, Walmart) → no default; split by item type.`;

const C9_FEWSHOT = `\n\nCATEGORY RULE — examples:\nTarget: [BUBBL'R, Lean Cuisine, Milk (groceries); Dog Treats, Dog Toy (pet/home)]. Split: [{22695, 16.63}, {30186, 26.82}].\nSam's Club: mostly groceries + batteries + ziploc/shampoo. Split: [{22695, bulk}, {30186, household}, {30426, batteries}].\nSupermarket single-bucket: all food → one entry {22695, total}. Don't fragment.`;

// ── New refined variants ──
const NARROWER_CONSOLIDATE = `\n\nCATEGORY RULE — narrow consolidation:\nReturn ONE entry per distinct categoryId (sum amounts per category). But do NOT force-merge different categories into one. If a receipt has both groceries and home supplies, return two entries. If it has only groceries, return one.`;

const C7_REFINED = `\n\nCATEGORY RULE — store default, with exceptions:\nStart with the merchant's primary category type (supermarket → Groceries, hardware store → Home Supplies, etc.). Use it as the default for items that naturally fit. BUT always create separate categoryAmounts entries for items that clearly belong to a different category (e.g., batteries at a supermarket become their own Other entry). Do NOT force-fit items into the default. When in doubt, split.`;

// ── 10 test configurations ──
const TESTS = [
  { id: "T1",  name: "LITE: C3 + C4",                   model: LITE,  base: LITE_BASE,  addition: C3_ITEMIZE + C4_TAX_HINT,                              subset: "hard" },
  { id: "T2",  name: "FLASH: C6 + C7",                  model: FLASH, base: FLASH_BASE, addition: C6_WALKTHROUGH + C7_STORE_DEFAULT,                     subset: "hard" },
  { id: "T3",  name: "LITE: C3 + C4 + C5",              model: LITE,  base: LITE_BASE,  addition: C3_ITEMIZE + C4_TAX_HINT + C5_MIN_SPLIT,               subset: "hard" },
  { id: "T4",  name: "FLASH: C6 + C9",                  model: FLASH, base: FLASH_BASE, addition: C6_WALKTHROUGH + C9_FEWSHOT,                           subset: "hard" },
  { id: "T5a", name: "LITE: C3 + C6",                   model: LITE,  base: LITE_BASE,  addition: C3_ITEMIZE + C6_WALKTHROUGH,                           subset: "hard" },
  { id: "T5b", name: "FLASH: C3 + C6",                  model: FLASH, base: FLASH_BASE, addition: C3_ITEMIZE + C6_WALKTHROUGH,                           subset: "hard" },
  { id: "T6",  name: "LITE: C4 only, FULL 53",          model: LITE,  base: LITE_BASE,  addition: C4_TAX_HINT,                                           subset: "full" },
  { id: "T7",  name: "FLASH: C6 only, FULL 53",         model: FLASH, base: FLASH_BASE, addition: C6_WALKTHROUGH,                                        subset: "full" },
  { id: "T8",  name: "LITE: C4 + narrower consolidate", model: LITE,  base: LITE_BASE,  addition: C4_TAX_HINT + NARROWER_CONSOLIDATE,                    subset: "hard" },
  { id: "T9",  name: "FLASH: C7 refined",               model: FLASH, base: FLASH_BASE, addition: C7_REFINED,                                            subset: "hard" },
  { id: "T10a",name: "LITE: C3 + C4 + C6",              model: LITE,  base: LITE_BASE,  addition: C3_ITEMIZE + C4_TAX_HINT + C6_WALKTHROUGH,             subset: "hard" },
  { id: "T10b",name: "FLASH: C3 + C4 + C6",             model: FLASH, base: FLASH_BASE, addition: C3_ITEMIZE + C4_TAX_HINT + C6_WALKTHROUGH,             subset: "hard" },
];

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

async function call({ model, imageBytes, mimeType, prompt }) {
  const schema = model === LITE ? LITE_SCHEMA : FLASH_SCHEMA;
  let lastErr;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await client.models.generateContent({
        model, contents: [{ role: "user", parts: [{ text: prompt }, { inlineData: { mimeType, data: imageBytes.toString("base64") } }] }],
        config: { responseMimeType: "application/json", responseSchema: schema, temperature: 0 },
      });
      try {
        const parsed = JSON.parse(res.text);
        if (model === LITE && typeof parsed.amountCents === "number") parsed.amount = parsed.amountCents / 100;
        return { ok: true, parsed };
      } catch (e) { return { ok: false, error: e.message, raw: res.text }; }
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

async function runTest(test, labels) {
  const stats = { m: 0, d: 0, a: 0, cs: 0, csh: 0, mcs: 0, mcsh: 0, total: 0, multiTotal: 0 };
  for (const label of labels) {
    const imgPath = path.join(ROOT, "test-data", "images", label.file);
    const imageBytes = fs.readFileSync(imgPath);
    const mimeType = mimeFor(label.file);
    let parsed;
    try { parsed = (await call({ model: test.model, imageBytes, mimeType, prompt: test.base + test.addition })).parsed; }
    catch (e) { console.log(`  [err ${label.file}] ${e.message.slice(0, 50)}`); continue; }
    if (!parsed) continue;
    const grade = gradeResult(label, parsed);
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
  }
  return stats;
}

async function main() {
  const labels = JSON.parse(fs.readFileSync(path.join(ROOT, "test-data", "labels.json"), "utf8"));
  const hardSubset = HARD_SUBSET.map(f => labels.find(l => l.file === f)).filter(Boolean);
  const fullEnglish = labels.filter(l => l.source !== "MC-OCR");
  console.log(`Round 5 — combinations.\nHard subset: ${hardSubset.length} receipts | Full English: ${fullEnglish.length} receipts\n`);

  const results = [];
  for (const test of TESTS) {
    const receipts = test.subset === "full" ? fullEnglish : hardSubset;
    process.stdout.write(`${test.id.padEnd(5)} ${test.name.padEnd(42)}... `);
    const start = Date.now();
    const r = await runTest(test, receipts);
    const secs = ((Date.now() - start) / 1000).toFixed(0);
    console.log(`m${r.m}/${r.total} d${r.d}/${r.total} a${r.a}/${r.total} | cset${r.cs}/${r.total} cshr${r.csh}/${r.total} | multi mset${r.mcs}/${r.multiTotal} mshr${r.mcsh}/${r.multiTotal} | ${secs}s`);
    results.push({ test, r });
  }

  const outFile = path.join(ROOT, "results", `iterate-round5-${new Date().toISOString().replace(/[:.]/g,"-")}.json`);
  fs.writeFileSync(outFile, JSON.stringify({ round: 5, results }, null, 2));
  console.log(`\nSaved → ${path.relative(ROOT, outFile)}`);
}

main().catch(e => { console.error("Fatal:", e.stack || e.message); process.exit(1); });
