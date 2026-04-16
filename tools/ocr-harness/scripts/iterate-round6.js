#!/usr/bin/env node
// Round 6 — Full-53 validation of the triple combo + merchant-preservation variants.
// Goal: confirm T10b Flash C3+C4+C6 holds on 53 receipts without merchant regression.

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

Amount is INTEGER CENTS. "5.35" → 535. "169.78" → 16978. Ignore GST-summary pre-tax rows.

${LITE_COMMON}`;

// ── Round 5 winning additions ──
const C3 = `\n\nCATEGORY RULE — itemize then consolidate:\nStep 1: For each line item, assign {description, price, categoryId}. Step 2: Group by categoryId and sum. Step 3: Return one categoryAmounts entry per distinct categoryId.`;

const C4 = `\n\nCATEGORY RULE — use tax markers:\nReceipts often mark each item with tax codes (T, F, N, S, O). Taxed non-food items (T) typically → Home Supplies (30186) or Other (30426); non-taxed (N, F) → Groceries (22695).`;

const C6 = `\n\nCATEGORY RULE — detailed category→item mapping:\nFood/produce/meat/pantry → 22695 Groceries.\nBeverages from a cafe → 21716; bottled drinks from a supermarket → 22695.\nCleaning, paper towels, ziploc/foil, pet items → 30186 Home Supplies.\nBatteries, stationery, pens, office supplies → 30426 Other.\nKids' toys, school workbooks, kids clothes → 1276 Kid's Stuff.\nPharmacy/OTC medicine → 17351 Health/Pharmacy.\nFuel, parking, tolls → 48281 Transportation/Gas.\nWork safety gear, uniforms → 47837 Employment Expenses.\nHardware, electrical, lighting, paint → 30186 Home Supplies.`;

// ── Merchant-preservation variants for Round 6 ──
const MERCHANT_PRIORITY = `\n\nPRIORITY REMINDER: The merchant and amount fields are the most important — they determine bank-feed matching and budget accuracy. Do not compromise merchant or amount accuracy while attending to category work. The merchant MUST be the consumer brand (not a cashier name, not a customer name, not a translated English word when the original is Malay/Vietnamese).`;

const SHORTER_COMBO = `\n\nCATEGORY RULES (brief):\n- Return ONE categoryAmounts entry per distinct category (sum amounts).\n- Use tax markers as hints: T items → Home Supplies or Other; N/F → Groceries.\n- Food/produce → 22695; cleaning/hardware/pet → 30186; batteries/stationery → 30426; kids items → 1276; medicine → 17351; fuel/parking → 48281; restaurant meals → 21716; work gear → 47837.`;

const META_DIRECTIVE = `\n\nMETA RULE: These category rules must not degrade merchant, date, or amount accuracy. If applying the category rules would cause you to misread any other field, ignore the category rules for that field. Always prioritize: amount > merchant > date > category.`;

const TWOSTAGE_PASS1 = `Extract receipt data as JSON: {transcription, merchant, merchantLegalName?, date, amountCents (integer)}.

Stage 1: transcription = every line of the receipt as plain text.
Stage 2: merchant (consumer brand, preserved original language), date (YYYY-MM-DD), amountCents (integer, no fractional unit issues).

Do NOT categorize in this pass. Focus entirely on merchant, date, amount.

${LITE_COMMON}`;

const TWOSTAGE_PASS2 = (prior) => `Given this receipt image and its prior extraction {merchant: "${prior.merchant}", date: "${prior.date}", amountCents: ${prior.amountCents}}, return ONLY the categoryAmounts array as JSON {categoryAmounts: [{categoryId, amount}]}.

Group line items by category and return one entry per distinct category, summed. The sum must equal ${prior.amountCents / 100}.

