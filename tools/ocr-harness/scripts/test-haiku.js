#!/usr/bin/env node
// Claude Haiku 4.5 on the 5 worst multi-cat receipts.
// Uses tool_use for structured JSON output (Claude's equivalent of
// Gemini's responseSchema). No extended thinking → no hidden tokens.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";

import { TEST_CATEGORIES } from "../src/categories.js";
import { gradeResult } from "../src/grader.js";
import { buildPrompt } from "../src/prompt.js";

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), "..");
const MODEL = process.env.ANTHROPIC_MODEL || "claude-haiku-4-5-20251001";

const TEST_FILES = [
  "target_long_1.jpg", "target_long_2.jpg",
  "walmart_1.jpg", "sams_2.jpg", "sams_club.jpg",
];

const C3 = `\n\nCATEGORY RULE — itemize then consolidate:\nStep 1: For each line item, assign {description, price, categoryId}. Step 2: Group by categoryId and sum. Step 3: Return one categoryAmounts entry per distinct categoryId.`;
const C4 = `\n\nCATEGORY RULE — use tax markers:\nReceipts often mark each item with tax codes (T, F, N, S, O). Taxed non-food (T) → Home Supplies (30186) or Other (30426); non-taxed (N, F) → Groceries (22695).`;
const C6 = `\n\nCATEGORY RULE — detailed category→item mapping:\nFood/produce/meat/pantry → 22695 Groceries.\nBeverages from a cafe → 21716; bottled drinks from a supermarket → 22695.\nCleaning, paper towels, ziploc/foil, pet items → 30186 Home Supplies.\nBatteries, stationery, pens, office supplies → 30426 Other.\nKids' toys, school workbooks, kids clothes → 1276 Kid's Stuff.\nPharmacy/OTC medicine → 17351 Health/Pharmacy.\nFuel, parking, tolls → 48281 Transportation/Gas.\nWork safety gear, uniforms → 47837 Employment Expenses.\nHardware, electrical, lighting, paint → 30186 Home Supplies.`;
const T1_THEMATIC = `\n\nCATEGORY RULE — thematic first-pass:\nBefore applying per-item category mapping, scan the full receipt for seasonal or thematic patterns. If you see items whose descriptions clearly tie to a holiday or theme, route them first:\n  • Easter eggs, Easter bunnies, Easter baskets, jelly beans in Easter packaging → 49552 Holidays/Birthdays\n  • Christmas ornaments, stockings, holiday gift items → 49552 Holidays/Birthdays\n  • Halloween candy, costumes, decor → 49552 Holidays/Birthdays\n  • Valentine candy, cards → 49552 Holidays/Birthdays\n  • Back-to-school workbooks, kids' crayons, lunchboxes → 1276 Kid's Stuff\nOnly items that DON'T match a theme fall through to the generic mappings below.`;

// Anthropic uses tool_use for structured output. Define the "tool" Claude
// should call — its parameters become the structured response.
const RETURN_RECEIPT_TOOL = {
  name: "return_receipt_data",
  description: "Return the extracted receipt data as a single structured response.",
  input_schema: {
    type: "object",
    properties: {
      merchant: { type: "string", description: "Consumer brand on the receipt header" },
      merchantLegalName: { type: "string", description: "Optional legal operator entity" },
      date: { type: "string", description: "Transaction date in YYYY-MM-DD" },
      amount: { type: "number", description: "Final total paid" },
      categoryAmounts: {
        type: "array",
        items: {
          type: "object",
          properties: {
            categoryId: { type: "integer" },
            amount: { type: "number" },
          },
          required: ["categoryId", "amount"],
        },
      },
      notes: { type: "string" },
    },
    required: ["merchant", "date", "amount"],
  },
};

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

