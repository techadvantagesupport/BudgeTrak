#!/usr/bin/env node
// Call 3 — given a v30 item list + the receipt image, determine each item's
// actual paid price in integer cents, using surrounding clues on the receipt
// (quantity multipliers, line coupons/discounts, manufacturer rebates).
//
// No categories are passed to Call 3 — it's a pure pricing pass.
//
// Runs Call 2 (v30) first to get items, then Call 3 on those items. Scores:
//   - priceSum vs receipt total (from Call 1 / label)
//   - per-item prices vs eyeball reasonableness
//
// Usage: node scripts/test-lite-c3.js

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

// ─── Call 2: v30 (locked) ───────────────────────────────────────────
function call2Prompt(cats) {
  return `List every PURCHASED item with a category. Return JSON {lineItems: [{description, categoryId}]}.

Rules:
  - Skip promos, coupons, discounts, tenders, subtotals.
  - Prefer a concrete consumer category (Groceries, Home Supplies, Health/Pharmacy, Clothes, Entertainment, Holidays, Kid's Stuff) over "Other".
  - Avoid these unless the item is unambiguously that type: Mortgage/Insurance/PropTax (42007), Insurance (36973), Transportation/Gas (48281 — only fuel/parking/transit), Electric/Gas (17132 — only utility bills), Phone/Internet/Computer (62776 — only service bills), Business, Employment, Farm, Charity.

Include "Sales Tax". Categories:
${categoryList(cats)}`;
}

