#!/usr/bin/env node
// Download public receipt-OCR datasets into test-data/images/ and append
// entries to labels.json. Uses HF's datasets-server rows API to avoid pulling
// the full Parquet file (they're 300+ MB each).
//
// Usage:
//   node scripts/download-test-data.js --source sroie   --count 50
//   node scripts/download-test-data.js --source mcocr   --count 50
//
// Images are downloaded to test-data/images/{source}_{N}.{ext} so they never
// collide with user-supplied receipts. labels.json is merged in-place.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), "..");
const LABELS_PATH = path.join(ROOT, "test-data", "labels.json");
const IMAGES_DIR = path.join(ROOT, "test-data", "images");

const SOURCES = {
  sroie: {
    dataset: "jsdnrs/ICDAR2019-SROIE",
    config: "default",
    split: "test",
    difficulty: "medium",
    parseRow: (row) => {
      const r = row.row;
      const e = r.entities || {};
      const dateISO = parseDateMDY(e.date);
      const amount = parseAmountDotDecimal(e.total);
      if (!e.company || !dateISO || amount == null) return null;
      return {
        merchant: e.company,
        date: dateISO,
        amount,
        categoryId: null,           // SROIE has no category labels
      };
    },
    imageField: (row) => row.row.image?.src,
  },
  mcocr: {
    dataset: "DThai/mcocr-test",
    config: "default",
    split: "train",
    difficulty: "hard",
    parseRow: (row) => {
      const r = row.row;
      // Ground truth is stringified JSON whose top-level key is "gt_parse".
      let parsed;
      try {
        const outer = typeof r.ground_truth === "string" ? JSON.parse(r.ground_truth) : r.ground_truth;
        parsed = outer?.gt_parse || outer;
      } catch { return null; }
      if (!parsed) return null;
      const merchant = parsed["Tên cửa hàng"] || parsed["SELLER"] || parsed["seller"];
      const dateRaw = parsed["Ngày bán"] || parsed["Ngày"] || parsed["TIMESTAMP"] ||
                      parsed["timestamp"] || parsed["Thời gian"];
      const totalRaw = parsed["Tổng tiền phải trả"] || parsed["Tổng thanh toán"] ||
                       parsed["Tiền thanh toán"] || parsed["TOTAL_COST"] || parsed["total"];
      const dateISO = parseDateFlexible(dateRaw);
      const amount = parseAmountVietnamese(totalRaw);
      if (!merchant || !dateISO || amount == null) return null;
      return { merchant, date: dateISO, amount, categoryId: null };
    },
    imageField: (row) => row.row.image?.src,
  },
};

// Parse DD/MM/YYYY or D/M/YY. SROIE uses day-first.
function parseDateMDY(raw) {
  if (!raw) return null;
  const m = String(raw).match(/(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{2,4})/);
  if (!m) return null;
  let [_, d, mo, y] = m;
  if (y.length === 2) y = (parseInt(y) > 50 ? "19" : "20") + y;
  return `${y}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}`;
}

// Vietnamese + mixed formats. Tries DD/MM/YYYY first, then ISO, then Vietnamese words.
function parseDateFlexible(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  // Try DD/MM/YYYY family (Vietnamese default is day-first).
  const dmy = parseDateMDY(s);
  if (dmy) return dmy;
  // Try ISO YYYY-MM-DD directly.
  const iso = s.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (iso) return `${iso[1]}-${iso[2].padStart(2,"0")}-${iso[3].padStart(2,"0")}`;
  return null;
}

// SROIE (Singapore/Malaysia): dot is decimal, no thousand separator typical.
// "193.00" → 193.00, "1,234.56" → 1234.56.
function parseAmountDotDecimal(raw) {
  if (raw == null) return null;
  const cleaned = String(raw).replace(/[^\d\.\-]/g, "");
  const n = parseFloat(cleaned);
  return isFinite(n) ? n : null;
}

