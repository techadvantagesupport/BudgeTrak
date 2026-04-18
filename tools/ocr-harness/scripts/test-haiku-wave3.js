#!/usr/bin/env node
// Haiku Wave 3 — final iteration. Two waves and 20 variants confirmed Haiku
// ceilings at cset 6/10 and cshr 0/10 on the 5 worst receipts. Wave 3 pivots:
//   - Ceiling check: compare Sonnet 4.5 and Opus 4.1 on the same prompt
//   - Salvage attempts: fix errored variants, try multi-call pipelines
//   - If no Claude variant beats Pro@1024, we ship Pro and shelve Claude.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";

import { TEST_CATEGORIES } from "../src/categories.js";
import { gradeResult } from "../src/grader.js";

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), "..");
const HAIKU = "claude-haiku-4-5-20251001";
const SONNET = "claude-sonnet-4-5-20250929";
const OPUS = "claude-opus-4-1-20250805";

const TEST_FILES = [
  "target_long_1.jpg", "target_long_2.jpg",
  "walmart_1.jpg", "sams_2.jpg", "sams_club.jpg",
];

const C6 = `\nCATEGORY RULE — detailed mapping:\nFood/produce/meat/pantry → 22695 Groceries. Cleaning/ziploc/pet items/hardware/paint → 30186 Home Supplies. Batteries/stationery/pens → 30186 Home Supplies. Kids' toys/school workbooks/kids clothes → 1276 Kid's Stuff. Pharmacy/OTC medicine/personal care → 17351 Health/Pharmacy. Apparel → 52714 Clothes. Fuel/parking → 48281 Transportation/Gas. Easter/Christmas/Halloween/Valentine items → 49552 Holidays/Birthdays. Games/toys/entertainment → 57937 Entertainment.`;
const T1_THEMATIC = `\nTHEMATIC FIRST-PASS: Scan for seasonal/holiday items first (Easter eggs/bunnies, Christmas, Halloween, Valentine) → 49552. Only non-themed items fall through.`;
const MERCHANT_HINTS = `\nMERCHANT SECTIONS:\n- **Target**: APPAREL→52714, GROCERY→22695, HOME/KITCHEN/HARDWARE→30186, HEALTH & BEAUTY→17351, ELECTRONICS→30186 (or 57937 games/movies).\n- **Sam's/Costco**: mostly 22695. Non-food→30186. Apparel→52714.\n- **Walmart**: Easter/holiday→49552. Grocery→22695. Apparel→52714. Household→30186. Toys/kids→1276.`;

function categoryList(cats) {
  return cats
    .filter(c => c.tag !== "supercharge" && c.tag !== "recurring_income" && !c.deleted)
    .map(c => c.tag ? `  - id=${c.id} name="${c.name}" tag="${c.tag}"` : `  - id=${c.id} name="${c.name}"`)
    .join("\n");
}

function basePrompt(cats) {
  return `You are a receipt-reading assistant. Extract purchase details and return via tool.\n${C6}${T1_THEMATIC}${MERCHANT_HINTS}\n\nAvailable categoryIds:\n${categoryList(cats)}`;
}

const SCHEMA_OBJ = {
  type: "object",
  properties: {
    merchant: { type: "string" }, merchantLegalName: { type: "string" },
    date: { type: "string", description: "YYYY-MM-DD" },
    amount: { type: "number" },
    categoryAmounts: {
      type: "array",
      items: {
        type: "object",
        properties: { categoryId: { type: "integer" }, amount: { type: "number" } },
        required: ["categoryId", "amount"],
      },
    },
    notes: { type: "string" },
  },
  required: ["merchant", "date", "amount"],
};

const TOOL = { name: "return_receipt_data", description: "Return extracted receipt data.", input_schema: SCHEMA_OBJ };

// ─── Variants ──────────────────────────────────────────────────────

function W3_01(cats) { return basePrompt(cats); }                       // Sonnet 4.5, baseline
function W3_02(cats) { return basePrompt(cats); }                       // Sonnet 4.5, with thinking
function W3_03(cats) { return basePrompt(cats); }                       // Opus 4.1, baseline

