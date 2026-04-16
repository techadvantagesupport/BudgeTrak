#!/usr/bin/env node
// Round 2 iteration — 10 amount-focused experiments on Lite's English struggle set.
// All prompts explicitly enforce YYYY-MM-DD dates (fixes regression from Round 1).

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
const LITE_MODEL = "gemini-2.5-flash-lite";
const FLASH_MODEL = "gemini-2.5-flash";

const SUBSET = JSON.parse(fs.readFileSync("/tmp/lite-struggle-set.json", "utf8"));

const categoryList = TEST_CATEGORIES
  .map(c => c.tag ? `  - id=${c.id} name="${c.name}" tag="${c.tag}"` : `  - id=${c.id} name="${c.name}"`)
  .join("\n");

// Base directives we always want included (explicit YYYY-MM-DD; consumer brand; VND rule).
const COMMON_RULES = `- date MUST be returned as YYYY-MM-DD ISO format (example: "2018-03-14"), NEVER the original receipt format. Parse DD/MM/YYYY for non-US receipts and MM/DD/YYYY for US, then reformat to YYYY-MM-DD before returning.
- merchant is the consumer brand (McDonald's not GERBANG ALAF; Shell not CHOP YEW LIAN; VinMart not VinCommerce). Preserve original language; don't translate.
- merchantLegalName is optional — include it if the legal entity differs from the consumer brand.
- Do NOT return a cashier's or customer's personal name as merchant. Personal names appear near "Cashier:" or "Operator:" labels and are always wrong.
- If a required field is not visible, omit it rather than guessing.
- Category ids must come from this list (do not invent):
${categoryList}`;

// ── R1: compute-and-reconcile ──
const R1_PROMPT = `Extract receipt data as JSON: {merchant, merchantLegalName?, date, amount, categoryAmounts?}.

AMOUNT EXTRACTION (most important — read carefully):
- Identify the printed FINAL total (the amount the customer paid, including tax).
- Mentally sum the line-item prices and add tax — your sum should match the printed total within pennies.
- If your sum does NOT match the printed total, re-read the total line because you likely misread a digit.
- The total always has exactly 2 decimal places (e.g., 5.35, 169.80, 12.00). Never return 5.3 or 6 — always 5.35 or 6.00.
- Ignore any 'Total' row inside a GST/VAT summary table at the bottom — that's the pre-tax NET, not the transaction total.

${COMMON_RULES}`;

// ── R2: read-all-amounts-first ──
const R2_PROMPT = `Extract receipt data as JSON: {merchant, merchantLegalName?, date, amount, categoryAmounts?}.

AMOUNT EXTRACTION:
Before choosing the final total, mentally enumerate every dollar amount printed on the receipt (subtotal, tax, total, cash tendered, change, per-item prices). Identify which one is labeled as the final total (look for labels TOTAL, GRAND TOTAL, TOTAL DUE, TOTAL INCLUSIVE GST, TOTAL PAID, CASH). Pick that one. Read every digit including cents; never drop the decimal portion.

${COMMON_RULES}`;

// ── R3: cents-preservation strict ──
const R3_PROMPT = `Extract receipt data as JSON: {merchant, merchantLegalName?, date, amount, categoryAmounts?}.

AMOUNT RULE — CRITICAL:
The amount MUST have exactly 2 decimal places. These are WRONG:
  5.3  ✗    5  ✗    6  ✗    169.78  ✗ (if total is 169.80)
These are CORRECT:
  5.35  ✓    5.00  ✓    6.00  ✓    169.80  ✓
Even when the total ends in zero cents, return .00 explicitly. Read both cent digits. Do not round up, do not round down, do not merge adjacent digits. Preserve trailing zeros.
Ignore any GST-summary table 'Total' row — that's the pre-tax net.

${COMMON_RULES}`;