// Vietnamese (đồng): integer currency. Dot and comma are both thousand separators.
// "1.500.000" or "1,500,000" both → 1500000. No sub-đồng fractions.
function parseAmountVietnamese(raw) {
  if (raw == null) return null;
  const cleaned = String(raw).replace(/[^\d\-]/g, ""); // strip everything non-digit
  const n = parseInt(cleaned, 10);
  return isFinite(n) ? n : null;
}

function parseArgs(argv) {
  const args = { source: null, count: 50, offset: 0 };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--source") args.source = argv[++i];
    else if (a === "--count") args.count = parseInt(argv[++i], 10);
    else if (a === "--offset") args.offset = parseInt(argv[++i], 10);
    else if (a === "--help") { console.log("usage: --source sroie|mcocr --count 50 [--offset 0]"); process.exit(0); }
  }
  if (!args.source || !SOURCES[args.source]) {
    console.error("usage: --source sroie|mcocr --count 50");
    process.exit(1);
  }
  return args;
}

async function fetchRows(source, offset, length) {
  const url = `https://datasets-server.huggingface.co/rows?dataset=${encodeURIComponent(source.dataset)}&config=${source.config}&split=${source.split}&offset=${offset}&length=${length}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HF rows API ${res.status}: ${await res.text()}`);
  const json = await res.json();
  return json.rows || [];
}

async function downloadImage(url, destPath) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`image fetch ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(destPath, buf);
  return buf.length;
}

function extFromContentType(url) {
  // HF cached-assets URLs typically end with .jpg/.png before the query string.
  const m = url.split("?")[0].match(/\.(jpg|jpeg|png|webp)$/i);
  return m ? m[1].toLowerCase() : "jpg";
}

async function main() {
  const args = parseArgs(process.argv);
  const src = SOURCES[args.source];
  console.log(`Fetching ${args.count} rows from ${src.dataset} (offset=${args.offset})`);

  const existingLabels = fs.existsSync(LABELS_PATH)
    ? JSON.parse(fs.readFileSync(LABELS_PATH, "utf8"))
    : [];
  const existingFiles = new Set(existingLabels.map(l => l.file));

  // HF rows API caps at 100 per request; loop if needed.
  let offset = args.offset;
  let added = 0;
  let attempted = 0;
  let batchSize = Math.min(100, args.count * 2); // over-fetch since some rows are skipped on parse failure

  while (added < args.count) {
    const rows = await fetchRows(src, offset, batchSize);
    if (rows.length === 0) {
      console.log("  (no more rows in dataset)");
      break;
    }
    for (const row of rows) {
      if (added >= args.count) break;
      attempted++;
      const parsed = src.parseRow(row);
      const imgSrc = src.imageField(row);
      if (!parsed || !imgSrc) continue;

      const seq = existingLabels.length + added + 1;
      const ext = extFromContentType(imgSrc);
      const filename = `${args.source}_${String(seq).padStart(4, "0")}.${ext}`;
      if (existingFiles.has(filename)) continue;

      const destPath = path.join(IMAGES_DIR, filename);
      try {
        const bytes = await downloadImage(imgSrc, destPath);
        console.log(`  ✓ ${filename}  ${parsed.merchant}  ${parsed.date}  ${parsed.amount}  (${(bytes/1024).toFixed(0)} KB)`);
        existingLabels.push({
          file: filename,
          source: args.source === "sroie" ? "SROIE" : "MC-OCR",
          difficulty: src.difficulty,
          merchant: parsed.merchant,
          date: parsed.date,
          amount: parsed.amount,
          categoryId: parsed.categoryId,
        });
        existingFiles.add(filename);
        added++;
      } catch (e) {
        console.log(`  ✗ ${filename}  download failed: ${e.message}`);
      }
    }
    offset += rows.length;
    if (rows.length < batchSize) break;
  }

  fs.writeFileSync(LABELS_PATH, JSON.stringify(existingLabels, null, 2) + "\n");
  console.log(`\nDone. Added ${added} entries (of ${attempted} attempted). Total labels.json = ${existingLabels.length}`);
}

main().catch(e => {
  console.error("Fatal:", e.stack || e.message);
  process.exit(1);
});
