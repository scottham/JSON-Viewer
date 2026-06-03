// Generates sample-complex.json: a deeply nested, content-rich JSON document
// covering every type the inspector must render (objects, arrays, strings,
// numbers, booleans, null, unicode, deep nesting, mixed arrays, empties).
const fs = require("fs");
const path = require("path");

const rnd = (() => {
  let s = 1234567;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
})();

const pick = (arr) => arr[Math.floor(rnd() * arr.length)];

const FIRST = ["Ada", "Linus", "Grace", "Alan", "Margaret", "李雷", "山田", "Søren", "Zoë"];
const LAST = ["Lovelace", "Torvalds", "Hopper", "Turing", "Hamilton", "韩", "太郎", "Müller"];
const CITIES = ["Berlin", "東京", "São Paulo", "Reykjavík", "Nairobi", "Montréal"];
const TAGS = ["alpha", "beta", "internal", "deprecated", "experimental", "stable", "🚀", "priority"];

function makeAddress() {
  return {
    street: Math.floor(rnd() * 9999) + " " + pick(["Maple", "König", "桜", "Oak"]) + " St.",
    city: pick(CITIES),
    geo: { lat: +(rnd() * 180 - 90).toFixed(6), lng: +(rnd() * 360 - 180).toFixed(6) },
    metadata: rnd() > 0.5 ? { verified: rnd() > 0.5, source: pick(["gps", "manual", null]) } : null,
  };
}

function makeUser(i) {
  const tags = [];
  const n = Math.floor(rnd() * 4);
  for (let k = 0; k < n; k++) tags.push(pick(TAGS));
  return {
    id: i,
    uuid: "u-" + (1000 + i).toString(16) + "-" + Math.floor(rnd() * 1e6).toString(36),
    name: { first: pick(FIRST), last: pick(LAST) },
    active: rnd() > 0.3,
    score: +(rnd() * 100).toFixed(2),
    balance: +(rnd() * 10000 - 5000).toFixed(2),
    roles: ["user"].concat(rnd() > 0.7 ? ["admin"] : []).concat(rnd() > 0.9 ? ["owner"] : []),
    tags,
    addresses: Array.from({ length: 1 + Math.floor(rnd() * 2) }, makeAddress),
    preferences: {
      theme: pick(["dark", "light", "high-contrast"]),
      notifications: { email: rnd() > 0.5, sms: rnd() > 0.5, push: { enabled: rnd() > 0.5, quietHours: [22, 7] } },
      experimental: rnd() > 0.6 ? { flags: { betaUi: true, fastJson: rnd() > 0.5 } } : {},
    },
    lastSeen: rnd() > 0.2 ? new Date(1577836800000 + Math.floor(rnd() * 1e11)).toISOString() : null,
    history: Array.from({ length: Math.floor(rnd() * 3) }, (_, j) => ({
      event: pick(["login", "purchase", "logout", "error"]),
      ts: 1577836800 + j * 3600,
      payload: rnd() > 0.5 ? { amount: +(rnd() * 500).toFixed(2), currency: pick(["USD", "EUR", "JPY"]) } : {},
    })),
  };
}

// A pathological deep chain to exercise nesting depth.
function deepChain(depth) {
  if (depth <= 0) return { leaf: true, value: "bottom 🪨", depth: 0 };
  return { level: depth, note: "nested level " + depth, child: deepChain(depth - 1) };
}

const doc = {
  $schema: "https://example.com/schemas/complex.v3.json",
  meta: {
    generatedAt: new Date(1717372800000).toISOString(),
    version: "3.14.159",
    pi: 3.141592653589793,
    bigNumber: 9007199254740991,
    negativeZero: -0,
    floats: { tiny: 1e-12, huge: 1.7976931348623157e308, exp: 6.022e23 },
    unicode: { emoji: "🚀🌍✨", cjk: "你好，世界", rtl: "مرحبا بالعالم", mixed: "café—naïve—Zoë" },
    booleans: [true, false, true],
    nullField: null,
    emptyObject: {},
    emptyArray: [],
    emptyString: "",
    escapes: 'quotes " backslash \\\\ tab\\ttab newline\\nline',
  },
  config: {
    server: {
      host: "0.0.0.0",
      port: 8443,
      tls: { enabled: true, ciphers: ["TLS_AES_256", "TLS_CHACHA20"], minVersion: "1.3" },
      cors: { origins: ["https://app.example.com", "*"], methods: ["GET", "POST", "PATCH"], credentials: true },
      limits: { maxBodyBytes: 1048576, rateLimit: { window: 60, max: 1000, burst: 50 } },
    },
    database: {
      primary: { driver: "postgres", dsn: "postgres://user:***@db:5432/app", pool: { min: 2, max: 20, idleMs: 30000 } },
      replicas: [
        { region: "eu-central", weight: 0.5, lagMs: 12 },
        { region: "us-east", weight: 0.3, lagMs: 84 },
        { region: "ap-northeast", weight: 0.2, lagMs: 153 },
      ],
      cache: { kind: "redis", nodes: ["redis-a:6379", "redis-b:6379"], ttl: { default: 300, sessions: 86400 } },
    },
    featureFlags: {
      newInspector: { enabled: true, rollout: 0.42, segments: ["internal", "beta"] },
      legacyExport: { enabled: false, sunsetDate: "2026-12-31", replacedBy: null },
    },
  },
  users: Array.from({ length: 12 }, (_, i) => makeUser(i + 1)),
  matrix: Array.from({ length: 4 }, (_, r) =>
    Array.from({ length: 4 }, (_, c) => (r === c ? 1 : 0))
  ),
  mixedArray: [
    1,
    "two",
    false,
    null,
    { kind: "object-in-array", nested: [{ a: [1, [2, [3, [4]]]] }] },
    [9, 8, 7],
    3.14,
  ],
  deeplyNested: deepChain(15),
  analytics: {
    daily: Array.from({ length: 7 }, (_, d) => ({
      date: "2026-06-0" + (d + 1),
      visits: Math.floor(rnd() * 10000),
      conversion: +(rnd()).toFixed(4),
      byCountry: { US: Math.floor(rnd() * 5000), DE: Math.floor(rnd() * 3000), JP: Math.floor(rnd() * 2000) },
    })),
    funnels: {
      signup: { steps: ["land", "form", "verify", "done"], dropOff: [0.0, 0.31, 0.55, 0.7] },
    },
  },
};

const out = path.join(__dirname, "sample-complex.json");
fs.writeFileSync(out, JSON.stringify(doc, null, 2) + "\n");
const bytes = fs.statSync(out).size;
console.log("Wrote " + out + " (" + bytes + " bytes, " + JSON.stringify(doc).length + " chars minified)");
