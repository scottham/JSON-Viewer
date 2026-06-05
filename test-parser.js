const assert = require("assert");
const fs = require("fs");
const Module = require("module");

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "vscode") {
    return {
      commands: { registerCommand() { return { dispose() {} }; } },
      env: { clipboard: { writeText() {} } },
      Range: function () {},
      Selection: function () {},
      TextEditorRevealType: { InCenter: 1 },
      ViewColumn: { Beside: 2, One: 1 },
      window: {
        createWebviewPanel() {},
        setStatusBarMessage() {},
        showErrorMessage() {},
        showTextDocument() {},
        visibleTextEditors: [],
      },
      workspace: {
        getConfiguration() { return { get(_key, fallback) { return fallback; } }; },
        onDidChangeTextDocument() { return { dispose() {} }; },
        openTextDocument() {},
      },
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const { _test } = require("./extension");

function parse(fileName, text) {
  return _test.parseDocumentText(fileName, text);
}

function slice(parsed, text, nodePath) {
  const entry = parsed.offsets.get(nodePath);
  assert(entry, `missing offset for ${nodePath}`);
  return text.slice(entry.val, entry.end);
}

{
  const text = [
    "{",
    "  // leading",
    '  "a": 1,',
    '  "b": [true, false,],',
    '  "c": { "d": "x", }, /* block */',
    "}",
    "",
  ].join("\n");
  const parsed = parse("sample.jsonc", text);
  assert.equal(parsed.ok, true, parsed.error);
  assert.equal(slice(parsed, text, "$.b"), "[true, false,]");
  assert.equal(slice(parsed, text, "$.c"), '{ "d": "x", }');
}

{
  const parsed = parse("bad.jsonc", "[,]");
  assert.equal(parsed.ok, false);
}

{
  const parsed = parse("strict.json", '{// comment\n"a":1}');
  assert.equal(parsed.ok, false);
}

{
  const text = [
    '{"id":1,"value":100.00}',
    '{"id":2,"value":6.022e23}',
    '{ broken }',
    "",
  ].join("\n");
  const parsed = parse("records.jsonl", text);
  assert.equal(parsed.ok, true, parsed.error);
  assert.equal(parsed.jsonl, true);
  assert.equal(parsed.errors.length, 1);
  assert.equal(slice(parsed, text, "$[0].value"), "100.00");
  assert.equal(slice(parsed, text, "$[1].value"), "6.022e23");
}

{
  const text = '{"big":900719925474099112345,"neg":-0}';
  const parsed = parse("sample.json", text);
  assert.equal(parsed.ok, true, parsed.error);
  assert.equal(slice(parsed, text, "$.big"), "900719925474099112345");
  assert.equal(slice(parsed, text, "$.neg"), "-0");
}

for (const fileName of ["sample-complex.json", "sample-records.jsonl"]) {
  const text = fs.readFileSync(fileName, "utf8");
  const parsed = parse(fileName, text);
  assert.equal(parsed.ok, true, parsed.error);
}

console.log("parser tests ok");
