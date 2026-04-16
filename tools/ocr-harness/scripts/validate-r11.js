#!/usr/bin/env node
// Validation: run R11 (integer-cents + transcribe) on all 53 English receipts.
// Confirms the struggle-set win generalizes and doesn't regress previously-passing receipts.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import "dotenv/config";
import { GoogleGenAI } from "@google/genai";

import { TEST_CATEGORIES } from "../src/categories.js";
import { gradeResult, summarize, pct } from "../src/grader.js";

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), "..");
const LITE = "gemini-2.5-flash-lite";

const categoryList = TEST_CATEGORIES
  .map(c => c.tag ? `  - id=${c.id} name="${c.name}" tag="${c.tag}"` : `  - id=${c.id} name="${c.name}"`)
  .join("\n");

const COMMON_RULES = `- date MUST be YYYY-MM-DD ISO (never the original format). Parse DD/MM for non-US, MM/DD for US, then reformat.
- merchant is the consumer brand (McDonald's not GERBANG ALAF; Shell not CHOP YEW LIAN; VinMart not VinCommerce). Preserve original language.
- merchantLegalName is optional (legal entity if distinct).
- Do NOT return a cashier/customer personal name as merchant.
- Category ids must come from:
${categoryList}`;

const R11_PROMPT = `Extract receipt data as JSON: {transcription, merchant, merchantLegalName?, date, amountCents (integer), categoryAmounts?}.

Stage 1 — transcription: In the 'transcription' field, return a plain-text transcription of every text line on the receipt, in order, exactly as printed (headers, line items + prices, totals, cashier info, GST summary).
Stage 2 — extract: From your transcription, fill the remaining fields.

Amount is INTEGER CENTS. Examples: "5.35" → 535. "169.78" → 16978. "12.00" → 1200. Do not drop cent digits. Ignore GST-summary 'Total' rows (pre-tax net).

${COMMON_RULES}`;

const R11_SCHEMA = {
  type: "object",
  properties: {
    transcription: { type: "string" },
    merchant: { type: "string" },
    merchantLegalName: { type: "string" },
    date: { type: "string" },
    amountCents: { type: "integer" },
    categoryAmounts: { type: "array", items: { type: "object", properties: { categoryId: { type: "integer" }, amount: { type: "number" } }, required: ["categoryId", "amount"] } },
    lineItems: { type: "array", items: { type: "string" } },
    notes: { type: "string" },
  },
  required: ["transcription", "merchant", "date", "amountCents"],
};

const client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

async function call({ imageBytes, mimeType, prompt, temperature = 0, schema = R11_SCHEMA }) {
  let lastErr;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await client.models.generateContent({
        model: LITE,
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

function mimeFor(f) {
  const e = path.extname(f).toLowerCase();
  if (e === ".png") return "image/png";
  if (e === ".webp") return "image/webp";
  return "image/jpeg";
}

async function main() {
  const labels = JSON.parse(fs.readFileSync(path.join(ROOT, "test-data", "labels.json"), "utf8"));
  const english = labels.filter(l => l.source !== "MC-OCR");
  console.log(`Validating R11 on ${english.length} English receipts (${LITE})...\n`);

  const results = [];
  const misses = [];
  let totalLat = 0;

  for (let i = 0; i < english.length; i++) {
    const label = english[i];
    const imgPath = path.join(ROOT, "test-data", "images", label.file);
    const imageBytes = fs.readFileSync(imgPath);
    const mimeType = mimeFor(label.file);

    const start = Date.now();
    let extracted;
    try {
      const r = await call({ imageBytes, mimeType, prompt: R11_PROMPT });
      if (!r.ok) throw new Error(r.error);
      extracted = r.parsed;
      if (typeof extracted.amountCents === "number") extracted.amount = extracted.amountCents / 100;
    } catch (e) {
      console.log(`  [error] ${label.file}: ${e.message.slice(0, 60)}`);
      continue;
    }
    const elapsed = Date.now() - start;
    totalLat += elapsed;

    const grade = gradeResult(label, extracted);
    results.push({ label, extracted, grade, elapsed });

    const fails = [];
    if (!grade.merchant.pass) fails.push("M");
    if (!grade.date.pass) fails.push("D");
    if (!grade.amount.pass) fails.push("A");
    if (!grade.category.skipped && !grade.category.pass) fails.push("C");

    const mark = fails.length === 0 ? "✓" : `✗[${fails.join("")}]`;
    process.stdout.write(`${mark} `);
    if ((i + 1) % 10 === 0) process.stdout.write(`  ${i + 1}/${english.length}\n`);

    if (fails.length > 0) {
      misses.push({ file: label.file, fails: fails.join(""), expected: { m: label.merchant, d: label.date, a: label.amount, c: label.categoryId }, got: { m: extracted.merchant, d: extracted.date, a: extracted.amount, c: extracted.categoryAmounts?.map(x => x.categoryId) } });
    }
  }
  if (english.length % 10 !== 0) process.stdout.write("\n");

  const summary = summarize(results);
  const avgLat = (totalLat / results.length / 1000).toFixed(2);

  console.log("\n─── R11 on full English set ───");
  console.log(`  merchant  ${pct(summary.merchant.pass, summary.merchant.total)}  (${summary.merchant.pass}/${summary.merchant.total})`);
  console.log(`  date      ${pct(summary.date.pass, summary.date.total)}  (${summary.date.pass}/${summary.date.total})`);
  console.log(`  amount    ${pct(summary.amount.pass, summary.amount.total)}  (${summary.amount.pass}/${summary.amount.total})`);
  console.log(`  category  ${summary.category.total ? pct(summary.category.pass, summary.category.total) : "—"}  (${summary.category.pass}/${summary.category.total})`);
  console.log(`  avg latency  ${avgLat}s`);
  console.log();
  console.log("─── Baseline for comparison (Flash-Lite v0.4, pre-R11) ───");
  console.log("  merchant  92.5%  (49/53)");
  console.log("  date      96.2%  (51/53)");
  console.log("  amount    88.7%  (47/53) — note: some baseline scores used old labels");
  console.log("  category  77.4%  (41/53)");

  if (misses.length > 0) {
    console.log(`\n─── ${misses.length} miss(es) ───`);
    for (const m of misses) {
      console.log(`  [${m.fails}] ${m.file.padEnd(20)} exp ${JSON.stringify(m.expected).slice(0,50)}  got ${JSON.stringify(m.got).slice(0,50)}`);
    }
  }

  const outFile = path.join(ROOT, "results", `validate-r11-${new Date().toISOString().replace(/[:.]/g,"-")}.json`);
  fs.writeFileSync(outFile, JSON.stringify({ model: LITE, prompt: "R11", summary, results, misses }, null, 2));
  console.log(`\nSaved → ${path.relative(ROOT, outFile)}`);
}

main().catch(e => { console.error("Fatal:", e.stack || e.message); process.exit(1); });
