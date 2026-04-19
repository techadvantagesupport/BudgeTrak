#!/usr/bin/env node
// Test V10 Call 1 on the brake-pads receipt at varying JPEG qualities to
// see when the categorization flips away from Transportation/Gas. If it
// flips at realistic compression levels, we know image quality is the
// cause of the device-vs-harness gap.

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

const HEADER = `Extract receipt header data as JSON.

- merchant: the consumer brand (e.g. "McDonald's", "Target", "Costco"). Prefer the consumer brand over the legal operator entity. Preserve original language; don't translate.
- merchantLegalName: optional, only when the legal entity is clearly distinct from the consumer brand.
- date: YYYY-MM-DD ISO. Receipts often have multiple dates; prefer the transaction date over print/due dates. DD/MM locales: Malaysia, Singapore, Vietnam, most of Europe. MM/DD: US.
- amountCents: INTEGER number of cents for the final paid total (tax and tip included). Ignore subtotal, pre-tax lines, and separate GST/VAT summary tables. Vietnamese đồng (VND) has no fractional unit — dots in VND amounts are thousand separators; return the integer đồng value.`;

function prompt(cats) {
  return HEADER + `

For each PURCHASED item on the receipt, follow these 5 steps:
  Step 1 (ITEM): name the literal thing (e.g. "rubber disc", "leather collar").
  Step 2 (FUNCTION): describe what it's used for (e.g. "creates friction on a car wheel"; "worn by a pet").
  Step 3 (DOMAIN): name the real-world domain in 1-3 nouns (e.g. "vehicle repair part"; "pet accessory").
  Step 4 (SCAN): for each category, evaluate whether its NAME contains a noun matching the Step 3 domain directly OR via a close synonym.
  Step 5 (SCORE): score up to 3 categories 0-100 based on how directly the name names the domain. Direct name-match = 80-100. Synonym match = 50-75. Weak fit = 20-50.

Return items[] with { description, scores: [{categoryId, score, reason}] }. Skip discounts; include "Sales Tax".
Also return multiCategoryLikely (true if items' top-1 domains differ) and topChoice (when false).

Category-picking constraints (global):
  - "Other" is reserved for items that no other category name plausibly describes.
  - Do NOT invent categoryIds not in the list.

Categories:
${categoryList(cats)}`;
}

const SCHEMA = {
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
  const txt = prompt(cats);

  console.log("Quality sweep on amazon_brakepads (1000px, varying JPEG q):\n");
  for (const q of [95, 90, 85, 80, 75, 70, 65, 60, 55, 50, 45, 40]) {
    const filename = `brakes_q${q}.jpg`;
    const fullPath = path.join(ROOT, "test-data", "amazon_app_sized", filename);
    if (!fs.existsSync(fullPath)) { console.log(`  q=${q} SKIP (no file)`); continue; }
    const img = fs.readFileSync(fullPath);
    try {
      const res = await client.models.generateContent({
        model: LITE,
        contents: [{ role: "user", parts: [
          { text: txt },
          { inlineData: { mimeType: "image/jpeg", data: img.toString("base64") } },
        ] }],
        config: { responseMimeType: "application/json", responseSchema: SCHEMA, temperature: 0 },
      });
      const p = JSON.parse(res.text);
      const top = [...(p.items?.[0]?.scores || [])].sort((a, b) => (b.score || 0) - (a.score || 0))[0];
      console.log(`  q=${q.toString().padStart(2)}  ${img.length.toString().padStart(6)}B  topChoice=${nm[p.topChoice] || "?"}(${p.topChoice})  item1_top=${nm[top?.categoryId] || "?"}(${top?.score})`);
    } catch (e) {
      console.log(`  q=${q}  ERR: ${e.message?.slice(0, 60)}`);
    }
  }
})();
