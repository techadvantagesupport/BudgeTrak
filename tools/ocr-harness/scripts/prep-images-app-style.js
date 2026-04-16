#!/usr/bin/env node
// Preprocess test images the same way the Android app does before sending
// to Gemini OCR, so offline harness results reflect production quality.
//
// App pipeline (app/src/main/java/com/techadvantage/budgetrak/data/sync/ReceiptManager.kt):
//   1. Resize if max(w,h) > 1000px  → proportional, bilinear filter
//   2. JPEG compress to target bytes = pixelArea * 250KB / 1M pixels (±10%)
//
// Usage: node scripts/prep-images-app-style.js <src-dir> <dst-dir>

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const MAX_DIM = 1000;
const TARGET_BYTES_PER_MP = 250 * 1024;

const [, , srcDir, dstDir] = process.argv;
if (!srcDir || !dstDir) { console.error("Usage: prep-images-app-style.js <src> <dst>"); process.exit(1); }
fs.mkdirSync(dstDir, { recursive: true });

const EXTS = new Set([".jpg", ".jpeg", ".png", ".webp"]);
const files = fs.readdirSync(srcDir).filter(f => EXTS.has(path.extname(f).toLowerCase()));

const identify = (file) => {
  const out = execFileSync("magick", ["identify", "-format", "%w %h", file], { encoding: "utf8" });
  const [w, h] = out.trim().split(" ").map(Number);
  return { w, h };
};

let processed = 0, skipped = 0;
for (const f of files) {
  const src = path.join(srcDir, f);
  const outName = f.replace(/\.(jpe?g|png|webp)$/i, ".jpg");
  const dst = path.join(dstDir, outName);

  try {
    const { w, h } = identify(src);
    let newW = w, newH = h;
    if (Math.max(w, h) > MAX_DIM) {
      const scale = MAX_DIM / Math.max(w, h);
      newW = Math.round(w * scale);
      newH = Math.round(h * scale);
    }
    const targetBytes = Math.round((newW * newH * TARGET_BYTES_PER_MP) / 1_000_000);
    const targetKB = Math.max(10, Math.round(targetBytes / 1024));

    execFileSync("magick", [
      src,
      "-resize", `${MAX_DIM}x${MAX_DIM}>`,
      "-filter", "Triangle",
      "-define", `jpeg:extent=${targetKB}kb`,
      "-sampling-factor", "4:2:0",
      dst,
    ]);

    const after = identify(dst);
    const actualBytes = fs.statSync(dst).size;
    console.log(
      `${outName.padEnd(45)} ${w}x${h} → ${after.w}x${after.h}  ${(actualBytes/1024).toFixed(0)}KB (target ${targetKB}KB)`
    );
    processed++;
  } catch (e) {
    console.error(`SKIP ${f}: ${e.message}`);
    skipped++;
  }
}

console.log(`\nProcessed ${processed} | Skipped ${skipped} | Max edge ${MAX_DIM}px | JPEG target ${(TARGET_BYTES_PER_MP/1024).toFixed(0)}KB/MP`);
