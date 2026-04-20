#!/usr/bin/env node
// V17: fix Call 1 prompt so it extracts the actual product names from
// Amazon-style receipts instead of the Order Summary section (Subtotal,
// Shipping, Total). On-device V16 saw tie-rod-boots and charger both
// come back with itemNames = ["Item(s) Subtotal:", "Shipping & Handling:",
// "Total before tax:", "Estimated tax to be collected:", "Grand Total:"],
// with the actual product name pushed into the notes field.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import "dotenv/config";
import { GoogleGenAI } from "@google/genai";

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), "..");
const LITE = "gemini-2.5-flash-lite";
const client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// V16 prompt (baseline)
const V16 = `Extract receipt data as JSON.

- merchant: the consumer brand (e.g. "McDonald's", "Target", "Costco").
- date: YYYY-MM-DD ISO.
- amountCents: INTEGER cents for the paid total.
- itemNames: array of strings, one per PURCHASED line item, text as printed on the receipt. Skip promos, coupons, discounts, tenders, subtotals, totals. INCLUDE "Sales Tax" (or any tax line) as its own entry.`;

// V17: explicit about what IS and IS NOT a line item.
const V17 = `Extract receipt data as JSON.

- merchant: the consumer brand (e.g. "McDonald's", "Target", "Costco"). Prefer the consumer brand over the legal operator entity.
- merchantLegalName: optional, when clearly distinct.
- date: YYYY-MM-DD ISO. Prefer the transaction/order date over print/due dates.
- amountCents: INTEGER cents for the final paid total (tax and tip included).
- itemNames: array of strings — the actual PURCHASED PRODUCTS on the receipt.

  INCLUDE in itemNames:
    - Every product the shopper bought, by its printed name (e.g. "BOSCH BE964H Blue Ceramic Disc Brake", "QZIIW iPhone 17 Pro Max Charger", "2% MILK 1GAL", "Tzatziki Dip"). On online-order receipts the product is usually shown alongside a thumbnail image; that's the one you want.
    - Tax lines, one per tax line (e.g. "Sales Tax", "Estimated tax to be collected", "GST"). These belong in itemNames as their own entry so downstream price-attribution can handle them.

  EXCLUDE from itemNames (these are NOT products — they're totals, shipping, fees, payment, or header info):
    - Subtotals / totals / grand totals: "Subtotal", "Item(s) Subtotal", "Total", "Grand Total", "Total before tax", "Total after tax", "Order total".
    - Shipping, handling, delivery: "Shipping", "Shipping & Handling", "Delivery", "S&H".
    - Discounts, promos, coupons, rewards: "Discount", "Savings", "Promotion", "Coupon", "Member discount", "Target Circle".
    - Payment tenders: "Visa ending in 1234", "Cash", "Credit", "Change", "Amount tendered".
    - Order metadata: order numbers, tracking numbers, addresses, "Sold by" lines.
    - Action buttons from online receipts ("Track package", "Cancel items", "Buy again", etc.).

  If the receipt is from an online order (Amazon, Target pickup, DoorDash, etc.) and you see a dedicated "Order Summary" section near the bottom with Subtotal/Shipping/Total rows, that section is SUMMARY only — do NOT list those rows as items. The actual products are usually shown earlier on the receipt next to their images and quantities.`;

const SCHEMA = {
  type: "object",
  properties: {
    merchant: { type: "string" },
    merchantLegalName: { type: "string" },
    date: { type: "string" },
    amountCents: { type: "integer" },
    itemNames: { type: "array", items: { type: "string" } },
    notes: { type: "string" },
  },
  required: ["merchant", "date", "amountCents", "itemNames"],
};

async function runCall1(imgBytes, mimeType, promptText) {
  const res = await client.models.generateContent({
    model: LITE,
    contents: [{ role: "user", parts: [
      { text: promptText },
      { inlineData: { mimeType, data: imgBytes.toString("base64") } },
    ] }],
    config: { responseMimeType: "application/json", responseSchema: SCHEMA, temperature: 0 },
  });
  return JSON.parse(res.text);
}

function mimeFor(f) { const e = path.extname(f).toLowerCase(); if (e === ".png") return "image/png"; if (e === ".webp") return "image/webp"; return "image/jpeg"; }

(async () => {
  const files = ["amazon_brakepads.jpg", "amazon_charger.jpg", "amazon_tierodboots.jpg"];
  // Test on app-sized (1000px) to match device bytes closely.
  for (const variant of [{ id: "V16", prompt: V16 }, { id: "V17", prompt: V17 }]) {
    console.log(`\n=== ${variant.id} ===`);
    for (const f of files) {
      const fullPath = path.join(ROOT, "test-data", "amazon_app_sized", f);
      if (!fs.existsSync(fullPath)) continue;
      const img = fs.readFileSync(fullPath);
      const r = await runCall1(img, mimeFor(f), variant.prompt);
      console.log(`  ${f.padEnd(28)} merchant="${r.merchant}" items=${r.itemNames.length}  notes="${(r.notes || "").slice(0,50)}"`);
      for (const n of r.itemNames) console.log(`    - ${n}`);
    }
  }
})();
