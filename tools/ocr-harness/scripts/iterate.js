#!/usr/bin/env node
// Iteration loop for Flash-Lite improvement experiments. Runs a curated list
// of test configurations (prompt variants + re-ask strategies) against a
// subset of receipts Lite struggled with, then prints a comparison matrix.
//
// Cost per iteration round: ~12 receipts × ~10 configs × ~$0.0003 avg ≈ $0.04.

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
const MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash-lite";

// ── Subset of receipts to iterate on ──
const SUBSET = JSON.parse(fs.readFileSync("/tmp/lite-struggle-set.json", "utf8"));

// ── Prompt variants ──
const categoryList = TEST_CATEGORIES
  .map(c => c.tag ? `  - id=${c.id} name="${c.name}" tag="${c.tag}"` : `  - id=${c.id} name="${c.name}"`)
  .join("\n");

const PROMPTS = {
  baseline: () => buildPrompt(TEST_CATEGORIES),

  terse: () => `Extract receipt data as JSON: {merchant, merchantLegalName (optional), date (YYYY-MM-DD), amount (number), categoryAmounts (optional array of {categoryId, amount})}.

Rules:
- merchant: consumer brand (McDonald's not GERBANG ALAF; Shell not CHOP YEW LIAN; VinMart not VinCommerce). Preserve original language; don't translate.
- merchantLegalName: the legal operator entity if distinct, optional.
- date: DD/MM/YYYY for non-US receipts (Malaysia, Singapore, Vietnam, Europe), MM/DD/YYYY for US.
- amount: final total including tax. Ignore 'Total' inside GST summary tables — that's pre-tax net. VND dots are thousand separators: 49.500 VND = 49500.
- Read each digit carefully before returning.

Categories:
${categoryList}

Omit fields that aren't visible.`,

  cot: () => buildPrompt(TEST_CATEGORIES) + `

Before returning JSON, reason step-by-step:
1. Identify the merchant header and what consumer brand it represents.
2. Locate the transaction date and determine the locale format.
3. Find the final total (not the GST summary net; not a line-item amount).
4. Read the total character by character and confirm.
5. Then output the JSON.`,

  fewshot: () => buildPrompt(TEST_CATEGORIES) + `

Example of correct extraction:
Receipt: "MCDONALDS 1234 / 04/13/2026 / Total $8.47"
Output: {"merchant":"McDonald's","date":"2026-04-13","amount":8.47,"categoryAmounts":[{"categoryId":21716,"amount":8.47}]}

Example with split and legal name:
Receipt: "GERBANG ALAF RESTAURANTS SDN BHD (McDonald's) 09/02/2018 TOTAL RM 38.90"
Output: {"merchant":"McDonald's","merchantLegalName":"GERBANG ALAF RESTAURANTS SDN BHD","date":"2018-02-09","amount":38.90,"categoryAmounts":[{"categoryId":21716,"amount":38.90}]}`,

  persona: () => `You are a meticulous bookkeeper who reads every receipt carefully and triple-checks every total. You never guess at digits. When reading an amount you pronounce each digit to yourself before writing it down. You know that dropping cents or misreading a digit causes downstream budget errors that frustrate users.

` + buildPrompt(TEST_CATEGORIES),
};

// ── Focused re-ask prompts ──
const AMOUNT_REASK = (priorAmount) => `Re-examine this receipt and return ONLY the final total paid as JSON: {"amount": <number>}.

Read each digit of the total carefully. Include cents. Don't return a pre-tax subtotal or the GST-summary net. For VND receipts, dots are thousand separators — return the integer value. The total was previously extracted as ${priorAmount}; verify or correct.

Return ONLY the JSON object {"amount": <number>}. No prose.`;

const MERCHANT_REASK = (priorMerchant) => `Re-examine this receipt and return ONLY the merchant (business/retailer name) as JSON: {"merchant": "<consumer brand>"}.

Rules: Use the consumer brand the shopper would recognize (McDonald's, Shell, VinMart — NOT the legal entity GERBANG ALAF / CHOP YEW LIAN / VinCommerce). Preserve the original language; don't translate. Do not return a cashier's name, customer name, or any person's name — those are NOT the merchant. The merchant was previously extracted as "${priorMerchant}"; verify or correct.

Return ONLY the JSON object {"merchant": "<name>"}. No prose.`;

