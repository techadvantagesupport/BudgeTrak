#!/usr/bin/env node
// Re-benchmark R7-T10 (Flash winner) + R11 (Lite) on the app-style 158-receipt
// test bank. Splits metrics by source to catch quality-related regressions.

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
const MP = `\n\nPRIORITY REMINDER: merchant and amount are the most important fields. Do not compromise them while attending to category work. Merchant MUST be the consumer brand (not a cashier name, customer name, or translated English word).`;

const R7T10_PROMPT = C3 + C4 + C6 + MP + "\n\n" + FLASH_BASE;
const R11_PROMPT = LITE_BASE;

const TESTS = [
  { id: "R7-T10 FLASH", model: FLASH, prompt: R7T10_PROMPT },
  { id: "R11    LITE ", model: LITE,  prompt: R11_PROMPT   },
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

async function call({ model, imageBytes, mimeType, prompt, schema }) {
  let lastErr;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await client.models.generateContent({
        model, contents: [{ role: "user", parts: [{ text: prompt }, { inlineData: { mimeType, data: imageBytes.toString("base64") } }] }],
        config: { responseMimeType: "application/json", responseSchema: schema, temperature: 0 },
      });
      const parsed = JSON.parse(res.text);
      if (model === LITE && typeof parsed.amountCents === "number" && parsed.amount === undefined) parsed.amount = parsed.amountCents / 100;
      return parsed;
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

function emptyStats() { return { m: 0, d: 0, a: 0, cs: 0, csh: 0, mcs: 0, mcsh: 0, total: 0, multiTotal: 0, errs: 0 }; }

function addGrade(stats, grade) {
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

function printRow(label, s) {
  const pct = (n, d) => d === 0 ? "  -  " : `${((n/d)*100).toFixed(0).padStart(3)}%`;
  console.log(`  ${label.padEnd(28)} n=${String(s.total).padStart(3)}  m ${pct(s.m, s.total)}  d ${pct(s.d, s.total)}  a ${pct(s.a, s.total)}  cset ${pct(s.cs, s.total)}  mset ${s.mcs}/${s.multiTotal}  mshr ${s.mcsh}/${s.multiTotal}  err ${s.errs}`);
}

async function runTest(test, labels) {
  const byBucket = { all: emptyStats(), SROIE: emptyStats(), "MC-OCR": emptyStats(), "hardReceipts-set": emptyStats(), "DoorDash": emptyStats(), "Amazon": emptyStats(), "internal-screenshots": emptyStats() };
  const schema = test.model === LITE ? LITE_SCHEMA : FLASH_SCHEMA;
  let idx = 0;
  for (const label of labels) {
    idx++;
    if (idx % 20 === 0) process.stdout.write(`.`);
    const imgPath = path.join(ROOT, "test-data", "images", label.file);
    const imageBytes = fs.readFileSync(imgPath);
    const mimeType = mimeFor(label.file);
    let parsed;
    try { parsed = await call({ model: test.model, imageBytes, mimeType, prompt: test.prompt, schema }); }
    catch (e) {
      byBucket.all.errs++;
      if (byBucket[label.source]) byBucket[label.source].errs++;
      continue;
    }
    const grade = gradeResult(label, parsed);
    addGrade(byBucket.all, grade);
    if (byBucket[label.source]) addGrade(byBucket[label.source], grade);
  }
  return byBucket;
}

async function main() {
  const labels = JSON.parse(fs.readFileSync(path.join(ROOT, "test-data", "labels.json"), "utf8"));
  console.log(`App-style validation — ${labels.length} receipts\n`);

  const all = [];
  for (const test of TESTS) {
    console.log(`=== ${test.id} ===`);
    const start = Date.now();
    const buckets = await runTest(test, labels);
    const secs = ((Date.now() - start) / 1000).toFixed(0);
    console.log("");
    for (const [bucket, s] of Object.entries(buckets)) {
      if (s.total + s.errs === 0) continue;
      printRow(bucket, s);
    }
    console.log(`  (${secs}s)\n`);
    all.push({ id: test.id.trim(), buckets, seconds: Number(secs) });
  }

  const outFile = path.join(ROOT, "results", `validate-appstyle-${new Date().toISOString().replace(/[:.]/g,"-")}.json`);
  fs.writeFileSync(outFile, JSON.stringify({ run: "validate-appstyle", results: all }, null, 2));
  console.log(`Saved → ${path.relative(ROOT, outFile)}`);
}

main().catch(e => { console.error("Fatal:", e.stack || e.message); process.exit(1); });
