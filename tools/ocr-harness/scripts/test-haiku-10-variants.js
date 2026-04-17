#!/usr/bin/env node
// 10 Haiku 4.5 prompt variants designed to improve over the baseline
// (cset 5/10, cshr 0/10) on the 5 worst English multi-cat receipts.
//
// Baseline (run from test-haiku.js): R7-T10-style prompt via tool_use
// scored cset 5/10, cshr 0/10, $0.004/call, 2.7s avg.
//
// Hypotheses per variant, grouped by what we think Haiku struggles with:
//
//   QUALITY-focused (fix cset/cshr/amount/date)
//     H1  XML-tagged instructions     — Claude responds well to <tag> structure
//     H2  Extended thinking enabled   — Claude's opt-in reasoning
//     H3  Few-shot 1 example          — show a labeled Target receipt
//     H4  System prompt separation    — instructions in system turn
//     H5  Chain-of-thought scratchpad — "first list items, then categorize, then sum"
//     H6  Itemize-first (T10 style)   — model returns line items; we sum server-side
//
//   FORMAT-focused (reduce hallucination / drift)
//     H7  Prefilled response start    — Claude feature: steer JSON
//     H8  Merchant-aware hints        — "Target receipts split into these sections..."
//     H9  Verify-your-sum step        — "double-check total before returning"
//     H10 Thematic-first (T1 style)   — holidays/seasonal before generic mapping
//
// Each variant runs on 5 receipts × 2 runs = 10 Haiku calls.
// 10 variants × 10 = 100 calls. Estimated $0.40 total, ~10 min.

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

// ─── Shared prompt fragments ───────────────────────────────────────
const C3 = `\n\nCATEGORY RULE — itemize then consolidate:\nStep 1: For each line item, assign {description, price, categoryId}. Step 2: Group by categoryId and sum. Step 3: Return one categoryAmounts entry per distinct categoryId.`;
const C4 = `\n\nCATEGORY RULE — use tax markers:\nReceipts often mark each item with tax codes (T, F, N, S, O). Taxed non-food (T) → Home Supplies (30186) or Other (30426); non-taxed (N, F) → Groceries (22695).`;
const C6 = `\n\nCATEGORY RULE — detailed category→item mapping:\nFood/produce/meat/pantry → 22695 Groceries.\nBeverages from a cafe → 21716; bottled drinks from a supermarket → 22695.\nCleaning, paper towels, ziploc/foil, pet items → 30186 Home Supplies.\nBatteries, stationery, pens, office supplies → 30426 Other.\nKids' toys, school workbooks, kids clothes → 1276 Kid's Stuff.\nPharmacy/OTC medicine → 17351 Health/Pharmacy.\nFuel, parking, tolls → 48281 Transportation/Gas.\nWork safety gear, uniforms → 47837 Employment Expenses.\nHardware, electrical, lighting, paint → 30186 Home Supplies.`;
const T1_THEMATIC = `\n\nCATEGORY RULE — thematic first-pass:\nBefore applying per-item category mapping, scan the full receipt for seasonal or thematic patterns. If you see items whose descriptions clearly tie to a holiday or theme, route them first:\n  • Easter eggs, Easter bunnies, Easter baskets, jelly beans in Easter packaging → 49552 Holidays/Birthdays\n  • Christmas ornaments, stockings, holiday gift items → 49552 Holidays/Birthdays\n  • Halloween candy, costumes, decor → 49552 Holidays/Birthdays\n  • Valentine candy, cards → 49552 Holidays/Birthdays\n  • Back-to-school workbooks, kids' crayons, lunchboxes → 1276 Kid's Stuff\nOnly items that DON'T match a theme fall through to the generic mappings below.`;

// ─── Tool schemas ──────────────────────────────────────────────────
const TOOL_STANDARD = {
  name: "return_receipt_data",
  description: "Return the extracted receipt data as a single structured response.",
  input_schema: {
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
  },
};

