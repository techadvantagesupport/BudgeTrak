#!/usr/bin/env node
// Side-by-side: 3-call Lite pipeline (our v30 Call 2 + Call 3 + reconcile)
// vs single-call Pro 2.5 (the R7-T10 multi-cat incumbent).
//
// Both methods receive ONLY the label's expected categoryIds. Metrics:
//   - merchant / date / amount accuracy (±$0.01)
//   - category set recall (did all expected categoryIds appear?)
//   - category share match (within max($2.00, 15%) per bucket)
//   - cost ($) per receipt
//   - elapsed ms per receipt
//   - Lite-only: line-item count, priceSum drift (raw + reconciled)
//
// Usage: node scripts/test-bakeoff-lite3-vs-pro.js

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
const LITE = "gemini-2.5-flash-lite";
const PRO = "gemini-2.5-pro";

// Pricing per 1M tokens (Google Cloud list, ≤200k context).
const PRICING = {
  [LITE]: { in: 0.10, out: 0.40 },
  [PRO]:  { in: 1.25, out: 10.00 },
};

const client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

function mimeFor(f) {
  const e = path.extname(f).toLowerCase();
  if (e === ".png") return "image/png";
  if (e === ".webp") return "image/webp";
  return "image/jpeg";
}

function categoryList(cats) {
  return cats.map(c => c.tag ? `  - id=${c.id} name="${c.name}" tag="${c.tag}"` : `  - id=${c.id} name="${c.name}"`).join("\n");
}

// ─── Pro 2.5 (R7-T10 incumbent: C3+C4+C6+MP + buildPrompt) ─────────
const C3 = `\n\nCATEGORY RULE — itemize then consolidate:\nStep 1: For each line item, assign {description, price, categoryId}. Step 2: Group by categoryId and sum. Step 3: Return one categoryAmounts entry per distinct categoryId.`;
const C4 = `\n\nCATEGORY RULE — use tax markers:\nReceipts often mark each item with tax codes (T, F, N, S, O). Taxed non-food (T) → Home Supplies (30186) or Other (30426); non-taxed (N, F) → Groceries (22695).`;
const C6 = `\n\nCATEGORY RULE — detailed category→item mapping:\nFood/produce/meat/pantry → 22695 Groceries.\nBeverages from a cafe → 21716; bottled drinks from a supermarket → 22695.\nCleaning, paper towels, ziploc/foil, pet items → 30186 Home Supplies.\nBatteries, stationery, pens, office supplies → 30426 Other.\nKids' toys, school workbooks, kids clothes → 1276 Kid's Stuff.\nPharmacy/OTC medicine → 17351 Health/Pharmacy.\nFuel, parking, tolls → 48281 Transportation/Gas.\nWork safety gear, uniforms → 47837 Employment Expenses.\nHardware, electrical, lighting, paint → 30186 Home Supplies.`;
const MP = `\n\nPRIORITY REMINDER: merchant and amount are the most important fields. Do not compromise them while attending to category work. Merchant MUST be the consumer brand (not a cashier name, customer name, or translated English word).`;

const PRO_SCHEMA = {
  type: "object",
  properties: {
    merchant: { type: "string" }, merchantLegalName: { type: "string" },
    date: { type: "string" }, amount: { type: "number" },
    categoryAmounts: { type: "array", items: { type: "object", properties: { categoryId: { type: "integer" }, amount: { type: "number" } }, required: ["categoryId", "amount"] } },
    notes: { type: "string" },
  },
  required: ["merchant", "date", "amount"],
};

