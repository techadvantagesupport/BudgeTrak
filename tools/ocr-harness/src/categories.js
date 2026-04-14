// Real BudgeTrak category list, pulled from sync_diag_Paul.txt on 2026-04-14.
// This is the harness-only test list — update periodically as your live group
// adds/renames/deletes categories. Keeping the harness faithful to your actual
// buckets is what makes Gemini's "pick the right category" scores meaningful.
//
// Excluded from the prompt:
//  - id 34543 Supercharge (tag=supercharge) — special-purpose, not for ordinary receipts
//  - id  6716 Recurring Income (tag=recurring_income) — income-side, not expense OCR
// Both still exist in the real group; we just don't want Gemini picking them for
// expense-receipt extraction.

export const TEST_CATEGORIES = [
  { id: 1276,  name: "Kid's Stuff",                  tag: "" },
  { id: 17132, name: "Electric/Gas",                 tag: "" },
  { id: 17351, name: "Health/Pharmacy",              tag: "" },
  { id: 21716, name: "Restaurants/Prepared Food",    tag: "restaurants" },
  { id: 22695, name: "Groceries",                    tag: "groceries" },
  { id: 30186, name: "Home Supplies",                tag: "home_supplies" },
  { id: 30426, name: "Other",                        tag: "other" },
  { id: 35856, name: "Charity",                      tag: "charity" },
  { id: 36973, name: "Insurance",                    tag: "" },
  { id: 42007, name: "Mortgage/Insurance/PropTax",   tag: "" },
  { id: 47479, name: "Business",                     tag: "" },
  { id: 47837, name: "Employment Expenses",          tag: "" },
  { id: 48281, name: "Transportation/Gas",           tag: "transportation" },
  { id: 49552, name: "Holidays/Birthdays",           tag: "" },
  { id: 50371, name: "Farm",                         tag: "" },
  { id: 52714, name: "Clothes",                      tag: "clothes" },
  { id: 57937, name: "Entertainment",                tag: "entertainment" },
  { id: 62776, name: "Phone/Internet/Computer",      tag: "" },
];