const TOOL_ITEMS = {
  name: "return_receipt_data",
  description: "Return receipt data with per-item categorization (we sum server-side).",
  input_schema: {
    type: "object",
    properties: {
      merchant: { type: "string" }, merchantLegalName: { type: "string" },
      date: { type: "string", description: "YYYY-MM-DD" },
      amount: { type: "number" },
      lineItems: {
        type: "array",
        items: {
          type: "object",
          properties: {
            description: { type: "string" },
            price: { type: "number" },
            categoryId: { type: "integer" },
          },
          required: ["description", "price", "categoryId"],
        },
      },
      notes: { type: "string" },
    },
    required: ["merchant", "date", "amount", "lineItems"],
  },
};

// ─── Helpers ───────────────────────────────────────────────────────
function categoryList(cats) {
  return cats
    .filter(c => c.tag !== "supercharge" && c.tag !== "recurring_income" && !c.deleted)
    .map(c => c.tag ? `  - id=${c.id} name="${c.name}" tag="${c.tag}"` : `  - id=${c.id} name="${c.name}"`)
    .join("\n");
}

function baselinePrompt(cats) {
  // Matches the test-haiku.js baseline so variants are comparable.
  return C3 + C4 + C6 + T1_THEMATIC + "\n\n" + buildPrompt(cats);
}

// ─── Variant builders ──────────────────────────────────────────────

// H1 — XML-tagged instructions. Claude docs recommend <task>, <rules>, <categories>.
function H1_xml(cats) {
  return `<task>Extract receipt data and return it via the return_receipt_data tool.</task>

<rules>
  <rule id="merchant">Consumer brand from the header (Target, Walmart, Costco, Sam's Club). Never a cashier or customer name.</rule>
  <rule id="date">YYYY-MM-DD. Prefer the transaction date over print or due date.</rule>
  <rule id="amount">Final total paid. Ignore GST/VAT summary rows.</rule>
  <rule id="categorySplit">For multi-category receipts, group line items by categoryId and sum. One categoryAmounts entry per distinct categoryId. Sum MUST equal amount within $0.05.</rule>
</rules>

<categoryMap>
  <cat id="22695">Food, produce, meat, pantry, bottled drinks from supermarket</cat>
  <cat id="30186">Cleaning, paper goods, ziploc, foil, pet items, batteries, stationery, hardware, electrical, paint</cat>
  <cat id="30426">Misc items not matching any other bucket</cat>
  <cat id="1276">Kids' toys, school workbooks, kids clothes</cat>
  <cat id="17351">Pharmacy, OTC medicine, personal care</cat>
  <cat id="21716">Restaurants, cafe drinks</cat>
  <cat id="48281">Fuel, parking, tolls</cat>
  <cat id="49552">Easter/Christmas/Halloween/Valentine seasonal items</cat>
  <cat id="52714">Apparel, clothes</cat>
  <cat id="57937">Games, toys for adults, entertainment</cat>
</categoryMap>

<availableCategoryIds>
${categoryList(cats)}
</availableCategoryIds>

<seasonal-first-pass>Before per-item rules, scan for holiday-themed items (Easter egg/bunny/basket, Christmas/Valentine/Halloween) and route to 49552.</seasonal-first-pass>`;
}

// H2 — Extended thinking enabled.
function H2_thinking(cats) { return baselinePrompt(cats); }

// H3 — Few-shot with one worked example.
function H3_fewshot(cats) {
  return `${baselinePrompt(cats)}

EXAMPLE — here's a Target receipt we already labeled correctly:
  Merchant: Target
  Line items visible:
    BUBBL'R $6.20, Lean Cuisine $3.59, GG Milk $6.38   (Grocery section)
    Bocce's Bakry $7.99, BootsBarkley $16.99           (Home section, pet items)
    Tax $2.30
  Correct extraction:
    amount: 43.45
    categoryAmounts: [
      {categoryId: 22695, amount: 16.63},  // food items only
      {categoryId: 30186, amount: 26.82}   // pet items + tax
    ]
  Reasoning: Target's GROCERY items → 22695. HOME pet items → 30186. Tax distributed to the dominant non-food section.

Now apply the same logic to the receipt image provided.`;
}