async function call({ imageBytes, mimeType, prompt }) {
  let lastErr;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await client.messages.create({
        model: MODEL,
        max_tokens: 2048,
        tools: [RETURN_RECEIPT_TOOL],
        tool_choice: { type: "tool", name: RETURN_RECEIPT_TOOL.name },
        messages: [{
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: mimeType, data: imageBytes.toString("base64") } },
            { type: "text", text: prompt },
          ],
        }],
      });
      const toolUse = res.content.find(c => c.type === "tool_use");
      if (!toolUse) throw new Error("No tool_use block in response");
      return {
        parsed: toolUse.input,
        usage: res.usage,  // { input_tokens, output_tokens, cache_creation_input_tokens?, cache_read_input_tokens? }
      };
    } catch (e) {
      lastErr = e;
      const msg = String(e.message || e);
      const status = e.status || 0;
      const transient = status === 429 || status === 503 || status === 529 || /overloaded|fetch failed|network|ECONNRESET|ETIMEDOUT|socket/i.test(msg);
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
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("Set ANTHROPIC_API_KEY in tools/ocr-harness/.env first.");
    process.exit(1);
  }
  const labels = JSON.parse(fs.readFileSync(path.join(ROOT, "test-data", "labels.json"), "utf8"));
  const receipts = TEST_FILES.map(f => labels.find(l => l.file === f)).filter(Boolean);
  console.log(`${MODEL} on ${receipts.length} receipts × 2 runs = ${receipts.length*2} calls\n`);

  const results = [];
  for (const label of receipts) {
    const cats = TEST_CATEGORIES.filter(c => label.categoryAmounts.map(x => x.categoryId).includes(c.id));
    const prompt = C3 + C4 + C6 + T1_THEMATIC + "\n\n" + buildPrompt(cats);
    const img = fs.readFileSync(path.join(ROOT, "test-data", "images", label.file));
    const mime = mimeFor(label.file);
    console.log(`=== ${label.file} amount=$${label.amount} ===`);
    for (const run of [1, 2]) {
      process.stdout.write(`  Haiku45 run${run} `);
      try {
        const t0 = Date.now();
        const r = await call({ imageBytes: img, mimeType: mime, prompt });
        const ms = Date.now() - t0;
        const grade = gradeResult(label, r.parsed);
        const ca = r.parsed.categoryAmounts || [];
        const sumCA = ca.reduce((s, c) => s + (c.amount || 0), 0);
        const drift = Math.abs(sumCA - (r.parsed.amount || 0));
        const cset = grade.categoryAmounts?.setMatch ? "✓" : "✗";
        const cshr = grade.categoryAmounts?.shareMatch ? "✓" : "✗";
        console.log(`m${grade.merchant.pass?"✓":"✗"} d${grade.date.pass?"✓":"✗"} a${grade.amount.pass?"✓":"✗"} sum${drift<=0.05?"✓":"✗"} cset${cset} cshr${cshr} drift $${drift.toFixed(2)} in=${r.usage.input_tokens}tok out=${r.usage.output_tokens}tok ${ms}ms`);
        results.push({ file: label.file, run, grade, sumMatch: drift <= 0.05, drift, usage: r.usage, ms });
      } catch (e) {
        console.log(`ERR ${e.message.slice(0,80)}`);
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
  const avgIn = rs.reduce((s,r) => s + (r.usage?.input_tokens || 0), 0) / n;
  const avgOut = rs.reduce((s,r) => s + (r.usage?.output_tokens || 0), 0) / n;
  const avgMs = rs.reduce((s,r) => s + r.ms, 0) / n;
  // Haiku 4.5 pricing: $1/M input, $5/M output
  const estCostPerCall = (avgIn * 1 + avgOut * 5) / 1e6;
  console.log(`=== ${MODEL} ===`);
  console.log(`m ${m}/${n}  d ${d}/${n}  a ${a}/${n}  sum ${sum}/${n}  cset ${cset}/${n}  cshr ${cshr}/${n}`);
  console.log(`inTok ${avgIn.toFixed(0)}  outTok ${avgOut.toFixed(0)}  ${avgMs.toFixed(0)}ms  ~\$${estCostPerCall.toFixed(4)}/call`);

  const outFile = path.join(ROOT, "results", `haiku-${new Date().toISOString().replace(/[:.]/g,"-")}.json`);
  fs.writeFileSync(outFile, JSON.stringify({ run: "haiku", model: MODEL, results }, null, 2));
  console.log(`\nSaved → ${path.relative(ROOT, outFile)}`);
}

main().catch(e => { console.error("Fatal:", e.stack || e.message); process.exit(1); });
