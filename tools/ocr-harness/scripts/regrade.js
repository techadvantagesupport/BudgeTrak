#!/usr/bin/env node
// Re-grade an existing results JSON against the current labels.json,
// without re-running the harness. Used when we patch labels after a run.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gradeResult, summarize, pct } from "../src/grader.js";

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), "..");
const LABELS_PATH = path.join(ROOT, "test-data", "labels.json");

function bySource(results) {
  const out = {};
  for (const t of results) {
    const src = t.label.source || "?";
    out[src] = out[src] || { total: 0, m: 0, d: 0, a: 0, c: 0, ct: 0, lat: 0 };
    const b = out[src];
    b.total++; b.lat += t.elapsedMs || 0;
    if (t.grade) {
      if (t.grade.merchant.pass) b.m++;
      if (t.grade.date.pass) b.d++;
      if (t.grade.amount.pass) b.a++;
      if (!t.grade.category.skipped) { b.ct++; if (t.grade.category.pass) b.c++; }
    }
  }
  return out;
}

function english(bySrc) {
  const b = { total: 0, m: 0, d: 0, a: 0, c: 0, ct: 0, lat: 0 };
  for (const [src, v] of Object.entries(bySrc)) {
    if (src === "MC-OCR") continue;
    for (const k of Object.keys(b)) b[k] += v[k];
  }
  return b;
}

const files = process.argv.slice(2);
if (files.length === 0) {
  const resultsDir = path.join(ROOT, "results");
  const latest = fs.readdirSync(resultsDir).filter(f => f.endsWith(".json")).sort().slice(-4);
  files.push(...latest.map(f => path.join(resultsDir, f)));
}

const labels = JSON.parse(fs.readFileSync(LABELS_PATH, "utf8"));
const byFile = Object.fromEntries(labels.map(l => [l.file, l]));

for (const file of files) {
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  for (const t of data.results) {
    const fresh = byFile[t.label.file];
    if (fresh) {
      t.label = fresh;
      if (t.extracted) t.grade = gradeResult(fresh, t.extracted);
    }
  }
  const bySrc = bySource(data.results);
  const eng = english(bySrc);
  const viet = bySrc["MC-OCR"] || { total: 0, m: 0, d: 0, a: 0, c: 0, ct: 0, lat: 0 };
  const total = { total: eng.total + viet.total, m: eng.m + viet.m, d: eng.d + viet.d, a: eng.a + viet.a, c: eng.c + viet.c, ct: eng.ct + viet.ct };
  const model = data.results[0]?.model || "?";
  console.log();
  console.log(`=== ${model} (${data.promptVersion}) ===`);
  for (const [lang, v] of [["English (53)", eng], ["Vietnamese (50)", viet], ["OVERALL (103)", total]]) {
    console.log(`  ${lang.padEnd(18)} m ${pct(v.m, v.total)}  d ${pct(v.d, v.total)}  a ${pct(v.a, v.total)}  c ${v.ct ? pct(v.c, v.ct) : "—"}`);
  }
}