// W3_04: Haiku prefill fixed (no trailing whitespace)
function W3_04(cats) {
  return `${basePrompt(cats)}\n\nReturn ONLY a JSON object (no prose, no code fences) with keys: merchant, date (YYYY-MM-DD), amount, categoryAmounts (array of {categoryId, amount}), notes.`;
}

// W3_05: Haiku mega-prompt combining best of Wave 2 (XML+merchant+verify+xcheck)
function W3_05(cats) {
  return `<task>Extract receipt data via return_receipt_data tool.</task>\n\n<merchant-sections>${MERCHANT_HINTS}</merchant-sections>\n\n<mapping>${C6}</mapping>\n\n<seasonal>${T1_THEMATIC}</seasonal>\n\n<discipline>
- categoryAmounts MUST sum to amount within $0.05.
- Each categoryAmount equals the sum of items you assigned to that category.
- After deciding, mentally re-check: Σ categoryAmounts = amount, and each category total reflects its actual items.
- Read each item's price carefully — misreads cause bucket drift.
</discipline>\n\n<categories>\n${categoryList(cats)}\n</categories>`;
}

// W3_06: Haiku with 2 worked examples (Target + Sam's) instead of 1
function W3_06(cats) {
  return `${basePrompt(cats)}

EXAMPLE 1 — Target receipt:
  Items visible: BUBBL'R $6.20, Lean Cuisine $3.59, GG Milk $6.38 (grocery); Bocce's Bakry $7.99, BootsBarkley $16.99 (pet/home); tax $2.30.
  → amount: 43.45
  → categoryAmounts: [{22695, 16.63}, {30186, 26.82}]

EXAMPLE 2 — Sam's Club receipt:
  Items: MM AA-48 $17.98×2 (batteries), RED POTATO $4.16, BANANAS $2.16, CUCUMBERS $3.97, CHICKEN $4.98×2, HALF PAN $11.68, KAISER ROLL $6.24, DOVE CN/SH $9.98×2 (body wash), tax.
  → amount: 366.88
  → categoryAmounts: [{22695, 259.35}, {30186, 107.53}]

Now apply this reasoning to the receipt image provided.`;
}

// W3_07: Haiku with extended thinking, tool_choice auto, larger budget
function W3_07(cats) { return basePrompt(cats); }

// W3_08: Haiku confidence scoring — ask for confidence per category
function W3_08(cats) {
  return `${basePrompt(cats)}\n\nALSO: in the notes field, briefly state your confidence (1-10) on each of: merchant reading, date reading, total amount reading, category split accuracy. Be honest about which numbers you had trouble reading clearly from the image.`;
}

// W3_09: Haiku pipeline — force focus on one task at a time via the prompt structure
function W3_09(cats) {
  return `${basePrompt(cats)}\n\nWORK IN THIS ORDER:\nSTEP 1. Read the receipt header — identify merchant, date, and the printed TOTAL amount. Lock in these three fields.\nSTEP 2. Read each purchased line item with its price, one by one. Do NOT skip any.\nSTEP 3. For each line item, assign a categoryId from the list. Skip nothing.\nSTEP 4. Group your step-3 assignments by categoryId and SUM each group. These sums are your categoryAmounts.\nSTEP 5. Verify Σ categoryAmounts == amount (within $0.05). If not, you missed an item — re-check.\n\nThen call the tool.`;
}

// W3_10: Haiku with strong output shaping — force ORDERED categoryAmounts that match expected structure
function W3_10(cats) {
  return `${basePrompt(cats)}\n\nOutput categoryAmounts with the LARGEST amount first, smallest last. Each entry's amount must equal the real total spent on that category's items (not an estimate). Never round individual category totals — use exact cents.`;
}