${C6}`;

// ── 10 Round 6 test configurations ──
const TESTS = [
  { id: "R6-T1",  name: "LITE C3+C4+C6 on FULL 53",          model: LITE,  base: LITE_BASE,  add: C3 + C4 + C6,                               subset: "full" },
  { id: "R6-T2",  name: "FLASH C3+C4+C6 on FULL 53 ★",       model: FLASH, base: FLASH_BASE, add: C3 + C4 + C6,                               subset: "full" },
  { id: "R6-T3",  name: "FLASH C6 + merchant-priority",       model: FLASH, base: FLASH_BASE, add: C6 + MERCHANT_PRIORITY,                     subset: "hard" },
  { id: "R6-T4",  name: "LITE C4 + merchant-priority",        model: LITE,  base: LITE_BASE,  add: C4 + MERCHANT_PRIORITY,                     subset: "hard" },
  { id: "R6-T5",  name: "FLASH C3+C4+C6 + merchant-priority", model: FLASH, base: FLASH_BASE, add: C3 + C4 + C6 + MERCHANT_PRIORITY,           subset: "full" },
  { id: "R6-T6",  name: "LITE shorter combined directive",    model: LITE,  base: LITE_BASE,  add: SHORTER_COMBO,                              subset: "hard" },
  { id: "R6-T7",  name: "FLASH C3+C4+C6 + meta directive",   model: FLASH, base: FLASH_BASE, add: C3 + C4 + C6 + META_DIRECTIVE,              subset: "full" },
  { id: "R6-T8",  name: "LITE two-stage (MDA then cats)",     model: LITE,  twoStage: true,                                                     subset: "hard" },
  { id: "R6-T9",  name: "FLASH C3+C4+C6 @ temp 0.1",         model: FLASH, base: FLASH_BASE, add: C3 + C4 + C6,                               subset: "hard", temp: 0.1 },
  { id: "R6-T10", name: "FLASH C3+C4+C6 + 'merchant first'", model: FLASH, base: FLASH_BASE, add: "\n\nBEFORE extracting categories: extract merchant, date, and amount carefully. Those three fields are top priority.\n" + C3 + C4 + C6, subset: "hard" },
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

const TWOSTAGE_PASS1_SCHEMA = {
  type: "object",
  properties: {
    transcription: { type: "string" },
    merchant: { type: "string" }, merchantLegalName: { type: "string" },
    date: { type: "string" }, amountCents: { type: "integer" },
  },
  required: ["transcription", "merchant", "date", "amountCents"],
};

const TWOSTAGE_PASS2_SCHEMA = {
  type: "object",
  properties: {
    categoryAmounts: { type: "array", items: { type: "object", properties: { categoryId: { type: "integer" }, amount: { type: "number" } }, required: ["categoryId", "amount"] } },
  },
  required: ["categoryAmounts"],
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

async function runTwoStage(imageBytes, mimeType) {
  const p1 = await call({ model: LITE, imageBytes, mimeType, prompt: TWOSTAGE_PASS1, schema: TWOSTAGE_PASS1_SCHEMA });
  if (!p1.ok) return null;
  const first = p1.parsed;
  first.amount = first.amountCents / 100;
  const p2 = await call({ model: LITE, imageBytes, mimeType, prompt: TWOSTAGE_PASS2(first), schema: TWOSTAGE_PASS2_SCHEMA });
  if (p2.ok && p2.parsed?.categoryAmounts) first.categoryAmounts = p2.parsed.categoryAmounts;
  return first;
}

async function runTest(test, labels) {
  const stats = { m: 0, d: 0, a: 0, cs: 0, csh: 0, mcs: 0, mcsh: 0, total: 0, multiTotal: 0 };
  const schema = test.model === LITE ? LITE_SCHEMA : FLASH_SCHEMA;
  for (const label of labels) {
    const imgPath = path.join(ROOT, "test-data", "images", label.file);
    const imageBytes = fs.readFileSync(imgPath);
    const mimeType = mimeFor(label.file);
    let parsed;
    try {
      if (test.twoStage) parsed = await runTwoStage(imageBytes, mimeType);
      else parsed = (await call({ model: test.model, imageBytes, mimeType, prompt: test.base + test.add, schema, temp: test.temp || 0 })).parsed;
    } catch (e) { console.log(`  [err ${label.file}] ${e.message.slice(0, 50)}`); continue; }
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
  console.log(`Round 6 — validation + merchant preservation\nHard: ${hardSet.length} | Full English: ${fullEng.length}\n`);

  const results = [];
  for (const test of TESTS) {
    const receipts = test.subset === "full" ? fullEng : hardSet;
    const star = test.name.includes("★") ? " ★" : "";
    process.stdout.write(`${test.id.padEnd(8)} ${test.name.padEnd(42)}... `);
    const start = Date.now();
    const r = await runTest(test, receipts);
    const secs = ((Date.now() - start) / 1000).toFixed(0);
    const mp = (v) => v + "/" + r.total;
    console.log(`m${mp(r.m)} d${mp(r.d)} a${mp(r.a)} | cset${r.cs}/${r.total} cshr${r.csh}/${r.total} | mset${r.mcs}/${r.multiTotal} mshr${r.mcsh}/${r.multiTotal} | ${secs}s`);
    results.push({ test: { id: test.id, name: test.name, subset: test.subset }, r });
  }

  const outFile = path.join(ROOT, "results", `iterate-round6-${new Date().toISOString().replace(/[:.]/g,"-")}.json`);
  fs.writeFileSync(outFile, JSON.stringify({ round: 6, results }, null, 2));
  console.log(`\nSaved → ${path.relative(ROOT, outFile)}`);
}

main().catch(e => { console.error("Fatal:", e.stack || e.message); process.exit(1); });
