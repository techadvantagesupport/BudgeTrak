#!/usr/bin/env node
// Two-step Call 2 variant:
//   Step 2   (image + text): transcribe PURCHASED item descriptions only, no
//                            categorization. Also return merchant.
//   Step 2.5 (text only):    given the store name, items list, and category
//                            list, assign each item a categoryId. No image.
//
// Compares against v30 (single-call winner from round 4) on the same 3
// receipts. Scored the same way (recall of expected categories, extras,
// item count).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import "dotenv/config";
import { GoogleGenAI } from "@google/genai";

import { TEST_CATEGORIES } from "../src/categories.js";

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), "..");
const LITE = "gemini-2.5-flash-lite";

const RECEIPTS = ["target_long_1.jpg", "target_long_2.jpg", "walmart_2.jpg"];

const LABELS = JSON.parse(fs.readFileSync(path.join(ROOT, "test-data", "labels.json"), "utf8"));
const labelByFile = new Map(LABELS.map(l => [l.file, l]));
const catName = new Map(TEST_CATEGORIES.map(c => [c.id, c.name]));

function categoryList(cats) {
  return cats
    .filter(c => c.tag !== "supercharge" && c.tag !== "recurring_income" && !c.deleted)
    .map(c => c.tag ? `  - id=${c.id} name="${c.name}" tag="${c.tag}"` : `  - id=${c.id} name="${c.name}"`)
    .join("\n");
}

// ─── Step 2: transcribe only (image + text) ─────────────────────────
function step2Prompt() {
  return `Read this receipt and list every PURCHASED item on it. Do NOT categorize — only transcribe.

A PURCHASED ITEM is a product the shopper took home. It has a printed price that contributes to the subtotal.

NOT items (do NOT include these, even when they have a dollar amount):
  • Reward earn lines — e.g. "$5 GC Circle", "Earned \$X Rewards", "PROMO GFTCRD", "Target Circle earned", "Save \$X on next visit". These describe a reward the shopper earned, not something they bought.
  • Coupon / discount / manufacturer rebate lines (often negative amounts, or "Save \$X", "COUPON").
  • Subtotal, Tax Summary, Loyalty Points Balance, Membership Fee lines.
  • Tender / payment lines: VISA, MASTERCARD, CASH, DEBIT, CHANGE DUE, CARD ENDING IN, AUTH CODE, APPROVED.
  • "Regular Price \$X" / "Was \$X" reference text printed under an item — that is metadata on the item above, not a separate item.
  • "N AT 1 FOR \$X" quantity-detail text under an item — also metadata.
  • Store header/footer: address, phone, website, barcode, survey invitation, return policy, "you saved \$X today".

The "Sales Tax" line IS included as a final entry with description "Sales Tax".

Return JSON {merchant, lineItems: [{description}]}. Keep descriptions as printed on the receipt.`;
}

const STEP2_SCHEMA = {
  type: "object",
  properties: {
    merchant: { type: "string" },
    lineItems: {
      type: "array",
      items: {
        type: "object",
        properties: { description: { type: "string" } },
        required: ["description"],
      },
    },
  },
  required: ["merchant", "lineItems"],
};

// ─── Step 2.5: categorize only (text-only, no image) ────────────────
function step25Prompt(merchant, items, cats) {
  const itemsList = items.map((it, i) => `  ${i + 1}. ${it.description}`).join("\n");
  return `A shopper at "${merchant}" bought the items below. Assign each a categoryId.

Rules:
  - Prefer a concrete consumer category (Groceries, Home Supplies, Health/Pharmacy, Clothes, Entertainment, Holidays, Kid's Stuff) over "Other" (30426).
  - Avoid these unless the item is unambiguously that type: Mortgage/Insurance/PropTax (42007), Insurance (36973), Transportation/Gas (48281 — only fuel/parking/transit), Electric/Gas (17132 — only utility bills), Phone/Internet/Computer (62776 — only service bills), Business, Employment, Farm, Charity.

Return JSON {lineItems: [{description, categoryId}]} preserving input order and descriptions.

Items:
${itemsList}

Categories:
${categoryList(cats)}`;
}

const STEP25_SCHEMA = {
  type: "object",
  properties: {
    lineItems: {
      type: "array",
      items: {
        type: "object",
        properties: {
          description: { type: "string" },
          categoryId: { type: "integer" },
        },
        required: ["description", "categoryId"],
      },
    },
  },
  required: ["lineItems"],
};

// ─── Baseline: v30 single-call for direct comparison ───────────────
function v30Prompt(cats) {
  return `List every PURCHASED item with a category. Return JSON {lineItems: [{description, categoryId}]}.

Rules:
  - Skip promos, coupons, discounts, tenders, subtotals.
  - Prefer a concrete consumer category (Groceries, Home Supplies, Health/Pharmacy, Clothes, Entertainment, Holidays, Kid's Stuff) over "Other".
  - Avoid these unless the item is unambiguously that type: Mortgage/Insurance/PropTax (42007), Insurance (36973), Transportation/Gas (48281 — only fuel/parking/transit), Electric/Gas (17132 — only utility bills), Phone/Internet/Computer (62776 — only service bills), Business, Employment, Farm, Charity.

Include "Sales Tax". Categories:
${categoryList(cats)}`;
}

const V30_SCHEMA = {
  type: "object",
  properties: {
    lineItems: {
      type: "array",
      items: {
        type: "object",
        properties: {
          description: { type: "string" },
          categoryId: { type: "integer" },
        },
        required: ["description", "categoryId"],
      },
    },
  },
  required: ["lineItems"],
};

// ─── Runner ────────────────────────────────────────────────────────
const client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