// H4 — System-prompt separation (instructions in system, brief task in user).
// Implemented by passing `system` to Anthropic API.
function H4_sys_system(cats) {
  return `You are a receipt-reading assistant. Extract purchase details from the receipt image provided in the user turn and return them via the return_receipt_data tool.
${C3}${C4}${C6}${T1_THEMATIC}

Available categories:
${categoryList(cats)}

Do not invent categoryIds. Omit categoryAmounts if no category fits.`;
}
function H4_sys_user(_cats) { return "Extract this receipt."; }

// H5 — Chain-of-thought scratchpad. Ask Haiku to think step-by-step inline.
function H5_cot(cats) {
  return `${baselinePrompt(cats)}

Before calling return_receipt_data, think through the receipt step by step IN A SCRATCHPAD block:

<scratchpad>
- Step 1: Identify the merchant from the header.
- Step 2: Read the TOTAL line for the amount.
- Step 3: Find the transaction date.
- Step 4: List each line item with its price and assign a categoryId (use the mapping above).
- Step 5: Group by categoryId and sum. Verify sums equal amount within $0.05.
</scratchpad>

THEN call return_receipt_data with the final answer.`;
}

// H6 — Itemize-first (T10 style). Model returns lineItems; we sum server-side.
function H6_items(cats) {
  return `Extract receipt data. For the lineItems field, list every purchased item with:
  - description (as printed)
  - price (numeric, after any item-specific discount)
  - categoryId (one of the ids below)

DO NOT compute categoryAmounts. DO NOT sum anything. We handle the arithmetic server-side — your job is per-item OCR + categorization.
${T1_THEMATIC}
${C6}

Available categories:
${categoryList(cats)}`;
}

// H7 — Prefilled response. Start the assistant turn with {"merchant":" to steer output.
function H7_prefill(cats) { return baselinePrompt(cats); }

// H8 — Merchant-aware hints. Tell Haiku what to expect per-merchant.
function H8_merchant(cats) {
  return `${baselinePrompt(cats)}

MERCHANT-SPECIFIC GUIDANCE:
- **Target**: receipts have section headers (APPAREL, GROCERY, HOME, KITCHEN, HEALTH & BEAUTY, ELECTRONICS, GARAGE & HARDWARE). Each section maps to one category — APPAREL→52714, GROCERY→22695, HOME/KITCHEN/HARDWARE→30186, HEALTH & BEAUTY→17351, ELECTRONICS→30186 (unless it's games/movies then 57937).
- **Sam's Club / Costco**: mostly groceries (22695). Non-food items (cleaning, batteries, ziploc, paper towels, pet items) → 30186. Clothing items → 52714.
- **Walmart**: mixed. Look for seasonal themes (Easter candy → 49552). Grocery items → 22695. Apparel → 52714. Household → 30186. Toys/kids → 1276.`;
}

// H9 — Verify-your-sum. Explicit double-check step.
function H9_verify(cats) {
  return `${baselinePrompt(cats)}

FINAL VERIFICATION STEP (do this BEFORE calling the tool):
  1. Re-read the printed TOTAL line. Does it match your 'amount' field?
  2. Sum your categoryAmounts. Does Σ equal amount within $0.05?
  3. Are all categoryIds from the available list?
If any check fails, fix before responding. Never return amounts that don't sum to the printed total.`;
}

// H10 — Thematic-first (already in baseline but emphasized in variant to isolate effect).
// This is our baseline prompt — serves as H10 reference to compare XML/fewshot/etc. to.
function H10_thematic_first(cats) { return baselinePrompt(cats); }

