#!/usr/bin/env node
// T11: Gemini 2.5 Flash with thinkingBudget=0, T1+T5 combo prompt.
// Tests whether Flash@0 can serve as the multi-cat tier (replacing Pro)
// for ~14× lower cost than Pro@1024.

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
const FLASH = "gemini-2.5-flash";

const TEST_FILES = [
  "target_long_1.jpg", "target_long_2.jpg",
  "walmart_1.jpg", "sams_2.jpg", "sams_club.jpg",
];

const C3 = `\n\nCATEGORY RULE — itemize then consolidate:\nStep 1: For each line item, assign {description, price, categoryId}. Step 2: Group by categoryId and sum. Step 3: Return one categoryAmounts entry per distinct categoryId.`;
const C4 = `\n\nCATEGORY RULE — use tax markers:\nReceipts often mark each item with tax codes (T, F, N, S, O). Taxed non-food (T) → Home Supplies (30186) or Other (30426); non-taxed (N, F) → Groceries (22695).`;
const C6 = `\n\nCATEGORY RULE — detailed category→item mapping:\nFood/produce/meat/pantry → 22695 Groceries.\nBeverages from a cafe → 21716; bottled drinks from a supermarket → 22695.\nCleaning, paper towels, ziploc/foil, pet items → 30186 Home Supplies.\nBatteries, stationery, pens, office supplies → 30426 Other.\nKids' toys, school workbooks, kids clothes → 1276 Kid's Stuff.\nPharmacy/OTC medicine → 17351 Health/Pharmacy.\nFuel, parking, tolls → 48281 Transportation/Gas.\nWork safety gear, uniforms → 47837 Employment Expenses.\nHardware, electrical, lighting, paint → 30186 Home Supplies.`;
const T1_THEMATIC = `\n\nCATEGORY RULE — thematic first-pass:\nBefore applying per-item category mapping, scan the full receipt for seasonal or thematic patterns. If you see items whose descriptions clearly tie to a holiday or theme, route them first:\n  • Easter eggs, Easter bunnies, Easter baskets, jelly beans in Easter packaging → 49552 Holidays/Birthdays\n  • Christmas ornaments, stockings, holiday gift items → 49552 Holidays/Birthdays\n  • Halloween candy, costumes, decor → 49552 Holidays/Birthdays\n  • Valentine candy, cards → 49552 Holidays/Birthdays\n  • Back-to-school workbooks, kids' crayons, lunchboxes → 1276 Kid's Stuff\nOnly items that DON'T match a theme fall through to the generic mappings below.`;

function buildComboPrompt(cats) {
  return C3 + C4 + C6 + T1_THEMATIC + "\n\n" + buildPrompt(cats);
}

const SCHEMA = {
  type: "object",
  properties: {
    merchant: { type: "string" }, merchantLegalName: { type: "string" },
    date: { type: "string" }, amount: { type: "number" },
    categoryAmounts: { type: "array", items: { type: "object", properties: { categoryId: { type: "integer" }, amount: { type: "number" } }, required: ["categoryId", "amount"] } },
    notes: { type: "string" },
  },
  required: ["merchant", "date", "amount"],
};

const client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

