#!/usr/bin/env node
// Round 7 — refining the R6-T5 winner (Flash C3+C4+C6+merchant-priority).
// Goals: push cset above 90%, recover Lite merchant regression, validate Vietnamese.

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

const HARD = ["target.jpg", "sams_club.jpg", "sroie_0024.jpg", "sroie_0070.jpg", "sroie_0096.jpg", "sroie_0004.jpg", "sroie_0038.jpg", "sroie_0072.jpg", "sroie_0084.jpg", "sroie_0100.jpg"];

const categoryList = TEST_CATEGORIES
  .map(c => c.tag ? `  - id=${c.id} name="${c.name}" tag="${c.tag}"` : `  - id=${c.id} name="${c.name}"`)
  .join("\n");

const FLASH_BASE = buildPrompt(TEST_CATEGORIES);

const LITE_COMMON = `- date MUST be YYYY-MM-DD ISO.
- merchant is the consumer brand. Preserve original language.
- merchantLegalName is optional.
- Do NOT return a cashier/customer personal name as merchant.
- Category ids must come from:
${categoryList}`;

const LITE_BASE = `Extract receipt data as JSON: {transcription, merchant, merchantLegalName?, date, amountCents (integer), categoryAmounts?}.

Stage 1: transcription = every line of the receipt as plain text.
Stage 2: extract remaining fields.

Amount is INTEGER CENTS. Ignore GST-summary pre-tax rows.

${LITE_COMMON}`;

const C3 = `\n\nCATEGORY RULE — itemize then consolidate:\nStep 1: For each line item, assign {description, price, categoryId}. Step 2: Group by categoryId and sum. Step 3: Return one categoryAmounts entry per distinct categoryId.`;

const C4 = `\n\nCATEGORY RULE — use tax markers:\nReceipts often mark each item with tax codes (T, F, N, S, O). Taxed non-food (T) → Home Supplies (30186) or Other (30426); non-taxed (N, F) → Groceries (22695).`;

const C6 = `\n\nCATEGORY RULE — detailed category→item mapping:\nFood/produce/meat/pantry → 22695 Groceries.\nBeverages from a cafe → 21716; bottled drinks from a supermarket → 22695.\nCleaning, paper towels, ziploc/foil, pet items → 30186 Home Supplies.\nBatteries, stationery, pens, office supplies → 30426 Other.\nKids' toys, school workbooks, kids clothes → 1276 Kid's Stuff.\nPharmacy/OTC medicine → 17351 Health/Pharmacy.\nFuel, parking, tolls → 48281 Transportation/Gas.\nWork safety gear, uniforms → 47837 Employment Expenses.\nHardware, electrical, lighting, paint → 30186 Home Supplies.`;

const MP = `\n\nPRIORITY REMINDER: merchant and amount are the most important fields — they determine bank-feed matching and budget accuracy. Do not compromise them while attending to category work. Merchant MUST be the consumer brand (not a cashier name, customer name, or translated English word).`;

const REWORDED_META = `\n\nPRIORITY ORDER: When extracting, these are strictly ordered by importance: amount > merchant > date > category. If applying a category rule would require misreading merchant, merchant wins. Category work happens AFTER the first three fields are locked in.`;

const SWW = `\n\nCATEGORY RULE — split only when warranted:\nOnly split into multiple categoryAmounts when the receipt CLEARLY mixes distinct budget categories. Signals: tax codes differ by item (T vs N); receipt has obviously-different product types (food + batteries + household); general retail where items obviously differ (Target with pet items + groceries). If all items serve one budget purpose (fast food meal, single-product purchase, single-purpose store visit), return ONE categoryAmounts entry.`;

const STRONG_MERCHANT = `\n\nCRITICAL — MERCHANT RULE: The merchant field MUST be the consumer brand extracted from the receipt header. It is NEVER a cashier name, customer name, or personal name. Common personal names to REJECT as merchant: ${'"'}tan chay yee${'"'}, ${'"'}ahmad bin${'"'}, ${'"'}chen li${'"'}, etc. When you see a personal name, look elsewhere — the store name is typically the LARGEST text or the first line on the receipt (e.g., "99 SPEED MART", "OJC MARKETING", "POPULAR BOOK"). Even when doing category work, protect merchant accuracy.`;

const CATEGORY_FIRST_ORDER = (base, addition) => addition + "\n\n" + base;  // reverses normal ordering