// ─── Variant table ─────────────────────────────────────────────────
const VARIANTS = [
  { id: "H1_xml",       build: H1_xml,           tool: TOOL_STANDARD, thinking: false, prefill: false, system: null,                 desc: "XML-tagged instructions" },
  { id: "H2_thinking",  build: H2_thinking,      tool: TOOL_STANDARD, thinking: true,  prefill: false, system: null,                 desc: "Extended thinking enabled (budget_tokens=2048)" },
  { id: "H3_fewshot",   build: H3_fewshot,       tool: TOOL_STANDARD, thinking: false, prefill: false, system: null,                 desc: "One labeled Target example" },
  { id: "H4_system",    build: H4_sys_user,      tool: TOOL_STANDARD, thinking: false, prefill: false, system: H4_sys_system,        desc: "Rules in system prompt" },
  { id: "H5_cot",       build: H5_cot,           tool: TOOL_STANDARD, thinking: false, prefill: false, system: null,                 desc: "Chain-of-thought scratchpad" },
  { id: "H6_items",     build: H6_items,         tool: TOOL_ITEMS,    thinking: false, prefill: false, system: null,                 desc: "Itemize-first, server-side sum" },
  { id: "H7_prefill",   build: H7_prefill,       tool: null,          thinking: false, prefill: true,  system: null,                 desc: "Prefilled JSON response start (no tool_use)" },
  { id: "H8_merchant",  build: H8_merchant,      tool: TOOL_STANDARD, thinking: false, prefill: false, system: null,                 desc: "Per-merchant guidance" },
  { id: "H9_verify",    build: H9_verify,        tool: TOOL_STANDARD, thinking: false, prefill: false, system: null,                 desc: "Explicit verify-sum step" },
  { id: "H10_baseline", build: H10_thematic_first, tool: TOOL_STANDARD, thinking: false, prefill: false, system: null,               desc: "Thematic-first baseline (reference)" },
];

// ─── Runner ────────────────────────────────────────────────────────
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

