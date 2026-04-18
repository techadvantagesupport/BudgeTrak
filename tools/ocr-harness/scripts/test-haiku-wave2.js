#!/usr/bin/env node
// Haiku Wave 2: 10 variants iterating on Wave 1 findings.
//
// Wave 1 ceiling: cset 6/10 (H8 merchant hints), cshr 0/10 everywhere.
// Wave 2 strategy:
//   - Fix H2 (extended thinking) and H7 (prefill) that errored
//   - Iterate on H8 merchant-aware (the current winner)
//   - Attack cshr specifically — no Wave 1 variant broke 0/10
//   - Try one much-bigger-model variant (Sonnet 4.6) as a ceiling check

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
const HAIKU = "claude-haiku-4-5-20251001";
const SONNET = "claude-sonnet-4-6-20250929";

const TEST_FILES = [
  "target_long_1.jpg", "target_long_2.jpg",
  "walmart_1.jpg", "sams_2.jpg", "sams_club.jpg",
];

const C6 = `\nCATEGORY RULE — detailed mapping:\nFood/produce/meat/pantry → 22695 Groceries. Cleaning/ziploc/pet items/hardware/paint → 30186 Home Supplies. Batteries/stationery/pens → 30186 Home Supplies. Kids' toys/school workbooks/kids clothes → 1276 Kid's Stuff. Pharmacy/OTC medicine/personal care → 17351 Health/Pharmacy. Apparel → 52714 Clothes. Fuel/parking → 48281 Transportation/Gas. Easter/Christmas/Halloween/Valentine items → 49552 Holidays/Birthdays. Games/toys/entertainment → 57937 Entertainment.`;
const T1_THEMATIC = `\nTHEMATIC FIRST-PASS: Before per-item mapping, scan the receipt for seasonal/holiday items (Easter eggs/bunnies/baskets, Christmas, Halloween candy, Valentine). Route those to 49552 first; only non-themed items fall through to the generic mapping.`;
const MERCHANT_HINTS = `\nMERCHANT-SPECIFIC SECTIONS:\n- **Target**: receipts have APPAREL/GROCERY/HOME/KITCHEN/HEALTH & BEAUTY/ELECTRONICS/GARAGE & HARDWARE sections. APPAREL→52714, GROCERY→22695, HOME/KITCHEN/HARDWARE→30186, HEALTH & BEAUTY→17351, ELECTRONICS→30186 (unless clearly games/movies then 57937).\n- **Sam's Club / Costco**: mostly groceries (22695). Non-food (cleaning, batteries, ziploc, pet) → 30186. Apparel → 52714.\n- **Walmart**: mixed. Easter/holiday candy → 49552. Grocery → 22695. Apparel → 52714. Household → 30186. Toys/kids → 1276.`;