// ── Simplified schemas for re-asks ──
const AMOUNT_SCHEMA = { type: "object", properties: { amount: { type: "number" } }, required: ["amount"] };
const MERCHANT_SCHEMA = { type: "object", properties: { merchant: { type: "string" } }, required: ["merchant"] };

// ── Gemini call wrapper ──
const client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

async function call({ imageBytes, mimeType, prompt, temperature = 0, schema = RESPONSE_SCHEMA }) {
  let lastErr;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await client.models.generateContent({
        model: MODEL,
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
      const delay = 500 * Math.pow(2, attempt - 1);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

// ── Re-ask strategies ──
const REASKS = {
  "none": async () => null,

  "schema-gap": async (firstResp, imageBytes, mimeType) => {
    const p = firstResp.parsed || {};
    if (!p.merchant || p.merchant.trim() === "") {
      const r = await call({ imageBytes, mimeType, prompt: MERCHANT_REASK(p.merchant), schema: MERCHANT_SCHEMA });
      if (r.ok) return { merchant: r.parsed.merchant };
    }
    if (!Number.isFinite(p.amount) || p.amount <= 0) {
      const r = await call({ imageBytes, mimeType, prompt: AMOUNT_REASK(p.amount), schema: AMOUNT_SCHEMA });
      if (r.ok) return { amount: r.parsed.amount };
    }
    return null;
  },

  "always-amount": async (firstResp, imageBytes, mimeType) => {
    const p = firstResp.parsed || {};
    const r = await call({ imageBytes, mimeType, prompt: AMOUNT_REASK(p.amount), schema: AMOUNT_SCHEMA });
    if (r.ok) return { amount: r.parsed.amount };
    return null;
  },

  "always-merchant": async (firstResp, imageBytes, mimeType) => {
    const p = firstResp.parsed || {};
    const r = await call({ imageBytes, mimeType, prompt: MERCHANT_REASK(p.merchant), schema: MERCHANT_SCHEMA });
    if (r.ok) return { merchant: r.parsed.merchant };
    return null;
  },

  "two-pass": async (firstResp, imageBytes, mimeType, promptFn) => {
    // First call was at temp 0; do a second at temp 0.3; if amount disagrees do a 3rd focused.
    const r2 = await call({ imageBytes, mimeType, prompt: promptFn(), temperature: 0.3 });
    if (!r2.ok) return null;
    const a1 = firstResp.parsed?.amount;
    const a2 = r2.parsed?.amount;
    if (Number.isFinite(a1) && Number.isFinite(a2) && Math.abs(a1 - a2) <= 0.01) {
      return null; // consensus — keep first
    }
    // Disagree → focused 3rd
    const r3 = await call({ imageBytes, mimeType, prompt: AMOUNT_REASK(`${a1} or ${a2}`), schema: AMOUNT_SCHEMA });
    if (r3.ok) return { amount: r3.parsed.amount };
    return { amount: a2 }; // fallback to temp 0.3 answer
  },
};

// ── Test configurations ──
const TESTS = [
  { id: "T1",  name: "baseline v0.4",         prompt: "baseline", reask: "none",            temp: 0 },
  { id: "T2",  name: "terse prompt",          prompt: "terse",    reask: "none",            temp: 0 },
  { id: "T3",  name: "CoT prompt",            prompt: "cot",      reask: "none",            temp: 0 },
  { id: "T4",  name: "few-shot prompt",       prompt: "fewshot",  reask: "none",            temp: 0 },
  { id: "T5",  name: "meticulous persona",    prompt: "persona",  reask: "none",            temp: 0 },
  { id: "T6",  name: "schema-gap re-ask",     prompt: "baseline", reask: "schema-gap",      temp: 0 },
  { id: "T7",  name: "always amount re-ask",  prompt: "baseline", reask: "always-amount",   temp: 0 },
  { id: "T8",  name: "always merchant re-ask",prompt: "baseline", reask: "always-merchant", temp: 0 },
  { id: "T9",  name: "terse + amount re-ask", prompt: "terse",    reask: "always-amount",   temp: 0 },
  { id: "T10", name: "self-consistency 2pass",prompt: "baseline", reask: "two-pass",        temp: 0 },
];

// ── Runner ──
function mimeFor(f) {
  const e = path.extname(f).toLowerCase();
  if (e === ".png") return "image/png";
  if (e === ".webp") return "image/webp";
  return "image/jpeg";
}

async function runTest(test, labels) {
  const stats = { id: test.id, name: test.name, m: 0, d: 0, a: 0, c: 0, ct: 0, total: 0, calls: 0, misses: [] };
  for (const label of labels) {
    const imgPath = path.join(ROOT, "test-data", "images", label.file);
    const imageBytes = fs.readFileSync(imgPath);
    const mimeType = mimeFor(label.file);

    const promptFn = PROMPTS[test.prompt];
    const first = await call({ imageBytes, mimeType, prompt: promptFn(), temperature: test.temp });
    stats.calls++;
    if (!first.ok) { continue; }

    let merged = { ...first.parsed };
    const reaskFn = REASKS[test.reask];
    const reaskResult = await reaskFn(first, imageBytes, mimeType, promptFn);
    if (reaskResult) {
      // Count however many extra calls the re-ask used (best-effort)
      stats.calls += test.reask === "two-pass" ? 1 : 1;
      if (test.reask === "two-pass") {
        // Might have been 1 or 2 extra; this is approximate
      }
      for (const k of Object.keys(reaskResult)) {
        if (reaskResult[k] !== undefined && reaskResult[k] !== null) merged[k] = reaskResult[k];
      }
    }

    const grade = gradeResult(label, merged);
    stats.total++;
    if (grade.merchant.pass) stats.m++;
    if (grade.date.pass) stats.d++;
    if (grade.amount.pass) stats.a++;
    if (!grade.category.skipped) { stats.ct++; if (grade.category.pass) stats.c++; }

    if (!grade.merchant.pass || !grade.date.pass || !grade.amount.pass) {
      const fails = [];
      if (!grade.merchant.pass) fails.push("M");
      if (!grade.date.pass) fails.push("D");
      if (!grade.amount.pass) fails.push("A");
      stats.misses.push({ file: label.file, fails: fails.join(""), exp: { m: label.merchant, d: label.date, a: label.amount }, got: { m: merged.merchant, d: merged.date, a: merged.amount } });
    }
  }
  return stats;
}

async function main() {
  const labels = JSON.parse(fs.readFileSync(path.join(ROOT, "test-data", "labels.json"), "utf8"));
  const subset = labels.filter(l => SUBSET.includes(l.file));
  console.log(`Model: ${MODEL}\nSubset: ${subset.length} receipts\n`);

  const results = [];
  for (const test of TESTS) {
    process.stdout.write(`${test.id} ${test.name.padEnd(28)}... `);
    const start = Date.now();
    const r = await runTest(test, subset);
    const secs = ((Date.now() - start) / 1000).toFixed(1);
    console.log(`m ${r.m}/${r.total}  d ${r.d}/${r.total}  a ${r.a}/${r.total}  (${r.calls} calls, ${secs}s)`);
    results.push(r);
  }

  // Detailed miss reports
  console.log("\n── Per-test misses ──");
  for (const r of results) {
    if (r.misses.length === 0) {
      console.log(`\n${r.id} ${r.name}: NO MISSES 🎯`);
      continue;
    }
    console.log(`\n${r.id} ${r.name} — ${r.misses.length} miss(es):`);
    for (const m of r.misses) {
      console.log(`  ${m.fails.padEnd(3)} ${m.file}  exp ${JSON.stringify(m.exp).slice(0,55)}  got ${JSON.stringify(m.got).slice(0,55)}`);
    }
  }

  // Save
  const outFile = path.join(ROOT, "results", `iterate-${new Date().toISOString().replace(/[:.]/g,"-")}.json`);
  fs.writeFileSync(outFile, JSON.stringify({ model: MODEL, tests: TESTS, results }, null, 2));
  console.log(`\nSaved → ${path.relative(ROOT, outFile)}`);
}

main().catch(e => { console.error("Fatal:", e.stack || e.message); process.exit(1); });