async function call({ imageBytes, mimeType, prompt }) {
  let lastErr;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await client.models.generateContent({
        model: FLASH,
        contents: [{ role: "user", parts: [{ text: prompt }, { inlineData: { mimeType, data: imageBytes.toString("base64") } }] }],
        config: {
          responseMimeType: "application/json",
          responseSchema: SCHEMA,
          temperature: 0,
          thinkingConfig: { thinkingBudget: 0 },
        },
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
  console.log(`Flash 2.5 @ thinkingBudget=0 on ${receipts.length} receipts × 2 runs = ${receipts.length*2} calls\n`);

  const results = [];
  for (const label of receipts) {
    const cats = TEST_CATEGORIES.filter(c => label.categoryAmounts.map(x => x.categoryId).includes(c.id));
    const prompt = buildComboPrompt(cats);
    const img = fs.readFileSync(path.join(ROOT, "test-data", "images", label.file));
    const mime = mimeFor(label.file);
    console.log(`=== ${label.file} amount=$${label.amount} ===`);
    for (const run of [1, 2]) {
      process.stdout.write(`  T11_flash0 run${run} `);
      try {
        const t0 = Date.now();
        const r = await call({ imageBytes: img, mimeType: mime, prompt });
        const ms = Date.now() - t0;
        const grade = gradeResult(label, r.parsed);
        const ca = r.parsed.categoryAmounts || [];
        const sumCA = ca.reduce((s, c) => s + (c.amount || 0), 0);
        const drift = Math.abs(sumCA - (r.parsed.amount || 0));
        const t = r.tokens || {};
        const hidden = (t.totalTokenCount || 0) - (t.promptTokenCount || 0) - (t.candidatesTokenCount || 0);
        const cset = grade.categoryAmounts?.setMatch ? "✓" : "✗";
        const cshr = grade.categoryAmounts?.shareMatch ? "✓" : "✗";
        console.log(`m${grade.merchant.pass?"✓":"✗"} d${grade.date.pass?"✓":"✗"} a${grade.amount.pass?"✓":"✗"} sum${drift<=0.05?"✓":"✗"} cset${cset} cshr${cshr} drift $${drift.toFixed(2)} out=${t.candidatesTokenCount}tok hidden=${hidden}tok ${ms}ms`);
        results.push({ file: label.file, run, grade, sumMatch: drift <= 0.05, drift, tokens: t, hidden, ms });
      } catch (e) {
        console.log(`ERR ${e.message.slice(0,60)}`);
        results.push({ file: label.file, run, error: e.message });
      }
    }
    console.log();
  }

  const rs = results.filter(r => r.grade);
  const n = rs.length;
  const m = rs.filter(r => r.grade.merchant.pass).length;
  const d = rs.filter(r => r.grade.date.pass).length;
  const a = rs.filter(r => r.grade.amount.pass).length;
  const sum = rs.filter(r => r.sumMatch).length;
  const cset = rs.filter(r => r.grade.categoryAmounts?.setMatch).length;
  const cshr = rs.filter(r => r.grade.categoryAmounts?.shareMatch).length;
  const avgIn = rs.reduce((s,r) => s + (r.tokens?.promptTokenCount || 0), 0) / n;
  const avgVis = rs.reduce((s,r) => s + (r.tokens?.candidatesTokenCount || 0), 0) / n;
  const avgHidden = rs.reduce((s,r) => s + r.hidden, 0) / n;
  const avgMs = rs.reduce((s,r) => s + r.ms, 0) / n;
  // Flash pricing: $0.30/M input, $2.50/M output
  const estCostPerCall = (avgIn * 0.30 + (avgVis + avgHidden) * 2.50) / 1e6;
  console.log(`=== T11_flash0 ===`);
  console.log(`m ${m}/${n}  d ${d}/${n}  a ${a}/${n}  sum ${sum}/${n}  cset ${cset}/${n}  cshr ${cshr}/${n}`);
  console.log(`inTok ${avgIn.toFixed(0)}  visOut ${avgVis.toFixed(0)}  hidden ${avgHidden.toFixed(0)}  ${avgMs.toFixed(0)}ms  ~\$${estCostPerCall.toFixed(4)}/call`);

  const outFile = path.join(ROOT, "results", `flash-nothink-${new Date().toISOString().replace(/[:.]/g,"-")}.json`);
  fs.writeFileSync(outFile, JSON.stringify({ run: "flash-nothink", results }, null, 2));
  console.log(`\nSaved → ${path.relative(ROOT, outFile)}`);
}

main().catch(e => { console.error("Fatal:", e.stack || e.message); process.exit(1); });