const SCHEMA_OBJ_TOOL = {
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

function categoryList(cats) {
  return cats
    .filter(c => c.tag !== "supercharge" && c.tag !== "recurring_income" && !c.deleted)
    .map(c => c.tag ? `  - id=${c.id} name="${c.name}" tag="${c.tag}"` : `  - id=${c.id} name="${c.name}"`)
    .join("\n");
}

function wave1BasePrompt(cats) {
  return `You are a receipt-reading assistant. Extract purchase details and return them via the tool.\n${C6}${T1_THEMATIC}\n\nAvailable categoryIds:\n${categoryList(cats)}`;
}

// ─── Wave 2 variants ───────────────────────────────────────────────

// W2_01: Extended thinking — no forced tool; Claude can write JSON directly.
// Hypothesis: Claude's reasoning helps cshr.
function W2_01(cats) {
  return `${wave1BasePrompt(cats)}\n\nReturn your answer as a JSON object wrapped in a single <json>...</json> block. Fields: merchant, date (YYYY-MM-DD), amount (number), categoryAmounts (array of {categoryId, amount}), notes (optional).`;
}

// W2_02: Prefill without tool. Response starts with { and we reconstruct JSON.
function W2_02(cats) {
  return `${wave1BasePrompt(cats)}\n\nReturn ONLY a JSON object (no prose, no code fences) with keys: merchant, date (YYYY-MM-DD), amount, categoryAmounts (array of {categoryId, amount}), notes.`;
}

// W2_03: Merchant hints in XML format (H8 + H1 combo from Wave 1).
function W2_03(cats) {
  return `<task>Extract receipt data via return_receipt_data tool.</task>\n\n<merchant-sections>${MERCHANT_HINTS}</merchant-sections>\n\n<mapping>${C6}</mapping>\n\n<seasonal>${T1_THEMATIC}</seasonal>\n\n<categories>\n${categoryList(cats)}\n</categories>`;
}

// W2_04: Sonnet 4.6 as a ceiling check — much pricier but likely smarter.
function W2_04(cats) { return wave1BasePrompt(cats); }

// W2_05: Hard constraint on sum integrity AND per-category discipline.
function W2_05(cats) {
  return `${wave1BasePrompt(cats)}\n${MERCHANT_HINTS}\n\nCRITICAL DISCIPLINE:\n1. Your categoryAmounts entries MUST sum to amount within $0.05.\n2. Each categoryAmount MUST equal the sum of the items you assigned to that category.\n3. Read each item's price carefully — misread prices cause category drift.\n4. Before returning, mentally verify: Σ categoryAmounts = amount, and each category's total reflects its actual items.`;
}

// W2_06: Verify the total + each category by re-reading.
function W2_06(cats) {
  return `${wave1BasePrompt(cats)}\n${MERCHANT_HINTS}\n\nAFTER filling fields, re-read the receipt image and verify:\n- Does your amount match the printed TOTAL line exactly?\n- Does each categoryAmount reflect the real items in that category? (Walk through your mental assignments.)\n- Do all categoryAmounts sum to amount?\nFix any mismatch BEFORE submitting.`;
}

// W2_07: Merchant sections with EXPECTED subtotal lines.
function W2_07(cats) {
  return `${wave1BasePrompt(cats)}\n\nMERCHANT SECTION SUBTOTALS: Many Target/Walmart receipts print per-section subtotal lines. If you see 'APPAREL $240.14' or similar section headers with totals, use those printed subtotals directly as your categoryAmounts entries for that section. Only sum individual items when no section subtotal is printed.\n${MERCHANT_HINTS}`;
}

// W2_08: Much simpler prompt — maybe Haiku is getting confused by verbosity.
function W2_08(cats) {
  return `Extract this receipt. Return via tool.\n\nmerchant: consumer brand (Target/Sam's/Walmart/Costco)\ndate: YYYY-MM-DD\namount: printed total\ncategoryAmounts: [{categoryId, amount}] — split by category, summing to total\n\nCategories: ${cats.map(c => `${c.id}=${c.name}`).join(", ")}`;
}

// W2_09: Items-first with explicit cross-validation.
function W2_09(cats) {
  return `${wave1BasePrompt(cats)}\n\nFILL both categoryAmounts AND include an internal sanity-check: before you commit to the output, list the items you're assigning to each category (mental list) and verify the per-category totals match your categoryAmounts.`;
}

// W2_10: Per-receipt-type expected structure. Assumes receipt is one of 4 merchants.
function W2_10(cats) {
  return `This receipt is from Target, Walmart, Sam's Club, or Costco. Identify the merchant first.\n\nThen apply:\n- Target: 7 possible sections (APPAREL 52714, GROCERY 22695, HOME/KITCHEN/HARDWARE 30186, HEALTH&BEAUTY 17351, ELECTRONICS 30186 or 57937). One categoryAmount per section present.\n- Walmart: mixed. Look for Easter/holiday themes → 49552. Otherwise 22695/30186/52714/1276.\n- Sam's/Costco: mostly groceries. 1-3 categories typical (22695/30186/52714).\n\n${T1_THEMATIC}\n\nAvailable categoryIds:\n${categoryList(cats)}\n\nReturn via tool.`;
}

const VARIANTS = [
  { id: "W2_01_think",     build: W2_01, model: HAIKU, thinking: 2048, tool: false, prefill: false, desc: "extended thinking (no tool)" },
  { id: "W2_02_prefill",   build: W2_02, model: HAIKU, thinking: 0,    tool: false, prefill: true,  desc: "prefilled JSON response" },
  { id: "W2_03_xml_merch", build: W2_03, model: HAIKU, thinking: 0,    tool: true,  prefill: false, desc: "XML-tagged + merchant hints" },
  { id: "W2_04_sonnet",    build: W2_04, model: SONNET, thinking: 0,   tool: true,  prefill: false, desc: "Sonnet 4.6 (ceiling check)" },
  { id: "W2_05_discipline",build: W2_05, model: HAIKU, thinking: 0,    tool: true,  prefill: false, desc: "hard sum/category discipline" },
  { id: "W2_06_verify",    build: W2_06, model: HAIKU, thinking: 0,    tool: true,  prefill: false, desc: "re-read and verify" },
  { id: "W2_07_sections",  build: W2_07, model: HAIKU, thinking: 0,    tool: true,  prefill: false, desc: "use section subtotals" },
  { id: "W2_08_simple",    build: W2_08, model: HAIKU, thinking: 0,    tool: true,  prefill: false, desc: "minimal prompt" },
  { id: "W2_09_xcheck",    build: W2_09, model: HAIKU, thinking: 0,    tool: true,  prefill: false, desc: "item cross-validation" },
  { id: "W2_10_typed",     build: W2_10, model: HAIKU, thinking: 0,    tool: true,  prefill: false, desc: "per-merchant typed structure" },
];

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const TOOL = {
  name: "return_receipt_data",
  description: "Return extracted receipt data.",
  input_schema: SCHEMA_OBJ_TOOL,
};

async function call({ imageBytes, mimeType, variant, userPrompt }) {
  let lastErr;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const req = {
        model: variant.model,
        max_tokens: 4096,
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
        // When thinking is enabled, tool_choice must be "auto" not forced
        req.tool_choice = variant.thinking > 0 ? { type: "auto" } : { type: "tool", name: TOOL.name };
      }
      if (variant.prefill) {
        req.messages.push({ role: "assistant", content: [{ type: "text", text: "{\n" }] });
      }
      const res = await client.messages.create(req);
      let parsed;
      if (variant.tool) {
        const tu = res.content.find(c => c.type === "tool_use");
        if (tu) { parsed = tu.input; }
        else {
          // tool_choice auto — model may have chosen to write text instead
          const text = res.content.filter(c => c.type === "text").map(c => c.text).join("\n");
          const match = text.match(/<json>([\s\S]*?)<\/json>/) || text.match(/\{[\s\S]+\}/);
          if (!match) throw new Error("No tool_use and no JSON in text response");
          parsed = JSON.parse(match[1] ?? match[0]);
        }
      } else if (variant.prefill) {
        const text = res.content.filter(c => c.type === "text").map(c => c.text).join("");
        parsed = JSON.parse("{\n" + text);
      } else {
        // No tool — expect JSON in text (in <json> block for thinking variants)
        const text = res.content.filter(c => c.type === "text").map(c => c.text).join("\n");
        const jsonMatch = text.match(/<json>([\s\S]*?)<\/json>/) || text.match(/\{[\s\S]+\}/);
        if (!jsonMatch) throw new Error("No JSON found in response");
        parsed = JSON.parse(jsonMatch[1] ?? jsonMatch[0]);
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

async function main() {
  const labels = JSON.parse(fs.readFileSync(path.join(ROOT, "test-data", "labels.json"), "utf8"));
  const receipts = TEST_FILES.map(f => labels.find(l => l.file === f)).filter(Boolean);
  console.log(`Haiku Wave 2: ${receipts.length} receipts × ${VARIANTS.length} variants × 2 runs = ${receipts.length*VARIANTS.length*2} calls\n`);

  const results = [];
  for (const label of receipts) {
    const cats = TEST_CATEGORIES.filter(c => label.categoryAmounts.map(x => x.categoryId).includes(c.id));
    const img = fs.readFileSync(path.join(ROOT, "test-data", "images", label.file));
    const mime = mimeFor(label.file);
    console.log(`=== ${label.file} amount=$${label.amount} ===`);
    for (const v of VARIANTS) {
      const userPrompt = v.build(cats);
      for (const run of [1, 2]) {
        process.stdout.write(`  ${v.id.padEnd(18)} run${run} `);
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
          results.push({ file: label.file, variant: v.id, run, grade, sumMatch: drift <= 0.05, drift, usage: r.usage, ms });
        } catch (e) {
          console.log(`ERR ${String(e.message).slice(0,80)}`);
          results.push({ file: label.file, variant: v.id, run, error: e.message });
        }
      }
    }
    console.log();
  }

  console.log(`=== Aggregate (${receipts.length} × 2 runs = ${receipts.length*2} calls/variant) ===`);
  for (const v of VARIANTS) {
    const rs = results.filter(r => r.variant === v.id && r.grade);
    const n = rs.length;
    if (!n) { console.log(`${v.id.padEnd(18)} ${v.desc.padEnd(40)}  all errored`); continue; }
    const m = rs.filter(r => r.grade.merchant.pass).length;
    const d = rs.filter(r => r.grade.date.pass).length;
    const a = rs.filter(r => r.grade.amount.pass).length;
    const sum = rs.filter(r => r.sumMatch).length;
    const cset = rs.filter(r => r.grade.categoryAmounts?.setMatch).length;
    const cshr = rs.filter(r => r.grade.categoryAmounts?.shareMatch).length;
    const avgIn = rs.reduce((s,r) => s + (r.usage?.input_tokens || 0), 0) / n;
    const avgOut = rs.reduce((s,r) => s + (r.usage?.output_tokens || 0), 0) / n;
    const avgMs = rs.reduce((s,r) => s + r.ms, 0) / n;
    const isSonnet = v.model === SONNET;
    const inRate = isSonnet ? 3 : 1;
    const outRate = isSonnet ? 15 : 5;
    const cost = (avgIn * inRate + avgOut * outRate) / 1e6;
    console.log(`${v.id.padEnd(18)} ${v.desc.padEnd(40)}  m ${m}/${n}  d ${d}/${n}  a ${a}/${n}  sum ${sum}/${n}  cset ${cset}/${n}  cshr ${cshr}/${n}  in ${avgIn.toFixed(0)}  out ${avgOut.toFixed(0)}  ${avgMs.toFixed(0)}ms  ~\$${cost.toFixed(4)}/call`);
  }

  const outFile = path.join(ROOT, "results", `haiku-wave2-${new Date().toISOString().replace(/[:.]/g,"-")}.json`);
  fs.writeFileSync(outFile, JSON.stringify({ run: "haiku-wave2", results }, null, 2));
  console.log(`\nSaved → ${path.relative(ROOT, outFile)}`);
}

main().catch(e => { console.error("Fatal:", e.stack || e.message); process.exit(1); });
