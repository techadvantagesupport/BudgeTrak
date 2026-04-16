#!/usr/bin/env node
// Round 3 — combinations of Round 2 winners (R4 integer-cents, R6 transcribe,
// R8 Flash-cross-check) plus targeted fixes. Includes R16 (label audit for
// sroie_0024) as a pre-step already applied to labels.json.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import "dotenv/config";
import { GoogleGenAI } from "@google/genai";

import { TEST_CATEGORIES } from "../src/categories.js";
import { RESPONSE_SCHEMA } from "../src/schema.js";
import { buildPrompt } from "../src/prompt.js";
import { gradeResult } from "../src/grader.js";

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), "..");
const LITE = "gemini-2.5-flash-lite";
const FLASH = "gemini-2.5-flash";

const SUBSET = JSON.parse(fs.readFileSync("/tmp/lite-struggle-set.json", "utf8"));

const categoryList = TEST_CATEGORIES
  .map(c => c.tag ? `  - id=${c.id} name="${c.name}" tag="${c.tag}"` : `  - id=${c.id} name="${c.name}"`)
  .join("\n");

const COMMON_RULES = `- date MUST be YYYY-MM-DD ISO (never the original format). Parse DD/MM for non-US, MM/DD for US, then reformat.
- merchant is the consumer brand (McDonald's not GERBANG ALAF; Shell not CHOP YEW LIAN; VinMart not VinCommerce). Preserve original language.
- merchantLegalName is optional (legal entity if distinct).
- Do NOT return a cashier/customer personal name as merchant.
- Category ids must come from:
${categoryList}`;

// ── Winning R4 prompt (integer cents) reused as base for combinations ──
const R4_BASE = `Extract receipt data as JSON: {merchant, merchantLegalName?, date, amountCents (integer), categoryAmounts?}.

AMOUNT (integer cents):
- Return amount as INTEGER CENTS, not dollars with a decimal point.
- Examples: $5.35 → 535. $169.78 → 16978. $12.00 → 1200. $1,234.56 → 123456.
- Read BOTH cent digits carefully. Do not drop or round.
- Ignore any 'Total' row inside a GST/VAT summary table (that's pre-tax net).

${COMMON_RULES}`;

const R4_SCHEMA = {
  type: "object",
  properties: {
    merchant: { type: "string" },
    merchantLegalName: { type: "string" },
    date: { type: "string" },
    amountCents: { type: "integer" },
    categoryAmounts: { type: "array", items: { type: "object", properties: { categoryId: { type: "integer" }, amount: { type: "number" } }, required: ["categoryId", "amount"] } },
    lineItems: { type: "array", items: { type: "string" } },
    notes: { type: "string" },
  },
  required: ["merchant", "date", "amountCents"],
};

// ── R11: R4 + R6 combined (integer cents + transcribe) ──
const R11_PROMPT = `Extract receipt data as JSON: {transcription, merchant, merchantLegalName?, date, amountCents (integer), categoryAmounts?}.

Stage 1 — transcription: In the 'transcription' field, return a plain-text transcription of every text line on the receipt, in order, exactly as printed (headers, line items + prices, totals, cashier info, GST summary).
Stage 2 — extract: From your transcription, fill the remaining fields.

Amount is INTEGER CENTS. Examples: "5.35" → 535. "169.78" → 16978. "12.00" → 1200. Do not drop cent digits. Ignore GST-summary 'Total' rows (pre-tax net).

${COMMON_RULES}`;
const R11_SCHEMA = { ...R4_SCHEMA, properties: { transcription: { type: "string" }, ...R4_SCHEMA.properties }, required: ["transcription", "merchant", "date", "amountCents"] };

// ── R12: R4 + Flash cross-check on amount ──
const FLASH_AMOUNT_PROMPT = `Return ONLY the final total paid on this receipt as JSON {"amountCents": <integer>}.

Read the TOTAL line (after labels TOTAL / GRAND TOTAL / TOTAL INCLUSIVE GST / TOTAL DUE / CASH). Return INTEGER CENTS. $5.35 → 535. $169.78 → 16978. Do not return a subtotal or GST-summary pre-tax net. Return ONLY {"amountCents": <integer>}.`;
const AMOUNT_CENTS_SCHEMA = { type: "object", properties: { amountCents: { type: "integer" } }, required: ["amountCents"] };