async function liteCall({ parts, schema }) {
  let lastErr;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await client.models.generateContent({
        model: LITE,
        contents: [{ role: "user", parts }],
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

function scoreItems(items, label) {
  const expected = new Set((label.categoryAmounts || []).map(c => c.categoryId));
  const actual = new Set(items.map(it => it.categoryId).filter(Number.isFinite));
  const hits = [...expected].filter(id => actual.has(id)).length;
  const extras = [...actual].filter(id => !expected.has(id)).length;
  return { itemCount: items.length, expected: expected.size, actualDistinct: actual.size, recall: hits / expected.size, extras };
}

async function runSplit(file, cats) {
  const imgPath = path.join(ROOT, "test-data", "images", file);
  const imageBytes = fs.readFileSync(imgPath);
  const mimeType = mimeFor(file);

  // Step 2: transcribe only
  const s2 = await liteCall({
    parts: [{ inlineData: { mimeType, data: imageBytes.toString("base64") } }, { text: step2Prompt() }],
    schema: STEP2_SCHEMA,
  });
  const { merchant, lineItems: rawItems } = s2.parsed;

  // Step 2.5: text-only categorization
  const s25 = await liteCall({
    parts: [{ text: step25Prompt(merchant, rawItems, cats) }],
    schema: STEP25_SCHEMA,
  });

  return {
    items: s25.parsed.lineItems || [],
    merchant,
    tokens: {
      s2: s2.tokens,
      s25: s25.tokens,
      totalIn: (s2.tokens?.promptTokenCount || 0) + (s25.tokens?.promptTokenCount || 0),
      totalOut: (s2.tokens?.candidatesTokenCount || 0) + (s25.tokens?.candidatesTokenCount || 0),
    },
  };
}

async function runV30(file, cats) {
  const imgPath = path.join(ROOT, "test-data", "images", file);
  const imageBytes = fs.readFileSync(imgPath);
  const mimeType = mimeFor(file);
  const r = await liteCall({
    parts: [{ text: v30Prompt(cats) }, { inlineData: { mimeType, data: imageBytes.toString("base64") } }],
    schema: V30_SCHEMA,
  });
  return {
    items: r.parsed.lineItems || [],
    tokens: {
      totalIn: r.tokens?.promptTokenCount || 0,
      totalOut: r.tokens?.candidatesTokenCount || 0,
    },
  };
}

(async () => {
  console.log("═════ Split Call 2 (step 2 + step 2.5) vs v30 single-call ═════\n");
  const out = [];
  for (const file of RECEIPTS) {
    const label = labelByFile.get(file);
    process.stdout.write(`${file}\n`);
    try {
      const split = await runSplit(file, TEST_CATEGORIES);
      const splitScore = scoreItems(split.items, label);
      const v30 = await runV30(file, TEST_CATEGORIES);
      const v30Score = scoreItems(v30.items, label);
      out.push({ file, label, split, splitScore, v30, v30Score });
      console.log(`  split:  recall=${(splitScore.recall * 100).toFixed(0)}%  items=${splitScore.itemCount}  extras=${splitScore.extras}  in=${split.tokens.totalIn}  out=${split.tokens.totalOut}`);
      console.log(`  v30:    recall=${(v30Score.recall * 100).toFixed(0)}%  items=${v30Score.itemCount}  extras=${v30Score.extras}  in=${v30.tokens.totalIn}  out=${v30.tokens.totalOut}`);
    } catch (e) {
      console.log(`  FAIL: ${e.message}`);
      out.push({ file, error: e.message });
    }
  }

  console.log("\n" + "═".repeat(90));
  console.log("PER-RECEIPT BREAKDOWN");
  console.log("═".repeat(90));
  for (const row of out) {
    if (row.error) { console.log(`\n### ${row.file} — FAIL: ${row.error}`); continue; }
    const expected = (row.label.categoryAmounts || []).map(c => `${c.categoryId}=${catName.get(c.categoryId)}`).join(", ");
    console.log(`\n### ${row.file}  expected=[${expected}]`);
    for (const [name, r, score] of [["split", row.split, row.splitScore], ["v30", row.v30, row.v30Score]]) {
      const byCat = new Map();
      for (const it of r.items) {
        const arr = byCat.get(it.categoryId) || [];
        arr.push(it.description);
        byCat.set(it.categoryId, arr);
      }
      const summary = [...byCat.entries()]
        .map(([cid, descs]) => `${String(catName.get(cid) || `id:${cid}`).slice(0, 10)}:${descs.length}`)
        .join(" ");
      console.log(`  ${name.padEnd(6)} r=${(score.recall * 100).toFixed(0)}% items=${score.itemCount} x=${score.extras} — ${summary}`);
    }
  }

  // Token cost comparison
  console.log("\n" + "═".repeat(90));
  console.log("TOKEN COST");
  console.log("═".repeat(90));
  let splitIn = 0, splitOut = 0, v30In = 0, v30Out = 0;
  for (const row of out) {
    if (row.error) continue;
    splitIn += row.split.tokens.totalIn;
    splitOut += row.split.tokens.totalOut;
    v30In += row.v30.tokens.totalIn;
    v30Out += row.v30.tokens.totalOut;
  }
  const splitCost = (splitIn * 0.10 + splitOut * 0.40) / 1_000_000;
  const v30Cost = (v30In * 0.10 + v30Out * 0.40) / 1_000_000;
  console.log(`  split:  in=${splitIn}  out=${splitOut}  cost=$${splitCost.toFixed(5)}`);
  console.log(`  v30:    in=${v30In}  out=${v30Out}  cost=$${v30Cost.toFixed(5)}`);

  const outPath = path.join(ROOT, "results", `lite-c2-split-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log(`\nSaved → ${path.relative(ROOT, outPath)}`);
})();
