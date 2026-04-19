#!/usr/bin/env node
// Re-run V10 2-call on the app-sized Amazon receipts (1000px long edge,
// matching ReceiptManager.processAndSavePhoto). If results flip away from
// Transportation/Gas and Phone/Internet/Computer, image resolution is the
// cause of the device-vs-harness discrepancy the user reported.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import "dotenv/config";
import { GoogleGenAI } from "@google/genai";

import { TEST_CATEGORIES } from "../src/categories.js";

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), "..");
const LITE = "gemini-2.5-flash-lite";
const client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

function categoryList(cats) {
  return cats.map(c => c.tag ? `  - id=${c.id} name="${c.name}" tag="${c.tag}"` : `  - id=${c.id} name="${c.name}"`).join("\n");
}

const HEADER_BASE = `Extract receipt header data as JSON.

- merchant: the consumer brand (e.g. "McDonald's", "Target", "Costco"). Prefer the consumer brand over the legal operator entity. Preserve original language; don't translate.
- merchantLegalName: optional, only when the legal entity is clearly distinct from the consumer brand.
- date: YYYY-MM-DD ISO. Receipts often have multiple dates; prefer the transaction date over print/due dates. DD/MM locales: Malaysia, Singapore, Vietnam, most of Europe. MM/DD: US.
- amountCents: INTEGER number of cents for the final paid total (tax and tip included). Ignore subtotal, pre-tax lines, and separate GST/VAT summary tables. Vietnamese đồng (VND) has no fractional unit — dots in VND amounts are thousand separators; return the integer đồng value.`;

const COMMON = `
Category-picking constraints (global):
  - "Other" is reserved for items that no other category name plausibly describes.
  - Do NOT invent categoryIds not in the list.`;

function v10Call1Prompt(cats) {
  const intro = `
For each PURCHASED item on the receipt, follow these 5 steps:
  Step 1 (ITEM): name the literal thing (e.g. "rubber disc", "leather collar").
  Step 2 (FUNCTION): describe what it's used for (e.g. "creates friction on a car wheel"; "worn by a pet").
  Step 3 (DOMAIN): name the real-world domain in 1-3 nouns (e.g. "vehicle repair part"; "pet accessory").
  Step 4 (SCAN): for each category, evaluate whether its NAME contains a noun matching the Step 3 domain directly OR via a close synonym.
  Step 5 (SCORE): score up to 3 categories 0-100 based on how directly the name names the domain. Direct name-match = 80-100. Synonym match = 50-75. Weak fit = 20-50.

Return items[] with { description, scores: [{categoryId, score, reason}] }. Skip discounts; include "Sales Tax".
Also return multiCategoryLikely (true if items' top-1 domains differ) and topChoice (when false).`;
  return HEADER_BASE + intro + COMMON + `\n\nCategories:\n${categoryList(cats)}`;
}

const CALL1_SCHEMA = {
  type: "object",
  properties: {
    merchant: { type: "string" }, merchantLegalName: { type: "string" },
    date: { type: "string" }, amountCents: { type: "integer" },
    items: { type: "array", items: { type: "object", properties: { description: { type: "string" }, scores: { type: "array", items: { type: "object", properties: { categoryId: { type: "integer" }, score: { type: "number" }, reason: { type: "string" } }, required: ["categoryId", "score"] } } }, required: ["description", "scores"] } },
    multiCategoryLikely: { type: "boolean" }, topChoice: { type: "integer" }, notes: { type: "string" },
  },
  required: ["merchant", "date", "amountCents"],
};

(async () => {
  const cats = TEST_CATEGORIES;
  const nm = Object.fromEntries(cats.map(c => [c.id, c.name]));
  const prompt = v10Call1Prompt(cats);

  console.log("V10 Call 1 on APP-SIZED (1000px max) Amazon receipts:\n");
  for (const fname of ["amazon_brakepads.jpg", "amazon_charger.jpg", "amazon_tierodboots.jpg"]) {
    const img = fs.readFileSync(path.join(ROOT, "test-data", "amazon_app_sized", fname));
    const res = await client.models.generateContent({
      model: LITE,
      contents: [{ role: "user", parts: [
        { text: prompt },
        { inlineData: { mimeType: "image/jpeg", data: img.toString("base64") } },
      ] }],
      config: { responseMimeType: "application/json", responseSchema: CALL1_SCHEMA, temperature: 0 },
    });
    const parsed = JSON.parse(res.text);
    const nItems = (parsed.items || []).length;
    console.log(`  ${fname.padEnd(28)}  merchant="${parsed.merchant}"  items=${nItems}  multi=${parsed.multiCategoryLikely}  topChoice=${parsed.topChoice} (${nm[parsed.topChoice] || "?"})`);
    for (const it of (parsed.items || [])) {
      const top = [...(it.scores || [])].sort((a, b) => (b.score || 0) - (a.score || 0))[0];
      console.log(`     ${it.description.slice(0, 50).padEnd(50)} top=${nm[top?.categoryId] || "?"}(${top?.score})  reason="${(top?.reason || "").slice(0, 60)}"`);
    }
    console.log();
  }
})();