// ── R13: R4 + GST emphasis ──
const R13_PROMPT = R4_BASE + `

IMPORTANT — the GST-SUMMARY trap:
Many receipts print a GST/VAT/Tax summary table near the bottom with columns like "Amount(RM) | Tax(RM)" and a "Total" row. That 'Total' is the PRE-TAX NET amount — it is NOT the transaction total and should be IGNORED.
The TRANSACTION TOTAL is printed ABOVE this summary, on a line labeled Total Sales (Inclusive GST), Total, Grand Total, or Total Inclusive. It's the amount the customer actually paid.
Example: receipt shows "Total Sales (Inclusive GST) 12.25" above, and "GST Summary / Total 11.55 / Tax 0.70" below. Return 1225 (integer cents of 12.25), NOT 1155.`;

// ── R14: R4 with few-shot cents preservation examples ──
const R14_PROMPT = R4_BASE + `

Examples of CORRECT integer-cents extraction:
  Receipt shows: "TOTAL ... 5.35"       → amountCents: 535 ✓ (NOT 500 or 600)
  Receipt shows: "TOTAL ... 169.78"     → amountCents: 16978 ✓ (NOT 16980 or 17000)
  Receipt shows: "TOTAL ... 6.00"       → amountCents: 600 ✓ (NOT 6)
  Receipt shows: "CASH  RM 12.25"       → amountCents: 1225 ✓
  Receipt shows: "TOTAL $1,234.56"      → amountCents: 123456 ✓ (strip commas first)

Common mistakes to avoid:
  ✗ Reading "5.35" and returning 6 (rounded up)
  ✗ Reading "5.35" and returning 500 or 535000 (wrong multiplier)
  ✗ Reading "169.78" and returning 17000 or 169 (dropped cents)`;

// ── R15: R4 + merchant re-ask ──
const MERCHANT_REASK = (prior) => `Re-examine this receipt and return ONLY the merchant (business/retailer name) as JSON: {"merchant": "<consumer brand>"}.

Rules: Consumer brand the shopper would recognize (McDonald's / Shell / VinMart — NOT the legal entity GERBANG ALAF / CHOP YEW LIAN / VinCommerce). Preserve original language. Do NOT return a cashier's or customer's personal name. The merchant was previously extracted as "${prior}"; verify or correct.

Return ONLY {"merchant": "<name>"}. No prose.`;
const MERCHANT_SCHEMA = { type: "object", properties: { merchant: { type: "string" } }, required: ["merchant"] };

// ── R17: R4 at temp 0.3, 2-pass consistency ──
// Implemented inline below

// ── R18: R6 + integer amount (transcribe with integer cents) ──
// Same as R11 effectively. Let me differentiate R18: transcribe THEN confirm amount from transcription.
const R18_PROMPT = `Extract receipt data as JSON: {transcription, amountLineRaw, merchant, merchantLegalName?, date, amountCents (integer), categoryAmounts?}.

Stage 1: 'transcription' = plain-text transcription of every receipt line, exactly as printed.
Stage 2: 'amountLineRaw' = verbatim copy of the specific line containing the final total (e.g., "Total Sales (Inclusive GST) RM 169.78").
Stage 3: from 'amountLineRaw', extract the amount as integer cents. $5.35 → 535; $169.78 → 16978.
Stage 4: fill remaining fields.

Ignore GST-summary 'Total' rows (pre-tax net).

${COMMON_RULES}`;
const R18_SCHEMA = {
  ...R4_SCHEMA,
  properties: { transcription: { type: "string" }, amountLineRaw: { type: "string" }, ...R4_SCHEMA.properties },
  required: ["transcription", "amountLineRaw", "merchant", "date", "amountCents"],
};

// ── R19: Conditional hybrid ──
// Lite first. If amount looks suspicious (< $2, or GST summary detected, or certain keywords in lineItems), re-ask on Flash.

// ── R20: Triple combo R4 + R6 + Flash cross-check ──

// ── Gemini call ──
const client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