async function apiCall(model, parts, schema) {
  let lastErr;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await client.models.generateContent({
        model,
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

async function runPro(imageBytes, mimeType, cats) {
  const prompt = C3 + C4 + C6 + MP + "\n\n" + buildPrompt(cats);
  const t0 = Date.now();
  const r = await apiCall(PRO, [
    { text: prompt },
    { inlineData: { mimeType, data: imageBytes.toString("base64") } },
  ], PRO_SCHEMA);
  return { ...r, elapsedMs: Date.now() - t0 };
}

// ─── Lite 3-call pipeline ───────────────────────────────────────────
function call1Prompt() {
  return `Extract receipt header data as JSON: {merchant, merchantLegalName?, date, amountCents (integer)}.
- merchant is the consumer brand.
- date MUST be YYYY-MM-DD ISO.
- amountCents is the INTEGER number of cents for the paid total. Ignore subtotal, pre-tax, tax-summary rows.`;
}
const CALL1_SCHEMA = {
  type: "object",
  properties: {
    merchant: { type: "string" },
    merchantLegalName: { type: "string" },
    date: { type: "string" },
    amountCents: { type: "integer" },
  },
  required: ["merchant", "date", "amountCents"],
};

function call2Prompt(cats, preselected = false) {
  const preselectNudge = preselected
    ? `\n  - The categories below are pre-selected by the shopper for this receipt. Try to cover as many of them as reasonably fit — the shopper expects to see items in these specific buckets. But skip a category if no item on the receipt plausibly fits it; never force-fit an item into a bucket that clearly doesn't match (the shopper may have pre-selected a category by accident).\n  - When an item could plausibly fit either a niche/specialty category (e.g. Holidays/Birthdays, Kid's Stuff, Entertainment, Clothes, Health/Pharmacy) or a general catch-all (e.g. Groceries, Home Supplies, Other), prefer the niche category. Niche categories are under-filled by default; err toward the specific bucket when the item has a clear specialty signal.`
    : "";
  return `List every PURCHASED item with a category. Return JSON {lineItems: [{description, categoryId}]}.

Rules:
  - Skip promos, coupons, discounts, tenders, subtotals.
  - Prefer a concrete consumer category (Groceries, Home Supplies, Health/Pharmacy, Clothes, Entertainment, Holidays, Kid's Stuff) over "Other".
  - Avoid these unless the item is unambiguously that type: Mortgage/Insurance/PropTax (42007), Insurance (36973), Transportation/Gas (48281 — only fuel/parking/transit), Electric/Gas (17132 — only utility bills), Phone/Internet/Computer (62776 — only service bills), Business, Employment, Farm, Charity.${preselectNudge}

Include "Sales Tax". Categories:
${categoryList(cats)}`;
}
const CALL2_SCHEMA = {
  type: "object",
  properties: {
    lineItems: { type: "array", items: { type: "object", properties: { description: { type: "string" }, categoryId: { type: "integer" } }, required: ["description", "categoryId"] } },
  },
  required: ["lineItems"],
};

function call3Prompt(items) {
  const listed = items.map((it, i) => `  ${i + 1}. ${it.description}`).join("\n");
  return `You have a receipt image and a list of items the shopper purchased. For each item, find it on the receipt and determine the ACTUAL PAID PRICE — what contributed to the subtotal — in integer cents.

Apply these clues when reading each line:
  1. Base printed price for the item's line.
  2. Quantity multiplier: lines like "2 AT 1 FOR \$X.XX", "3 @ \$X.XX ea", or "4 FOR \$X.XX" mean the actual charge is the multiplier × unit price. Use the line's total, not the unit price.
  3. Line-level coupons or manufacturer rebates (a subsequent line with a negative amount, e.g. "COUPON -\$3.00") reduce that item's price.
  4. Weight-priced items: use the computed total already printed.
  5. For "Sales Tax", return the printed tax amount in cents.

Return JSON {prices: [{description, priceCents}]}, one entry per input item, preserving the order given. priceCents is a non-negative integer.

Items:
${listed}`;
}
const CALL3_SCHEMA = {
  type: "object",
  properties: {
    prices: { type: "array", items: { type: "object", properties: { description: { type: "string" }, priceCents: { type: "integer" } }, required: ["description", "priceCents"] } },
  },
  required: ["prices"],
};

function reconcilePrices(prices, totalCents) {
  const rows = prices.map(p => ({ ...p, priceCents: p.priceCents || 0 }));
  const isTax = (d) => typeof d === "string" && /sales\s*tax/i.test(d);
  const taxIdx = rows.findIndex(r => isTax(r.description));
  const taxCents = taxIdx >= 0 ? rows[taxIdx].priceCents : 0;
  const targetNonTax = totalCents - taxCents;
  const rawNonTaxSum = rows.reduce((s, r, i) => s + (i === taxIdx ? 0 : r.priceCents), 0);
  if (rawNonTaxSum <= 0) return rows;
  const scale = targetNonTax / rawNonTaxSum;
  const reconciled = rows.map((r, i) => i === taxIdx ? r : { ...r, priceCents: Math.round(r.priceCents * scale) });
  const actualSum = reconciled.reduce((s, r) => s + r.priceCents, 0);
  const residual = totalCents - actualSum;
  if (residual !== 0) {
    let largestIdx = -1, largestVal = -1;
    for (let i = 0; i < reconciled.length; i++) {
      if (i === taxIdx) continue;
      if (reconciled[i].priceCents > largestVal) { largestVal = reconciled[i].priceCents; largestIdx = i; }
    }
    if (largestIdx >= 0) reconciled[largestIdx].priceCents += residual;
  }
  return reconciled;
}

// Remap any line-item categoryId that the model invented (not present in the
// provided cats list) to a safe fallback. Preferred fallback order:
//   1. "Other" (30426) if it's in the provided list
//   2. The most-used valid categoryId on this receipt
//   3. First provided category
// Needed because when the model can't place an item (commonly "Sales Tax"
// when none of the preselected cats is a natural tax home), it sometimes
// emits a hallucinated integer like 99999 or 10000.
function remapInvalidCategoryIds(items, cats) {
  const validSet = new Set(cats.map(c => c.id));
  const invalidIndexes = [];
  for (let i = 0; i < items.length; i++) {
    if (!validSet.has(items[i].categoryId)) invalidIndexes.push(i);
  }
  if (invalidIndexes.length === 0) return items;

  // Pick fallback
  let fallback = null;
  if (validSet.has(30426)) {
    fallback = 30426;
  } else {
    const counts = new Map();
    for (const it of items) if (validSet.has(it.categoryId)) counts.set(it.categoryId, (counts.get(it.categoryId) || 0) + 1);
    let best = -1;
    for (const [cid, n] of counts) if (n > best) { fallback = cid; best = n; }
    if (fallback == null) fallback = cats[0]?.id;
  }

  return items.map((it, i) => invalidIndexes.includes(i) ? { ...it, categoryId: fallback } : it);
}

async function runLite(imageBytes, mimeType, cats) {
  const t0 = Date.now();
  const c1 = await apiCall(LITE, [
    { text: call1Prompt() },
    { inlineData: { mimeType, data: imageBytes.toString("base64") } },
  ], CALL1_SCHEMA);
  const c2 = await apiCall(LITE, [
    { text: call2Prompt(cats, /* preselected */ true) },
    { inlineData: { mimeType, data: imageBytes.toString("base64") } },
  ], CALL2_SCHEMA);
  const items = remapInvalidCategoryIds(c2.parsed.lineItems || [], cats);
  const c3 = await apiCall(LITE, [
    { text: call3Prompt(items) },
    { inlineData: { mimeType, data: imageBytes.toString("base64") } },
  ], CALL3_SCHEMA);
  const prices = c3.parsed.prices || [];
  const elapsedMs = Date.now() - t0;

  // Reconcile to Call 1's amountCents so items sum to receipt total.
  const reconciled = reconcilePrices(prices, c1.parsed.amountCents || 0);

  // Build categoryAmounts by summing reconciled prices per category (Sales Tax
  // rolled into the most-populated non-tax category so the grader can evaluate
  // cset/cshr on an apples-to-apples basis with Pro's output).
  const byCat = new Map();
  const isTax = (d) => typeof d === "string" && /sales\s*tax/i.test(d);
  for (let i = 0; i < items.length; i++) {
    if (isTax(items[i].description)) continue;
    const cid = items[i].categoryId;
    const cents = reconciled[i]?.priceCents || 0;
    byCat.set(cid, (byCat.get(cid) || 0) + cents);
  }
  // Allocate the Sales Tax line to the dominant non-tax category (matches
  // how the labelling convention allocates tax proportionally).
  const taxIdx = items.findIndex(it => isTax(it.description));
  if (taxIdx >= 0) {
    const taxCents = reconciled[taxIdx]?.priceCents || 0;
    let bestCat = null, bestCents = -1;
    for (const [cid, cents] of byCat) if (cents > bestCents) { bestCat = cid; bestCents = cents; }
    if (bestCat != null) byCat.set(bestCat, byCat.get(bestCat) + taxCents);
  }
  const categoryAmounts = [...byCat.entries()].map(([categoryId, cents]) => ({ categoryId, amount: cents / 100 }));

  const synthesized = {
    merchant: c1.parsed.merchant,
    merchantLegalName: c1.parsed.merchantLegalName,
    date: c1.parsed.date,
    amount: (c1.parsed.amountCents || 0) / 100,
    categoryAmounts,
  };

  return {
    parsed: synthesized,
    elapsedMs,
    tokens: {
      c1: c1.tokens, c2: c2.tokens, c3: c3.tokens,
      totalIn: (c1.tokens?.promptTokenCount || 0) + (c2.tokens?.promptTokenCount || 0) + (c3.tokens?.promptTokenCount || 0),
      totalOut: (c1.tokens?.candidatesTokenCount || 0) + (c2.tokens?.candidatesTokenCount || 0) + (c3.tokens?.candidatesTokenCount || 0),
    },
    rawPrices: prices,
    reconciled,
    items,
  };
}

function costOf(model, tokens) {
  const p = PRICING[model];
  const inTok = tokens?.totalIn ?? tokens?.promptTokenCount ?? 0;
  const outTok = tokens?.totalOut ?? tokens?.candidatesTokenCount ?? 0;
  return (inTok * p.in + outTok * p.out) / 1_000_000;
}

(async () => {
  const labels = JSON.parse(fs.readFileSync(path.join(ROOT, "test-data", "labels.json"), "utf8"));
  const multi = labels.filter(l =>
    !l.file.startsWith("mcocr_") &&
    l.categoryAmounts && l.categoryAmounts.length > 1
  );
  console.log(`Bake-off: Lite 3-call vs Pro single-call on ${multi.length} English multi-cat receipts.\nExpected-cats-only (ideal-case test).\n`);

  const rows = [];
  for (const label of multi) {
    const groundIds = label.categoryAmounts.map(c => c.categoryId);
    const cats = TEST_CATEGORIES.filter(c => groundIds.includes(c.id));
    const img = fs.readFileSync(path.join(ROOT, "test-data", "images", label.file));
    const mime = mimeFor(label.file);

    process.stdout.write(`▶ ${label.file.slice(0, 40).padEnd(40)}  `);

    // Pro
    let pro, proErr = null;
    try { pro = await runPro(img, mime, cats); }
    catch (e) { proErr = e.message; }

    // Lite 3-call
    let lite, liteErr = null;
    try { lite = await runLite(img, mime, cats); }
    catch (e) { liteErr = e.message; }

    const proGrade = pro ? gradeResult(label, pro.parsed) : null;
    const liteGrade = lite ? gradeResult(label, lite.parsed) : null;
    const proCost = pro ? costOf(PRO, pro.tokens) : 0;
    const liteCost = lite ? costOf(LITE, lite.tokens) : 0;

    rows.push({
      file: label.file,
      label,
      pro: pro ? { parsed: pro.parsed, tokens: pro.tokens, elapsedMs: pro.elapsedMs, grade: proGrade, cost: proCost } : null,
      proErr,
      lite: lite ? { parsed: lite.parsed, tokens: lite.tokens, elapsedMs: lite.elapsedMs, grade: liteGrade, cost: liteCost, items: lite.items, reconciled: lite.reconciled } : null,
      liteErr,
    });

    const proSummary = proErr ? "FAIL" : `m${proGrade.merchant.pass?"✓":"✗"} d${proGrade.date.pass?"✓":"✗"} a${proGrade.amount.pass?"✓":"✗"} cset${proGrade.categoryAmounts.setMatch?"✓":"✗"} cshr${proGrade.categoryAmounts.shareMatch?"✓":"✗"}`;
    const liteSummary = liteErr ? "FAIL" : `m${liteGrade.merchant.pass?"✓":"✗"} d${liteGrade.date.pass?"✓":"✗"} a${liteGrade.amount.pass?"✓":"✗"} cset${liteGrade.categoryAmounts.setMatch?"✓":"✗"} cshr${liteGrade.categoryAmounts.shareMatch?"✓":"✗"}`;
    console.log(`Pro ${proSummary} $${proCost.toFixed(4)} ${pro?.elapsedMs||"-"}ms  |  Lite ${liteSummary} $${liteCost.toFixed(4)} ${lite?.elapsedMs||"-"}ms`);
  }

  // ─── Aggregate ───
  console.log("\n" + "═".repeat(96));
  console.log("AGGREGATE (14 English multi-cat receipts, expected-cats-only)");
  console.log("═".repeat(96));
  const agg = (rows, which) => {
    const ok = rows.filter(r => r[which]);
    const pass = (k) => ok.filter(r => r[which].grade[k].pass).length;
    const passCA = (k) => ok.filter(r => r[which].grade.categoryAmounts[k]).length;
    const totalCost = ok.reduce((s, r) => s + r[which].cost, 0);
    const totalMs = ok.reduce((s, r) => s + r[which].elapsedMs, 0);
    return {
      n: ok.length,
      m: pass("merchant"), d: pass("date"), a: pass("amount"),
      cset: passCA("setMatch"), cshr: passCA("shareMatch"),
      cost: totalCost, avgCost: totalCost / ok.length,
      ms: totalMs, avgMs: totalMs / ok.length,
    };
  };
  const p = agg(rows, "pro");
  const l = agg(rows, "lite");
  console.log(`Method        | n   | m     | d     | a     | cset  | cshr  | avg cost    | avg ms`);
  console.log("─".repeat(96));
  console.log(`Pro 2.5       | ${p.n}  | ${p.m}/${p.n}  | ${p.d}/${p.n}  | ${p.a}/${p.n}  | ${p.cset}/${p.n}  | ${p.cshr}/${p.n}  | $${p.avgCost.toFixed(5)}  | ${p.avgMs.toFixed(0)}`);
  console.log(`Lite 3-call   | ${l.n}  | ${l.m}/${l.n}  | ${l.d}/${l.n}  | ${l.a}/${l.n}  | ${l.cset}/${l.n}  | ${l.cshr}/${l.n}  | $${l.avgCost.toFixed(5)}  | ${l.avgMs.toFixed(0)}`);

  // Lite-only: line-item health
  console.log("\n── Lite line-item health ─────────────────");
  for (const r of rows) {
    if (!r.lite) continue;
    const itemCount = r.lite.items.length;
    const rawSum = r.lite.reconciled.reduce((s, p) => s + p.priceCents, 0);
    const targetSum = Math.round(r.label.amount * 100);
    const drift = (rawSum - targetSum) / 100;
    console.log(`  ${r.file.slice(0, 40).padEnd(40)}  items=${String(itemCount).padStart(3)}  reconciled priceSum=$${(rawSum/100).toFixed(2)}  (target $${(targetSum/100).toFixed(2)}, drift $${drift.toFixed(2)})`);
  }

  const outPath = path.join(ROOT, "results", `bakeoff-lite3-vs-pro-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(rows, null, 2));
  console.log(`\nSaved → ${path.relative(ROOT, outPath)}`);
})();