// ── R4: integer cents ──
const R4_PROMPT = `Extract receipt data as JSON: {merchant, merchantLegalName?, date, amountCents (integer), categoryAmounts?}.

AMOUNT EXTRACTION (integer cents representation):
- Return amount as INTEGER CENTS, not dollars with a decimal point.
- Examples: $5.35 → return 535. $169.80 → return 16980. $12.00 → return 1200. $1,234.56 → return 123456.
- Read both cent digits carefully. If the receipt says 5.35, return 535 (five hundred thirty-five cents), not 530 or 600.
- Ignore any GST-summary table 'Total' row — that's the pre-tax net.

${COMMON_RULES}`;
// Corresponding schema: amount replaced with amountCents (integer)
const R4_SCHEMA = {
  type: "object",
  properties: {
    merchant: { type: "string" },
    merchantLegalName: { type: "string" },
    date: { type: "string" },
    amountCents: { type: "integer" },
    categoryAmounts: {
      type: "array",
      items: { type: "object", properties: { categoryId: { type: "integer" }, amount: { type: "number" } }, required: ["categoryId", "amount"] },
    },
    lineItems: { type: "array", items: { type: "string" } },
    notes: { type: "string" },
  },
  required: ["merchant", "date", "amountCents"],
};

// ── R5: amount-first prompt structure ──
const R5_PROMPT = `You are reading a receipt. The SINGLE MOST IMPORTANT field to get right is the AMOUNT — everything else is secondary.

AMOUNT RULES (read before anything else):
1. Find the line labeled TOTAL, GRAND TOTAL, TOTAL DUE, TOTAL INCLUSIVE GST, or TOTAL PAID.
2. That is the amount. Not the subtotal. Not the pre-tax net. Not a line item.
3. Read every digit including both cent digits.
4. The amount always has exactly 2 decimal places.
5. Ignore any GST/VAT summary table at the bottom — the 'Total' row in that table is pre-tax net, NOT the transaction total.

Now extract the rest. Return JSON: {merchant, merchantLegalName?, date, amount, categoryAmounts?}.

${COMMON_RULES}`;

// ── R6: transcribe-then-extract ──
const R6_PROMPT = `Extract receipt data as JSON: {transcription, merchant, merchantLegalName?, date, amount, categoryAmounts?}.

Stage 1: In the 'transcription' field, return a plain-text transcription of every text line on the receipt, in order, exactly as printed. Include the header, line items with prices, all totals, cashier info, etc.
Stage 2: Then extract {merchant, date, amount, categoryAmounts?} from your transcription. Because you transcribed first, you'll read each character more carefully (e.g., TEO not TED; 5.35 not 6; 169.80 not 169.78).

${COMMON_RULES}`;
const R6_SCHEMA = {
  ...RESPONSE_SCHEMA,
  properties: { transcription: { type: "string" }, ...RESPONSE_SCHEMA.properties },
  required: ["transcription", "merchant", "date", "amount"],
};

// ── R7: focused amount re-ask with location hint ──
const R7_AMOUNT_REASK = `Re-examine ONLY the final total amount on this receipt and return JSON {"amount": <number>}.

The final total is on a line labeled TOTAL, GRAND TOTAL, TOTAL DUE, TOTAL INCLUSIVE GST, TOTAL PAID, or CASH — usually in bold or slightly larger font. It is NOT the SUBTOTAL, NOT a line item, and NOT any 'Total' row inside a GST/VAT summary table (that's pre-tax net).

Read BOTH cent digits carefully. The amount always has exactly 2 decimal places (e.g., 5.35, 169.80, 12.00 — never 5, 5.3, or 169.78 when the printed value is 169.80). Preserve trailing zeros.

Return ONLY {"amount": <number>}. No prose.`;