const VARIANTS = [
  { id: "W3_01_sonnet_base",  build: W3_01, model: SONNET, thinking: 0,    tool: true,  prefill: false, desc: "Sonnet 4.5, baseline prompt" },
  { id: "W3_02_sonnet_think", build: W3_02, model: SONNET, thinking: 2048, tool: true,  prefill: false, desc: "Sonnet 4.5 + extended thinking" },
  { id: "W3_03_opus",         build: W3_03, model: OPUS,   thinking: 0,    tool: true,  prefill: false, desc: "Opus 4.1, baseline (expensive ceiling check)" },
  { id: "W3_04_prefill_fix",  build: W3_04, model: HAIKU,  thinking: 0,    tool: false, prefill: true,  desc: "Haiku prefill (no whitespace)" },
  { id: "W3_05_mega",         build: W3_05, model: HAIKU,  thinking: 0,    tool: true,  prefill: false, desc: "Haiku mega-prompt (XML+merchant+verify)" },
  { id: "W3_06_2shot",        build: W3_06, model: HAIKU,  thinking: 0,    tool: true,  prefill: false, desc: "Haiku 2 worked examples" },
  { id: "W3_07_think_large",  build: W3_07, model: HAIKU,  thinking: 4096, tool: true,  prefill: false, desc: "Haiku + extended thinking (4096)" },
  { id: "W3_08_confidence",   build: W3_08, model: HAIKU,  thinking: 0,    tool: true,  prefill: false, desc: "Haiku with self-reported confidence" },
  { id: "W3_09_stepwise",     build: W3_09, model: HAIKU,  thinking: 0,    tool: true,  prefill: false, desc: "Haiku strict step-by-step process" },
  { id: "W3_10_ordered",      build: W3_10, model: HAIKU,  thinking: 0,    tool: true,  prefill: false, desc: "Haiku forced ordering + exact cents" },
];

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

