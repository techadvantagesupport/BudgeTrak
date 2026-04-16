#!/usr/bin/env node
// A/B test: does removing `lineItems` from the response schema hurt category
// accuracy on multi-category receipts? R7-T10 prompt unchanged, 2 runs each to
// smooth sampling variance.

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

const MULTI_CAT = [
  "sams_club.jpg", "target.jpg",
  "sroie_0024.jpg", "sroie_0070.jpg", "sroie_0096.jpg",
  "Screenshot_20260415_191342_Amazon Shopping.jpg",
  "Screenshot_20260415_191443_Amazon Shopping.jpg",
];

const FLASH_BASE = buildPrompt(TEST_CATEGORIES);

const C3 = `\n\nCATEGORY RULE — itemize then consolidate:\nStep 1: For each line item, assign {description, price, categoryId}. Step 2: Group by categoryId and sum. Step 3: Return one categoryAmounts entry per distinct categoryId.`;
const C4 = `\n\nCATEGORY RULE — use tax markers:\nReceipts often mark each item with tax codes (T, F, N, S, O). Taxed non-food (T) → Home Supplies (30186) or Other (30426); non-taxed (N, F) → Groceries (22695).`;
const C6 = `\n\nCATEGORY RULE — detailed category→item mapping:\nFood/produce/meat/pantry → 22695 Groceries.\nBeverages from a cafe → 21716; bottled drinks from a supermarket → 22695.\nCleaning, paper towels, ziploc/foil, pet items → 30186 Home Supplies.\nBatteries, stationery, pens, office supplies → 30426 Other.\nKids' toys, school workbooks, kids clothes → 1276 Kid's Stuff.\nPharmacy/OTC medicine → 17351 Health/Pharmacy.\nFuel, parking, tolls → 48281 Transportation/Gas.\nWork safety gear, uniforms → 47837 Employment Expenses.\nHardware, electrical, lighting, paint → 30186 Home Supplies.`;
const MP = `\n\nPRIORITY REMINDER: merchant and amount are the most important fields. Do not compromise them while attending to category work. Merchant MUST be the consumer brand (not a cashier name, customer name, or translated English word).`;

const R7T10_PROMPT = C3 + C4 + C6 + MP + "\n\n" + FLASH_BASE;

// Schema A: includes lineItems (current harness + app baseline)
const SCHEMA_WITH_LI = {
  type: "object",
  properties: {
    merchant: { type: "string" }, merchantLegalName: { type: "string" },
    date: { type: "string" }, amount: { type: "number" },
    categoryAmounts: { type: "array", items: { type: "object", properties: { categoryId: { type: "integer" }, amount: { type: "number" } }, required: ["categoryId", "amount"] } },
    lineItems: { type: "array", items: { type: "string" } }, notes: { type: "string" },
  },
  required: ["merchant", "date", "amount"],
};

// Schema B: no lineItems field at all
const SCHEMA_NO_LI = {
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

async function call({ imageBytes, mimeType, schema }) {
  let lastErr;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await client.models.generateContent({
        model: FLASH,
        contents: [{ role: "user", parts: [{ text: R7T10_PROMPT }, { inlineData: { mimeType, data: imageBytes.toString("base64") } }] }],
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

async function runOne(label, schema) {
  const img = fs.readFileSync(path.join(ROOT, "test-data", "images", label.file));
  const mime = mimeFor(label.file);
  const t0 = Date.now();
  const { parsed, tokens } = await call({ imageBytes: img, mimeType: mime, schema });
  const ms = Date.now() - t0;
  const grade = gradeResult(label, parsed);
  return { parsed, grade, ms, tokens };
}

async function main() {
  const labels = JSON.parse(fs.readFileSync(path.join(ROOT, "test-data", "labels.json"), "utf8"));
  const set = MULTI_CAT.map(f => labels.find(l => l.file === f)).filter(Boolean);
  console.log(`A/B test — lineItems schema impact on ${set.length} multi-category receipts\n`);

  const results = [];
  for (const label of set) {
    for (const variant of ["A_withLI", "B_noLI"]) {
      const schema = variant === "A_withLI" ? SCHEMA_WITH_LI : SCHEMA_NO_LI;
      for (const run of [1, 2]) {
        process.stdout.write(`${variant} run${run} ${label.file.padEnd(45)} `);
        try {
          const r = await runOne(label, schema);
          const ca = r.grade.categoryAmounts;
          const setMatch = ca?.setMatch ? "✓" : "✗";
          const shareMatch = ca?.shareMatch ? "✓" : "✗";
          const out = r.tokens?.candidatesTokenCount ?? "?";
          console.log(`m${r.grade.merchant.pass?"✓":"✗"} d${r.grade.date.pass?"✓":"✗"} a${r.grade.amount.pass?"✓":"✗"} cset${setMatch} cshr${shareMatch} out=${out}tok ${r.ms}ms`);
          results.push({ file: label.file, variant, run, grade: r.grade, tokens: r.tokens, ms: r.ms });
        } catch (e) {
          console.log(`ERR ${e.message.slice(0,60)}`);
          results.push({ file: label.file, variant, run, error: e.message });
        }
      }
    }
  }

  // Aggregate
  console.log(`\n=== Aggregate (${set.length} receipts × 2 runs = ${set.length*2} calls/variant) ===`);
  for (const variant of ["A_withLI", "B_noLI"]) {
    const rs = results.filter(r => r.variant === variant && r.grade);
    const n = rs.length;
    const m = rs.filter(r => r.grade.merchant.pass).length;
    const d = rs.filter(r => r.grade.date.pass).length;
    const a = rs.filter(r => r.grade.amount.pass).length;
    const cset = rs.filter(r => r.grade.categoryAmounts?.setMatch).length;
    const cshr = rs.filter(r => r.grade.categoryAmounts?.shareMatch).length;
    const avgOut = rs.reduce((s,r) => s + (r.tokens?.candidatesTokenCount || 0), 0) / n;
    const avgMs = rs.reduce((s,r) => s + r.ms, 0) / n;
    console.log(`${variant}: m ${m}/${n}  d ${d}/${n}  a ${a}/${n}  cset ${cset}/${n}  cshr ${cshr}/${n}  avgOut ${avgOut.toFixed(0)}tok  avgMs ${avgMs.toFixed(0)}`);
  }

  const outFile = path.join(ROOT, "results", `lineitems-ab-${new Date().toISOString().replace(/[:.]/g,"-")}.json`);
  fs.writeFileSync(outFile, JSON.stringify({ run: "lineitems-ab", results }, null, 2));
  console.log(`\nSaved → ${path.relative(ROOT, outFile)}`);
}

main().catch(e => { console.error("Fatal:", e.stack || e.message); process.exit(1); });