// ── R9: locale preamble ──
const R9_PROMPT = `Extract receipt data as JSON: {merchant, merchantLegalName?, date, amount, categoryAmounts?, notes?}.

FIRST: identify the locale.
- Look for currency symbol ($ = US; RM = Malaysia; S$ = Singapore; đ/VND = Vietnam; € = EU; £ = UK).
- Look for country/city in address.
- Determine date convention: US uses MM/DD/YYYY; Malaysia, Singapore, Vietnam, and most EU use DD/MM/YYYY.
- Determine number convention: US/UK use 1,234.56 (period decimal); Europe/Asia often use 1.234,56 (period thousand-separator); Vietnamese VND has no decimal at all.

THEN extract accordingly:
- amount: final total including tax, 2 decimal places (unless VND which is integer). Ignore GST-summary table 'Total' rows.
- date: convert to YYYY-MM-DD based on the locale you identified.
- merchant: consumer brand, preserved in original language.

Note the detected locale in the 'notes' field (e.g., "US receipt", "Malaysian receipt").

${COMMON_RULES}`;

// ── R10: amount as string ──
const R10_PROMPT = `Extract receipt data as JSON: {merchant, merchantLegalName?, date, amount (string), categoryAmounts?}.

Return amount as a STRING EXACTLY as printed on the receipt, preserving the original digits and decimal point. Examples:
- Receipt shows "5.35"  → return "5.35"
- Receipt shows "169.80" → return "169.80"  (keep trailing zero)
- Receipt shows "6.00"  → return "6.00"  (do not shorten to "6")
- Receipt shows "11,616" → return "11616"  (strip commas but keep digits)

Ignore any GST-summary table 'Total' row.

${COMMON_RULES}`;
const R10_SCHEMA = {
  ...RESPONSE_SCHEMA,
  properties: { ...RESPONSE_SCHEMA.properties, amount: { type: "string" } },
};

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

// ── Test runners ──
function mimeFor(f) {
  const e = path.extname(f).toLowerCase();
  if (e === ".png") return "image/png";
  if (e === ".webp") return "image/webp";
  return "image/jpeg";
}

// R8 hybrid: Lite for everything, Flash for amount only.
const FLASH_AMOUNT_PROMPT = `Return ONLY the final total paid on this receipt as JSON {"amount": <number>}.

Read the TOTAL line (after labels like TOTAL / GRAND TOTAL / TOTAL INCLUSIVE GST / TOTAL DUE / CASH). Use 2 decimal places. Do not return a subtotal or a GST-summary net amount. Return ONLY {"amount": <number>}.`;

const AMOUNT_SCHEMA = { type: "object", properties: { amount: { type: "number" } }, required: ["amount"] };