async function call({ imageBytes, mimeType, variant, userPrompt }) {
  let lastErr;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const req = {
        model: variant.model,
        max_tokens: 6144,
        messages: [{
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: mimeType, data: imageBytes.toString("base64") } },
            { type: "text", text: userPrompt },
          ],
        }],
      };
      if (variant.thinking > 0) req.thinking = { type: "enabled", budget_tokens: variant.thinking };
      if (variant.tool) {
        req.tools = [TOOL];
        req.tool_choice = variant.thinking > 0 ? { type: "auto" } : { type: "tool", name: TOOL.name };
      }
      if (variant.prefill) {
        req.messages.push({ role: "assistant", content: [{ type: "text", text: "{" }] });
      }
      const res = await client.messages.create(req);
      let parsed;
      if (variant.tool) {
        const tu = res.content.find(c => c.type === "tool_use");
        if (tu) { parsed = tu.input; }
        else {
          const text = res.content.filter(c => c.type === "text").map(c => c.text).join("\n");
          const jsonMatch = text.match(/<json>([\s\S]*?)<\/json>/) || text.match(/\{[\s\S]+\}/);
          if (!jsonMatch) throw new Error("No tool_use and no JSON in text");
          parsed = JSON.parse(jsonMatch[1] ?? jsonMatch[0]);
        }
      } else if (variant.prefill) {
        const text = res.content.filter(c => c.type === "text").map(c => c.text).join("");
        parsed = JSON.parse("{" + text);
      } else {
        const text = res.content.filter(c => c.type === "text").map(c => c.text).join("\n");
        const match = text.match(/\{[\s\S]+\}/);
        if (!match) throw new Error("No JSON in text");
        parsed = JSON.parse(match[0]);
      }
      return { parsed, usage: res.usage };
    } catch (e) {
      lastErr = e;
      const msg = String(e.message || e);
      const transient = (e.status && [429, 500, 503, 529].includes(e.status)) || /overloaded|fetch failed|network|ECONNRESET|ETIMEDOUT|socket/i.test(msg);
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

function priceOf(model) {
  if (model === OPUS) return { inRate: 15, outRate: 75 };
  if (model === SONNET) return { inRate: 3, outRate: 15 };
  return { inRate: 1, outRate: 5 };
}

async function main() {
  const labels = JSON.parse(fs.readFileSync(path.join(ROOT, "test-data", "labels.json"), "utf8"));
  const receipts = TEST_FILES.map(f => labels.find(l => l.file === f)).filter(Boolean);
  console.log(`Haiku Wave 3: ${receipts.length} receipts × ${VARIANTS.length} variants × 2 runs = ${receipts.length*VARIANTS.length*2} calls\n`);

  const results = [];
  for (const label of receipts) {
    const cats = TEST_CATEGORIES.filter(c => label.categoryAmounts.map(x => x.categoryId).includes(c.id));
    const img = fs.readFileSync(path.join(ROOT, "test-data", "images", label.file));
    const mime = mimeFor(label.file);
    console.log(`=== ${label.file} amount=$${label.amount} ===`);
    for (const v of VARIANTS) {
      const userPrompt = v.build(cats);
      for (const run of [1, 2]) {
        process.stdout.write(`  ${v.id.padEnd(20)} run${run} `);
        try {
          const t0 = Date.now();
          const r = await call({ imageBytes: img, mimeType: mime, variant: v, userPrompt });
          const ms = Date.now() - t0;
          const grade = gradeResult(label, r.parsed);
          const ca = r.parsed.categoryAmounts || [];
          const sumCA = ca.reduce((s, c) => s + (c.amount || 0), 0);
          const drift = Math.abs(sumCA - (r.parsed.amount || 0));
          const cset = grade.categoryAmounts?.setMatch ? "✓" : "✗";
          const cshr = grade.categoryAmounts?.shareMatch ? "✓" : "✗";
          console.log(`m${grade.merchant.pass?"✓":"✗"} d${grade.date.pass?"✓":"✗"} a${grade.amount.pass?"✓":"✗"} sum${drift<=0.05?"✓":"✗"} cset${cset} cshr${cshr} drift $${drift.toFixed(2)} in=${r.usage.input_tokens}tok out=${r.usage.output_tokens}tok ${ms}ms`);
          results.push({ file: label.file, variant: v.id, model: v.model, run, grade, sumMatch: drift <= 0.05, drift, usage: r.usage, ms });
        } catch (e) {
          console.log(`ERR ${String(e.message).slice(0,80)}`);
          results.push({ file: label.file, variant: v.id, model: v.model, run, error: e.message });
        }
      }
    }
    console.log();
  }

  console.log(`=== Aggregate (${receipts.length} × 2 runs = ${receipts.length*2} calls/variant) ===`);
  for (const v of VARIANTS) {
    const rs = results.filter(r => r.variant === v.id && r.grade);
    const n = rs.length;
    if (!n) { console.log(`${v.id.padEnd(20)} ${v.desc.padEnd(45)}  all errored`); continue; }
    const m = rs.filter(r => r.grade.merchant.pass).length;
    const d = rs.filter(r => r.grade.date.pass).length;
    const a = rs.filter(r => r.grade.amount.pass).length;
    const sum = rs.filter(r => r.sumMatch).length;
    const cset = rs.filter(r => r.grade.categoryAmounts?.setMatch).length;
    const cshr = rs.filter(r => r.grade.categoryAmounts?.shareMatch).length;
    const avgIn = rs.reduce((s,r) => s + (r.usage?.input_tokens || 0), 0) / n;
    const avgOut = rs.reduce((s,r) => s + (r.usage?.output_tokens || 0), 0) / n;
    const avgMs = rs.reduce((s,r) => s + r.ms, 0) / n;
    const { inRate, outRate } = priceOf(v.model);
    const cost = (avgIn * inRate + avgOut * outRate) / 1e6;
    console.log(`${v.id.padEnd(20)} ${v.desc.padEnd(45)}  m ${m}/${n}  d ${d}/${n}  a ${a}/${n}  sum ${sum}/${n}  cset ${cset}/${n}  cshr ${cshr}/${n}  in ${avgIn.toFixed(0)}  out ${avgOut.toFixed(0)}  ${avgMs.toFixed(0)}ms  ~\$${cost.toFixed(4)}/call`);
  }

  const outFile = path.join(ROOT, "results", `haiku-wave3-${new Date().toISOString().replace(/[:.]/g,"-")}.json`);
  fs.writeFileSync(outFile, JSON.stringify({ run: "haiku-wave3", results }, null, 2));
  console.log(`\nSaved → ${path.relative(ROOT, outFile)}`);
}

main().catch(e => { console.error("Fatal:", e.stack || e.message); process.exit(1); });