async function call({ model, imageBytes, mimeType, prompt, temperature = 0, schema = RESPONSE_SCHEMA }) {
  let lastErr;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await client.models.generateContent({
        model,
        contents: [{ role: "user", parts: [{ text: prompt }, { inlineData: { mimeType, data: imageBytes.toString("base64") } }] }],
        config: { responseMimeType: "application/json", responseSchema: schema, temperature },
      });
      try { return { ok: true, parsed: JSON.parse(res.text) }; }
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

function normalizeAmountCents(r) {
  if (r && typeof r.amountCents === "number") r.amount = r.amountCents / 100;
  return r;
}

// ── Test runners ──
const TESTS = [
  ["R11 R4+R6 integer+transcribe",   async (img, mt) => normalizeAmountCents((await call({ model: LITE, imageBytes: img, mimeType: mt, prompt: R11_PROMPT, schema: R11_SCHEMA })).parsed)],
  ["R12 R4 Lite + Flash amount-check", async (img, mt) => {
    const r = normalizeAmountCents((await call({ model: LITE, imageBytes: img, mimeType: mt, prompt: R4_BASE, schema: R4_SCHEMA })).parsed);
    const f = (await call({ model: FLASH, imageBytes: img, mimeType: mt, prompt: FLASH_AMOUNT_PROMPT, schema: AMOUNT_CENTS_SCHEMA })).parsed;
    if (f?.amountCents != null) r.amount = f.amountCents / 100;
    return r;
  }],
  ["R13 R4 + GST emphasis",          async (img, mt) => normalizeAmountCents((await call({ model: LITE, imageBytes: img, mimeType: mt, prompt: R13_PROMPT, schema: R4_SCHEMA })).parsed)],
  ["R14 R4 + few-shot cents",        async (img, mt) => normalizeAmountCents((await call({ model: LITE, imageBytes: img, mimeType: mt, prompt: R14_PROMPT, schema: R4_SCHEMA })).parsed)],
  ["R15 R4 + merchant re-ask",       async (img, mt) => {
    const r = normalizeAmountCents((await call({ model: LITE, imageBytes: img, mimeType: mt, prompt: R4_BASE, schema: R4_SCHEMA })).parsed);
    const m = (await call({ model: LITE, imageBytes: img, mimeType: mt, prompt: MERCHANT_REASK(r?.merchant), schema: MERCHANT_SCHEMA })).parsed;
    if (m?.merchant) r.merchant = m.merchant;
    return r;
  }],
  ["R16 label-audit (already done)", async (img, mt) => normalizeAmountCents((await call({ model: LITE, imageBytes: img, mimeType: mt, prompt: R4_BASE, schema: R4_SCHEMA })).parsed)], // re-run R4 baseline to measure audit impact
  ["R17 R4 at temp 0.3 2-pass",      async (img, mt) => {
    const a = normalizeAmountCents((await call({ model: LITE, imageBytes: img, mimeType: mt, prompt: R4_BASE, schema: R4_SCHEMA, temperature: 0 })).parsed);
    const b = normalizeAmountCents((await call({ model: LITE, imageBytes: img, mimeType: mt, prompt: R4_BASE, schema: R4_SCHEMA, temperature: 0.3 })).parsed);
    // If agree → use a. If disagree on amount → take the one whose cents aren't ".00" (suspicious dropped cents).
    if (Math.abs((a.amount ?? 0) - (b.amount ?? 0)) <= 0.01) return a;
    const aDropped = Number.isInteger(a.amount);  // looks like dropped cents
    const bDropped = Number.isInteger(b.amount);
    if (aDropped && !bDropped) return { ...a, amount: b.amount };
    if (!aDropped && bDropped) return a;
    // Otherwise take a (temp 0 default)
    return a;
  }],
  ["R18 R6 + amountLineRaw + integer", async (img, mt) => normalizeAmountCents((await call({ model: LITE, imageBytes: img, mimeType: mt, prompt: R18_PROMPT, schema: R18_SCHEMA })).parsed)],
  ["R19 conditional hybrid",          async (img, mt) => {
    const r = normalizeAmountCents((await call({ model: LITE, imageBytes: img, mimeType: mt, prompt: R4_BASE, schema: R4_SCHEMA })).parsed);
    // Heuristics for "suspicious amount":
    const suspicious =
      !Number.isFinite(r.amount) ||
      r.amount < 2 ||                             // very small totals often wrong
      (Math.round(r.amount * 100) % 100 === 0) || // ends in .00 (possibly dropped cents)
      (r.lineItems && r.lineItems.some(l => /gst|vat|tax summary/i.test(l))); // GST summary detected
    if (suspicious) {
      const f = (await call({ model: FLASH, imageBytes: img, mimeType: mt, prompt: FLASH_AMOUNT_PROMPT, schema: AMOUNT_CENTS_SCHEMA })).parsed;
      if (f?.amountCents != null) r.amount = f.amountCents / 100;
    }
    return r;
  }],
  ["R20 triple R4+R6+Flash amount",  async (img, mt) => {
    const r = normalizeAmountCents((await call({ model: LITE, imageBytes: img, mimeType: mt, prompt: R11_PROMPT, schema: R11_SCHEMA })).parsed);
    const f = (await call({ model: FLASH, imageBytes: img, mimeType: mt, prompt: FLASH_AMOUNT_PROMPT, schema: AMOUNT_CENTS_SCHEMA })).parsed;
    if (f?.amountCents != null) r.amount = f.amountCents / 100;
    return r;
  }],
];

function mimeFor(f) {
  const e = path.extname(f).toLowerCase();
  if (e === ".png") return "image/png";
  if (e === ".webp") return "image/webp";
  return "image/jpeg";
}

async function runTest([name, runner], labels) {
  const stats = { name, m: 0, d: 0, a: 0, total: 0, misses: [] };
  for (const label of labels) {
    const imgPath = path.join(ROOT, "test-data", "images", label.file);
    const imageBytes = fs.readFileSync(imgPath);
    const mimeType = mimeFor(label.file);

    let extracted;
    try { extracted = await runner(imageBytes, mimeType); }
    catch (e) { console.log(`    [error ${label.file}] ${e.message.slice(0, 80)}`); continue; }
    if (!extracted) continue;

    const grade = gradeResult(label, extracted);
    stats.total++;
    if (grade.merchant.pass) stats.m++;
    if (grade.date.pass) stats.d++;
    if (grade.amount.pass) stats.a++;
    if (!grade.merchant.pass || !grade.date.pass || !grade.amount.pass) {
      const fails = [];
      if (!grade.merchant.pass) fails.push("M");
      if (!grade.date.pass) fails.push("D");
      if (!grade.amount.pass) fails.push("A");
      stats.misses.push({ file: label.file, fails: fails.join(""), exp: { m: label.merchant, d: label.date, a: label.amount }, got: { m: extracted.merchant, d: extracted.date, a: extracted.amount } });
    }
  }
  return stats;
}

async function main() {
  const labels = JSON.parse(fs.readFileSync(path.join(ROOT, "test-data", "labels.json"), "utf8"));
  const subset = labels.filter(l => SUBSET.includes(l.file));
  console.log(`Round 3 — 10 tests on Lite's English struggle set\nSubset: ${subset.length} receipts\nR16 (label audit for sroie_0024) already applied → running as R4 baseline for comparison\n`);

  const results = [];
  for (const test of TESTS) {
    process.stdout.write(`${test[0].padEnd(38)}... `);
    const start = Date.now();
    const r = await runTest(test, subset);
    const secs = ((Date.now() - start) / 1000).toFixed(1);
    console.log(`m ${r.m}/${r.total}  d ${r.d}/${r.total}  a ${r.a}/${r.total}  total ${r.m + r.d + r.a}/36  (${secs}s)`);
    results.push(r);
  }

  console.log("\n── Remaining misses (all fields) ──");
  for (const r of results) {
    if (r.misses.length === 0) { console.log(`\n${r.name}: ALL PASS ✓`); continue; }
    console.log(`\n${r.name} — ${r.misses.length} miss(es):`);
    for (const m of r.misses) {
      console.log(`  ${m.fails.padEnd(3)} ${m.file}  exp ${JSON.stringify(m.exp).slice(0,55)}  got ${JSON.stringify(m.got).slice(0,55)}`);
    }
  }

  const outFile = path.join(ROOT, "results", `iterate-round3-${new Date().toISOString().replace(/[:.]/g,"-")}.json`);
  fs.writeFileSync(outFile, JSON.stringify({ round: 3, results }, null, 2));
  console.log(`\nSaved → ${path.relative(ROOT, outFile)}`);
}

main().catch(e => { console.error("Fatal:", e.stack || e.message); process.exit(1); });
