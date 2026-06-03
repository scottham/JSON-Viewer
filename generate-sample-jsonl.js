// Generates sample-records.jsonl — one JSON object per line (a "list of dicts"),
// the JSONL/NDJSON case. Includes nested objects/arrays and varied schemas so
// the inspector's record-list view has something realistic to show. The last
// line is intentionally malformed to exercise per-line error tolerance.
const fs = require("fs");
const path = require("path");

const events = [
  { id: 1, ts: "2026-06-03T09:00:01Z", level: "info", user: { id: 42, name: "Ada" }, action: "login", meta: { ip: "10.0.0.1", agent: "Firefox/126", tags: ["web", "eu"] } },
  { id: 2, ts: "2026-06-03T09:00:05Z", level: "debug", user: { id: 42, name: "Ada" }, action: "open_file", meta: { path: "/docs/报告.json", bytes: 21370 } },
  { id: 3, ts: "2026-06-03T09:01:12Z", level: "warn", user: { id: 7, name: "Søren" }, action: "rate_limit", meta: { window: 60, count: 1001, blocked: true } },
  { id: 4, ts: "2026-06-03T09:02:00Z", level: "error", user: null, action: "db_timeout", meta: { query: "SELECT *", durationMs: 5200, replica: { region: "ap-northeast", lagMs: 153 } } },
  { id: 5, ts: "2026-06-03T09:03:30Z", level: "info", user: { id: 7, name: "Søren" }, action: "purchase", meta: { items: [{ sku: "A-100", qty: 2, price: 19.99 }, { sku: "B-204", qty: 1, price: 149.0 }], total: 188.98, currency: "EUR", emoji: "🛒" } },
  { id: 6, ts: "2026-06-03T09:04:10Z", level: "info", user: { id: 99, name: "山田" }, action: "logout", meta: {} },
];

const lines = events.map((e) => JSON.stringify(e));
// Intentionally broken final line to demonstrate graceful per-line handling.
lines.push('{ "id": 7, "action": "broken", oops }');

const out = path.join(__dirname, "sample-records.jsonl");
fs.writeFileSync(out, lines.join("\n") + "\n");
console.log("Wrote " + out + " (" + events.length + " valid records + 1 malformed line)");