const TESTS = [
  // name                                        runner (returns parsed result or throws)
  ["R1 compute-and-reconcile",       async (img, mt) => (await call({ model: LITE_MODEL, imageBytes: img, mimeType: mt, prompt: R1_PROMPT })).parsed],
  ["R2 read-all-amounts-first",      async (img, mt) => (await call({ model: LITE_MODEL, imageBytes: img, mimeType: mt, prompt: R2_PROMPT })).parsed],
  ["R3 cents-preservation strict",   async (img, mt) => (await call({ model: LITE_MODEL, imageBytes: img, mimeType: mt, prompt: R3_PROMPT })).parsed],
  ["R4 integer-cents",               async (img, mt) => {
    const r = (await call({ model: LITE_MODEL, imageBytes: img, mimeType: mt, prompt: R4_PROMPT, schema: R4_SCHEMA })).parsed;
    if (r && typeof r.amountCents === "number") r.amount = r.amountCents / 100;
    return r;
  }],
  ["R5 amount-first structure",      async (img, mt) => (await call({ model: LITE_MODEL, imageBytes: img, mimeType: mt, prompt: R5_PROMPT })).parsed],
  ["R6 transcribe-then-extract",     async (img, mt) => (await call({ model: LITE_MODEL, imageBytes: img, mimeType: mt, prompt: R6_PROMPT, schema: R6_SCHEMA })).parsed],
  ["R7 focused amount re-ask+loc",   async (img, mt) => {
    const first = (await call({ model: LITE_MODEL, imageBytes: img, mimeType: mt, prompt: buildPrompt(TEST_CATEGORIES) })).parsed;
    const amt = (await call({ model: LITE_MODEL, imageBytes: img, mimeType: mt, prompt: R7_AMOUNT_REASK, schema: AMOUNT_SCHEMA })).parsed;
    return { ...first, amount: amt?.amount ?? first.amount };
  }],
  ["R8 hybrid Lite+Flash(amount)",   async (img, mt) => {
    const liteResult = (await call({ model: LITE_MODEL, imageBytes: img, mimeType: mt, prompt: buildPrompt(TEST_CATEGORIES) })).parsed;
    const flashAmount = (await call({ model: FLASH_MODEL, imageBytes: img, mimeType: mt, prompt: FLASH_AMOUNT_PROMPT, schema: AMOUNT_SCHEMA })).parsed;
    return { ...liteResult, amount: flashAmount?.amount ?? liteResult.amount };
  }],
  ["R9 locale-preamble",             async (img, mt) => (await call({ model: LITE_MODEL, imageBytes: img, mimeType: mt, prompt: R9_PROMPT })).parsed],
  ["R10 amount-as-string",           async (img, mt) => {
    const r = (await call({ model: LITE_MODEL, imageBytes: img, mimeType: mt, prompt: R10_PROMPT, schema: R10_SCHEMA })).parsed;
    if (r && typeof r.amount === "string") {
      const cleaned = r.amount.replace(/[^\d\.\-]/g, "");
      r.amount = parseFloat(cleaned);
    }
    return r;
  }],
];

async function runTest([name, runner], labels) {
  const stats = { name, m: 0, d: 0, a: 0, total: 0, calls: 0, misses: [] };
  for (const label of labels) {
    const imgPath = path.join(ROOT, "test-data", "images", label.file);
    const imageBytes = fs.readFileSync(imgPath);
    const mimeType = mimeFor(label.file);

    let extracted;
    try { extracted = await runner(imageBytes, mimeType); }
    catch (e) { console.log(`    [error ${label.file}] ${e.message.slice(0, 80)}`); continue; }
    if (!extracted) continue;
    stats.calls += name.includes("hybrid") || name.includes("re-ask") ? 2 : 1;

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
  console.log(`Round 2 — Lite(${LITE_MODEL}) amount-focused experiments\nSubset: ${subset.length} receipts\n`);

  const results = [];
  for (const test of TESTS) {
    process.stdout.write(`${test[0].padEnd(34)}... `);
    const start = Date.now();
    const r = await runTest(test, subset);
    const secs = ((Date.now() - start) / 1000).toFixed(1);
    console.log(`m ${r.m}/${r.total}  d ${r.d}/${r.total}  a ${r.a}/${r.total}  total ${r.m + r.d + r.a}/36  (${secs}s)`);
    results.push(r);
  }

  // Amount-only miss detail
  console.log("\n── Amount misses only (highest-value field) ──");
  for (const r of results) {
    const amountMisses = r.misses.filter(m => m.fails.includes("A"));
    if (amountMisses.length === 0) {
      console.log(`\n${r.name}: NO AMOUNT MISSES 🎯`);
      continue;
    }
    console.log(`\n${r.name} — ${amountMisses.length} amount miss(es):`);
    for (const m of amountMisses) {
      console.log(`  ${m.file}  exp ${m.exp.a}  got ${m.got.a}`);
    }
  }

  const outFile = path.join(ROOT, "results", `iterate-round2-${new Date().toISOString().replace(/[:.]/g,"-")}.json`);
  fs.writeFileSync(outFile, JSON.stringify({ round: 2, results }, null, 2));
  console.log(`\nSaved → ${path.relative(ROOT, outFile)}`);
}

main().catch(e => { console.error("Fatal:", e.stack || e.message); process.exit(1); });