async function call({ imageBytes, mimeType, variant, userPrompt, systemPrompt }) {
  let lastErr;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const req = {
        model: MODEL,
        max_tokens: 4096,
        messages: [{
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: mimeType, data: imageBytes.toString("base64") } },
            { type: "text", text: userPrompt },
          ],
        }],
      };
      if (systemPrompt) req.system = systemPrompt;
      if (variant.thinking) req.thinking = { type: "enabled", budget_tokens: 2048 };
      if (variant.tool) {
        req.tools = [variant.tool];
        req.tool_choice = { type: "tool", name: variant.tool.name };
      }
      if (variant.prefill) {
        req.messages.push({ role: "assistant", content: [{ type: "text", text: "{\n" }] });
      }
      const res = await client.messages.create(req);
      let parsed;
      if (variant.tool) {
        const tu = res.content.find(c => c.type === "tool_use");
        if (!tu) throw new Error("No tool_use block");
        parsed = tu.input;
      } else {
        // Prefill path: reconstruct JSON from prefilled "{\n" + model text.
        const text = res.content.find(c => c.type === "text")?.text || "";
        parsed = JSON.parse("{\n" + text);
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

function itemsToCategoryAmounts(lineItems) {
  const byCat = new Map();
  for (const item of lineItems || []) {
    if (typeof item.categoryId !== "number" || typeof item.price !== "number") continue;
    byCat.set(item.categoryId, (byCat.get(item.categoryId) || 0) + item.price);
  }
  return [...byCat.entries()].map(([categoryId, amount]) => ({ categoryId, amount: Math.round(amount * 100) / 100 }));
}

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("Set ANTHROPIC_API_KEY in tools/ocr-harness/.env first.");
    process.exit(1);
  }
  const labels = JSON.parse(fs.readFileSync(path.join(ROOT, "test-data", "labels.json"), "utf8"));
  const receipts = TEST_FILES.map(f => labels.find(l => l.file === f)).filter(Boolean);
  console.log(`Haiku 10-variant A/B on ${receipts.length} receipts × ${VARIANTS.length} variants × 2 runs = ${receipts.length*VARIANTS.length*2} calls\n`);

  const results = [];
  for (const label of receipts) {
    const cats = TEST_CATEGORIES.filter(c => label.categoryAmounts.map(x => x.categoryId).includes(c.id));
    const img = fs.readFileSync(path.join(ROOT, "test-data", "images", label.file));
    const mime = mimeFor(label.file);
    console.log(`=== ${label.file} amount=$${label.amount} ===`);
    for (const v of VARIANTS) {
      const userPrompt = v.build(cats);
      const systemPrompt = typeof v.system === "function" ? v.system(cats) : v.system;
      for (const run of [1, 2]) {
        process.stdout.write(`  ${v.id.padEnd(12)} run${run} `);
        try {
          const t0 = Date.now();
          const r = await call({ imageBytes: img, mimeType: mime, variant: v, userPrompt, systemPrompt });
          const ms = Date.now() - t0;
          // For H6 (items-only), synthesize categoryAmounts for the grader.
          const effectiveParsed = { ...r.parsed };
          if (v.tool === TOOL_ITEMS && r.parsed.lineItems) {
            effectiveParsed.categoryAmounts = itemsToCategoryAmounts(r.parsed.lineItems);
          }
          const grade = gradeResult(label, effectiveParsed);
          const ca = effectiveParsed.categoryAmounts || [];
          const sumCA = ca.reduce((s, c) => s + (c.amount || 0), 0);
          const drift = Math.abs(sumCA - (r.parsed.amount || 0));
          const cset = grade.categoryAmounts?.setMatch ? "✓" : "✗";
          const cshr = grade.categoryAmounts?.shareMatch ? "✓" : "✗";
          console.log(`m${grade.merchant.pass?"✓":"✗"} d${grade.date.pass?"✓":"✗"} a${grade.amount.pass?"✓":"✗"} sum${drift<=0.05?"✓":"✗"} cset${cset} cshr${cshr} drift $${drift.toFixed(2)} in=${r.usage.input_tokens}tok out=${r.usage.output_tokens}tok ${ms}ms`);
          results.push({ file: label.file, variant: v.id, run, grade, sumMatch: drift <= 0.05, drift, usage: r.usage, ms });
        } catch (e) {
          console.log(`ERR ${e.message.slice(0,80)}`);
          results.push({ file: label.file, variant: v.id, run, error: e.message });
        }
      }
    }
    console.log();
  }

  console.log(`=== Aggregate (${receipts.length} receipts × 2 runs = ${receipts.length*2} calls/variant) ===`);
  for (const v of VARIANTS) {
    const rs = results.filter(r => r.variant === v.id && r.grade);
    const n = rs.length;
    if (!n) continue;
    const m = rs.filter(r => r.grade.merchant.pass).length;
    const d = rs.filter(r => r.grade.date.pass).length;
    const a = rs.filter(r => r.grade.amount.pass).length;
    const sum = rs.filter(r => r.sumMatch).length;
    const cset = rs.filter(r => r.grade.categoryAmounts?.setMatch).length;
    const cshr = rs.filter(r => r.grade.categoryAmounts?.shareMatch).length;
    const avgIn = rs.reduce((s,r) => s + (r.usage?.input_tokens || 0), 0) / n;
    const avgOut = rs.reduce((s,r) => s + (r.usage?.output_tokens || 0), 0) / n;
    const avgMs = rs.reduce((s,r) => s + r.ms, 0) / n;
    const estCostPerCall = (avgIn * 1 + avgOut * 5) / 1e6;
    console.log(`${v.id.padEnd(12)} ${v.desc.padEnd(45)}  m ${m}/${n}  d ${d}/${n}  a ${a}/${n}  sum ${sum}/${n}  cset ${cset}/${n}  cshr ${cshr}/${n}  in ${avgIn.toFixed(0)}  out ${avgOut.toFixed(0)}  ${avgMs.toFixed(0)}ms  ~\$${estCostPerCall.toFixed(4)}/call`);
  }

  const outFile = path.join(ROOT, "results", `haiku-10-variants-${new Date().toISOString().replace(/[:.]/g,"-")}.json`);
  fs.writeFileSync(outFile, JSON.stringify({ run: "haiku-10-variants", model: MODEL, results }, null, 2));
  console.log(`\nSaved → ${path.relative(ROOT, outFile)}`);
}

main().catch(e => { console.error("Fatal:", e.stack || e.message); process.exit(1); });