const CALL2_SCHEMA = {
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

// ─── Call 3: per-item pricing (image + item list, no categories) ───
function call3Prompt(items) {
  const listed = items.map((it, i) => `  ${i + 1}. ${it.description}`).join("\n");
  return `You have a receipt image and a list of items the shopper purchased. For each item, find it on the receipt and determine the ACTUAL PAID PRICE — what contributed to the subtotal — in integer cents.

Apply these clues when reading each line:
  1. Base printed price for the item's line.
  2. Quantity multiplier: lines like "2 AT 1 FOR \$X.XX", "3 @ \$X.XX ea", or "4 FOR \$X.XX" mean the actual charge is the multiplier × unit price. Use the line's total, not the unit price.
  3. Line-level coupons or manufacturer rebates: a subsequent line showing a negative amount (e.g. "COUPON -\$3.00", "SAVE -\$1.50", "MFR -\$2.00") under or near the item reduces that item's price. Subtract it.
  4. Weight-priced items: "X.X LB @ \$Y.YY/LB" — use the computed total already printed.
  5. For "Sales Tax", return the printed tax amount in cents.

Analyse each item separately. Return JSON {prices: [{description, priceCents}]}, one entry per input item, preserving the order given. priceCents is a non-negative integer.

Items (find these in this exact order on the receipt):
${listed}`;
}

const CALL3_SCHEMA = {
  type: "object",
  properties: {
    prices: {
      type: "array",
      items: {
        type: "object",
        properties: {
          description: { type: "string" },
          priceCents: { type: "integer" },
        },
        required: ["description", "priceCents"],
      },
    },
  },
  required: ["prices"],
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

async function runOne(file) {
  const imgPath = path.join(ROOT, "test-data", "images", file);
  const imageBytes = fs.readFileSync(imgPath);
  const mimeType = mimeFor(file);

  const c2 = await liteCall({
    parts: [{ text: call2Prompt(TEST_CATEGORIES) }, { inlineData: { mimeType, data: imageBytes.toString("base64") } }],
    schema: CALL2_SCHEMA,
  });
  const items = c2.parsed.lineItems || [];

  const c3 = await liteCall({
    parts: [{ text: call3Prompt(items) }, { inlineData: { mimeType, data: imageBytes.toString("base64") } }],
    schema: CALL3_SCHEMA,
  });
  const prices = c3.parsed.prices || [];

  return { items, prices, tokens: { c2: c2.tokens, c3: c3.tokens } };
}

// Post-processing: scale non-tax items so priceSum exactly equals the receipt
// total. Receipt-level discounts (Target Circle 5%, Walmart Discount Given)
// live at the subtotal and aren't knowable per-line, so we distribute the
// delta proportionally and keep the tax line exact.
//
// totalCents comes from Call 1 / label. Tax line is detected by description.
function reconcilePrices(prices, totalCents) {
  const rows = prices.map(p => ({ ...p, priceCents: p.priceCents || 0 }));
  const isTax = (d) => typeof d === "string" && /sales\s*tax/i.test(d);
  const taxIdx = rows.findIndex(r => isTax(r.description));
  const taxCents = taxIdx >= 0 ? rows[taxIdx].priceCents : 0;

  const targetNonTax = totalCents - taxCents;
  const rawNonTaxSum = rows.reduce((s, r, i) => s + (i === taxIdx ? 0 : r.priceCents), 0);
  if (rawNonTaxSum <= 0) return rows;

  const scale = targetNonTax / rawNonTaxSum;
  const reconciled = rows.map((r, i) =>
    i === taxIdx ? r : { ...r, priceCents: Math.round(r.priceCents * scale) }
  );

  // Absorb any final rounding residual into the largest non-tax item so the
  // sum is exact to the penny.
  const actualSum = reconciled.reduce((s, r) => s + r.priceCents, 0);
  const residual = totalCents - actualSum;
  if (residual !== 0) {
    let largestIdx = -1, largestVal = -1;
    for (let i = 0; i < reconciled.length; i++) {
      if (i === taxIdx) continue;
      if (reconciled[i].priceCents > largestVal) {
        largestVal = reconciled[i].priceCents;
        largestIdx = i;
      }
    }
    if (largestIdx >= 0) reconciled[largestIdx].priceCents += residual;
  }
  return reconciled;
}

(async () => {
  console.log("═════ Call 3 test — v30 Call 2 → Call 3 pricing ═════\n");
  const out = [];
  for (const file of RECEIPTS) {
    const label = labelByFile.get(file);
    process.stdout.write(`${file}\n`);
    try {
      const r = await runOne(file);
      const labelTotalCents = Math.round(label.amount * 100);
      const pricesRec = reconcilePrices(r.prices, labelTotalCents);
      const rawSumCents = r.prices.reduce((s, p) => s + (p.priceCents || 0), 0);
      const recSumCents = pricesRec.reduce((s, p) => s + (p.priceCents || 0), 0);
      const itemMatch = r.items.length === r.prices.length;
      out.push({
        file, label, ...r,
        pricesReconciled: pricesRec,
        rawSumCents, recSumCents, labelTotalCents,
        rawDrift: (rawSumCents - labelTotalCents) / 100,
        recDrift: (recSumCents - labelTotalCents) / 100,
        itemMatch,
      });
      console.log(`  items=${r.items.length} prices=${r.prices.length} match=${itemMatch}`);
      console.log(`  raw:  priceSum=$${(rawSumCents/100).toFixed(2)}  drift=$${((rawSumCents - labelTotalCents)/100).toFixed(2)}`);
      console.log(`  recd: priceSum=$${(recSumCents/100).toFixed(2)}  drift=$${((recSumCents - labelTotalCents)/100).toFixed(2)}  (target=$${(labelTotalCents/100).toFixed(2)})`);
    } catch (e) {
      console.log(`  FAIL: ${e.message}`);
      out.push({ file, error: e.message });
    }
  }

  // ─── Per-item dump so we can eyeball pricing ───
  console.log("\n" + "═".repeat(90));
  console.log("PER-ITEM PRICES (Call 2 item + Call 3 priceCents)");
  console.log("═".repeat(90));
  for (const row of out) {
    if (row.error) { console.log(`\n### ${row.file} — FAIL: ${row.error}`); continue; }
    console.log(`\n### ${row.file}   raw=$${(row.rawSumCents/100).toFixed(2)}  reconciled=$${(row.recSumCents/100).toFixed(2)}  target=$${(row.labelTotalCents/100).toFixed(2)}`);
    const n = Math.max(row.items.length, row.prices.length);
    for (let i = 0; i < n; i++) {
      const it = row.items[i];
      const pr = row.prices[i];
      const prRec = row.pricesReconciled[i];
      const desc = it?.description || pr?.description || "???";
      const cat = it ? catName.get(it.categoryId) || it.categoryId : "—";
      const rawP = pr ? `$${(pr.priceCents / 100).toFixed(2)}` : "—";
      const recP = prRec ? `$${(prRec.priceCents / 100).toFixed(2)}` : "—";
      console.log(`  ${String(i + 1).padStart(3)}. ${String(desc).padEnd(22)} [${String(cat).slice(0, 10).padEnd(10)}]  raw=${rawP.padStart(7)}  rec=${recP.padStart(7)}`);
    }
  }

  // ─── Token cost ───
  console.log("\n" + "═".repeat(90));
  console.log("TOKEN COST");
  console.log("═".repeat(90));
  let c2In = 0, c2Out = 0, c3In = 0, c3Out = 0;
  for (const row of out) {
    if (row.error) continue;
    c2In += row.tokens.c2?.promptTokenCount || 0;
    c2Out += row.tokens.c2?.candidatesTokenCount || 0;
    c3In += row.tokens.c3?.promptTokenCount || 0;
    c3Out += row.tokens.c3?.candidatesTokenCount || 0;
  }
  const c2Cost = (c2In * 0.10 + c2Out * 0.40) / 1_000_000;
  const c3Cost = (c3In * 0.10 + c3Out * 0.40) / 1_000_000;
  console.log(`  Call 2 (v30):   in=${c2In}  out=${c2Out}  cost=$${c2Cost.toFixed(5)}`);
  console.log(`  Call 3 (price): in=${c3In}  out=${c3Out}  cost=$${c3Cost.toFixed(5)}`);
  console.log(`  Combined:       cost=$${(c2Cost + c3Cost).toFixed(5)}`);

  const outPath = path.join(ROOT, "results", `lite-c3-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log(`\nSaved → ${path.relative(ROOT, outPath)}`);
})();