const TESTS = [
  { id: "R7-T1",  name: "FLASH C3+C4+C6+MP @ temp 0.1 FULL 53",     model: FLASH, base: FLASH_BASE, add: C3 + C4 + C6 + MP,                        subset: "full-en",    temp: 0.1 },
  { id: "R7-T2",  name: "FLASH C3+C4+C6 @ temp 0.1 FULL 53",        model: FLASH, base: FLASH_BASE, add: C3 + C4 + C6,                             subset: "full-en",    temp: 0.1 },
  { id: "R7-T3",  name: "FLASH C3+C4+C6 + reworded-meta FULL 53",    model: FLASH, base: FLASH_BASE, add: C3 + C4 + C6 + REWORDED_META,             subset: "full-en",    temp: 0 },
  { id: "R7-T4",  name: "LITE C3+C4+C6 + strong-merchant FULL 53",   model: LITE,  base: LITE_BASE,  add: C3 + C4 + C6 + STRONG_MERCHANT,           subset: "full-en",    temp: 0 },
  { id: "R7-T5",  name: "FLASH C3+C4+C6+MP + SWW FULL 53",           model: FLASH, base: FLASH_BASE, add: C3 + C4 + C6 + MP + SWW,                   subset: "full-en",    temp: 0 },
  { id: "R7-T6",  name: "LITE C3+C4+C6 @ temp 0.1 HARD 10",          model: LITE,  base: LITE_BASE,  add: C3 + C4 + C6,                             subset: "hard",       temp: 0.1 },
  { id: "R7-T7",  name: "FLASH R6-T5 on Vietnamese 50",              model: FLASH, base: FLASH_BASE, add: C3 + C4 + C6 + MP,                        subset: "vi",         temp: 0 },
  { id: "R7-T8",  name: "LITE T4-cfg on Vietnamese 50",              model: LITE,  base: LITE_BASE,  add: C3 + C4 + C6 + STRONG_MERCHANT,           subset: "vi",         temp: 0 },
  { id: "R7-T9",  name: "FLASH kitchen sink (C3+4+6+MP+SWW+t0.1)",   model: FLASH, base: FLASH_BASE, add: C3 + C4 + C6 + MP + SWW,                   subset: "full-en",    temp: 0.1 },
  { id: "R7-T10", name: "FLASH cat-first ordering FULL 53",          model: FLASH, base: FLASH_BASE, add: C3 + C4 + C6 + MP, reverseOrder: true,    subset: "full-en",    temp: 0 },
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

async function call({ model, imageBytes, mimeType, prompt, schema, temp = 0 }) {
  let lastErr;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await client.models.generateContent({
        model, contents: [{ role: "user", parts: [{ text: prompt }, { inlineData: { mimeType, data: imageBytes.toString("base64") } }] }],
        config: { responseMimeType: "application/json", responseSchema: schema, temperature: temp },
      });
      try {
        const parsed = JSON.parse(res.text);
        if (model === LITE && typeof parsed.amountCents === "number" && parsed.amount === undefined) parsed.amount = parsed.amountCents / 100;
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
  const schema = test.model === LITE ? LITE_SCHEMA : FLASH_SCHEMA;
  const prompt = test.reverseOrder ? (test.add + "\n\n" + test.base) : (test.base + test.add);
  for (const label of labels) {
    const imgPath = path.join(ROOT, "test-data", "images", label.file);
    const imageBytes = fs.readFileSync(imgPath);
    const mimeType = mimeFor(label.file);
    let parsed;
    try { parsed = (await call({ model: test.model, imageBytes, mimeType, prompt, schema, temp: test.temp || 0 })).parsed; }
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
  const hardSet = HARD.map(f => labels.find(l => l.file === f)).filter(Boolean);
  const fullEng = labels.filter(l => l.source !== "MC-OCR");
  const vietSet = labels.filter(l => l.source === "MC-OCR");
  console.log(`Round 7 — refining R6-T5\nHard: ${hardSet.length} | Full English: ${fullEng.length} | Vietnamese: ${vietSet.length}\n`);

  const subsets = { "hard": hardSet, "full-en": fullEng, "vi": vietSet };
  const results = [];
  for (const test of TESTS) {
    const receipts = subsets[test.subset];
    process.stdout.write(`${test.id.padEnd(8)} ${test.name.padEnd(48)}... `);
    const start = Date.now();
    const r = await runTest(test, receipts);
    const secs = ((Date.now() - start) / 1000).toFixed(0);
    console.log(`m${r.m}/${r.total} d${r.d}/${r.total} a${r.a}/${r.total} | cset${r.cs}/${r.total} cshr${r.csh}/${r.total} | mset${r.mcs}/${r.multiTotal} mshr${r.mcsh}/${r.multiTotal} | ${secs}s`);
    results.push({ test: { id: test.id, name: test.name, subset: test.subset, temp: test.temp || 0 }, r });
  }

  const outFile = path.join(ROOT, "results", `iterate-round7-${new Date().toISOString().replace(/[:.]/g,"-")}.json`);
  fs.writeFileSync(outFile, JSON.stringify({ round: 7, results }, null, 2));
  console.log(`\nSaved → ${path.relative(ROOT, outFile)}`);
}

main().catch(e => { console.error("Fatal:", e.stack || e.message); process.exit(1); });
