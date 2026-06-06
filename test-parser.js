const assert = require("assert");
const fs = require("fs");
const Module = require("module");
const os = require("os");
const path = require("path");

let configValues = {};

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
        getConfiguration() {
          return {
            get(key, fallback) {
              return Object.prototype.hasOwnProperty.call(configValues, key)
                ? configValues[key]
                : fallback;
            },
          };
        },
        fs: {
          async stat(uri) {
            return fs.statSync(uri.fsPath);
          },
        },
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

function writeTemp(name, text) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "json-viewer-test-"));
  const file = path.join(dir, name);
  fs.writeFileSync(file, text);
  return file;
}

function byteSlice(text, entry) {
  return Buffer.from(text).subarray(entry.val, entry.end).toString("utf8");
}

(async () => {
  {
    const props = require("./package.json").contributes.configuration.properties;
    for (const key of [
      "jsonViewer.expandLevel",
      "jsonViewer.expandLevelJsonl",
      "jsonViewer.liveUpdate",
      "jsonViewer.largeFileThresholdMb",
      "jsonViewer.largeFilePreviewEntries",
      "jsonViewer.largeFileMaxCopyMb",
      "jsonViewer.largeFileSourcePreviewKb",
    ]) {
      assert(props[key], `missing configuration ${key}`);
    }

    configValues = {
      expandLevel: 2,
      expandLevelJsonl: 3,
      liveUpdate: false,
      largeFilePreviewEntries: 17,
      largeFileMaxCopyMb: 2,
      largeFileSourcePreviewKb: 8,
    };
    assert.deepEqual(_test.getViewerOptions({ fileName: "sample.json" }), {
      expandLevel: 2,
      liveUpdate: false,
    });
    assert.deepEqual(_test.getViewerOptions({ fileName: "sample.jsonl" }), {
      expandLevel: 3,
      liveUpdate: false,
    });
    const largeOptions = _test.getLargeFileOptions();
    assert.equal(largeOptions.previewEntries, 17);
    assert.equal(largeOptions.maxCopyBytes, 2 * 1024 * 1024);
    assert.equal(largeOptions.sourcePreviewBytes, 8 * 1024);
    configValues = {};
  }

  {
    const jsonFile = writeTemp("large-mode-config.json", "{}");
    fs.truncateSync(jsonFile, 2 * 1024 * 1024);
    const uri = { scheme: "file", fsPath: jsonFile };

    configValues = { largeFileThresholdMb: 1 };
    assert.equal(await _test.shouldUseLargeFileMode(uri), true);

    configValues = { largeFileThresholdMb: 3 };
    assert.equal(await _test.shouldUseLargeFileMode(uri), false);

    configValues = { largeFileThresholdMb: 0 };
    assert.equal(await _test.shouldUseLargeFileMode(uri), true);

    configValues = { largeFileThresholdMb: -1 };
    assert.equal(await _test.shouldUseLargeFileMode(uri), false);

    const jsoncFile = writeTemp("large-mode-config.jsonc", "{}");
    fs.truncateSync(jsoncFile, 2 * 1024 * 1024);
    configValues = { largeFileThresholdMb: 0 };
    assert.equal(
      await _test.shouldUseLargeFileMode({ scheme: "file", fsPath: jsoncFile }),
      false
    );

    configValues = {};
  }

  {
    for (const [name, text] of [
      ["large-invalid-trailing-comma-array.json", "[1,]"],
      ["large-invalid-trailing-comma-object.json", '{"a":1,}'],
      ["large-invalid-root-garbage.json", "[1] garbage"],
      ["large-invalid-unclosed-array.json", "[1"],
      ["large-invalid-missing-comma.json", "[1 2]"],
    ]) {
      const file = writeTemp(name, text);
      await assert.rejects(
        () =>
          _test.buildLargeFilePreview(file, {
            previewEntries: 10,
            maxCopyBytes: 1024 * 1024,
          }),
        /JSON|comma|Unexpected|Invalid/
      );
    }

    const emptyArray = await _test.buildLargeFilePreview(
      writeTemp("large-empty-array.json", "[]"),
      { previewEntries: 10, maxCopyBytes: 1024 * 1024 }
    );
    assert.equal(emptyArray.totalEntries, 0);
    assert.equal(emptyArray.tree.c.length, 0);
  }

  {
    const text = '[{"title":"café","value":100.00},{"ok":true}]';
    const file = writeTemp("large-array.json", text);
    const options = {
      previewEntries: 1,
      maxCopyBytes: 1024 * 1024,
    };
    const preview = await _test.buildLargeFilePreview(file, options);
    assert.equal(preview.rootType, "array");
    assert.equal(preview.totalEntries, 2);
    assert.equal(preview.shownEntries, 1);
    assert.equal(preview.pageCursors.length, 2);
    assert.equal(byteSlice(text, preview.offsets.get("$[0].value")), "100.00");
    assert.equal(byteSlice(text, preview.offsets.get("$[0].title")), '"café"');
    const page = await _test.buildLargeFilePage(file, preview, 1, options);
    assert.equal(page.children.length, 1);
    assert.equal(byteSlice(text, page.offsets.get("$[1].ok")), "true");
    const search = await _test.searchLargeFile(file, preview, "café", options);
    assert.equal(search.totalMatches, 1);
    assert.equal(byteSlice(text, search.offsets.get("$[0].title")), '"café"');
    const source = await _test.readSourcePreview(
      file,
      preview.offsets.get("$[0].title").val,
      preview.offsets.get("$[0].title").end,
      32
    );
    assert.equal(
      source.text.slice(source.highlightStart, source.highlightEnd),
      '"café"'
    );
  }

  {
    const text = "[0,1,2,3,4]";
    const file = writeTemp("large-array-random-page.json", text);
    const options = {
      previewEntries: 2,
      maxCopyBytes: 1024 * 1024,
    };
    const preview = await _test.buildLargeFilePreview(file, options);
    const page = await _test.buildLargeFilePage(file, preview, 3, options);
    assert.equal(page.children.length, 2);
    assert.equal(page.children[0].k, "3");
    assert.equal(byteSlice(text, page.offsets.get("$[3]")), "3");
    assert.equal(byteSlice(text, page.offsets.get("$[4]")), "4");
    await assert.rejects(
      () => _test.buildLargeFilePage(file, preview, 3, options, { cancelled: true }),
      /cancelled/
    );
  }

  {
    const text = '{"huge":"' + "x".repeat(100000) + "needle" + "x".repeat(100000) + '","tail":1}';
    const file = writeTemp("large-source-preview.json", text);
    const parsed = parse("large-source-preview.json", text);
    const entry = parsed.offsets.get("$.huge");
    const source = await _test.readSourcePreview(file, entry.val, entry.end, 4096);
    assert(source.text.length < 5000);
    assert.equal(source.targetTruncated, true);
    assert(source.highlightEnd <= source.text.length);
    const preview = await _test.buildLargeFilePreview(file, {
      previewEntries: 10,
      maxCopyBytes: 32,
    });
    const search = await _test.searchLargeFile(file, preview, "needle", {
      previewEntries: 10,
      maxCopyBytes: 32,
    });
    assert.equal(search.totalMatches, 1);
  }

  {
    const text = '{"café":{"neg":-0},"arr":[1,2,3]}';
    const file = writeTemp("large-object.json", text);
    const options = {
      previewEntries: 1,
      maxCopyBytes: 1024 * 1024,
    };
    const preview = await _test.buildLargeFilePreview(file, options);
    const cafePath = "$." + JSON.stringify("café");
    assert.equal(preview.rootType, "object");
    assert.equal(preview.totalEntries, 2);
    assert.equal(preview.tree.c[0].k, "café");
    assert.equal(byteSlice(text, preview.offsets.get(cafePath + ".neg")), "-0");
    const page = await _test.buildLargeFilePage(file, preview, 1, options);
    assert.equal(page.children.length, 1);
    assert.equal(page.children[0].k, "arr");
    assert.equal(byteSlice(text, page.offsets.get("$.arr[2]")), "3");
    const search = await _test.searchLargeFile(file, preview, "arr", options);
    assert.equal(search.totalMatches, 1);
    assert.equal(search.children[0].k, "arr");
    assert.equal(byteSlice(text, search.offsets.get("$.arr[1]")), "2");
  }

  {
    const text = [
      '{"id":1,"value":100.00}',
      '{ broken }',
      '{"id":2,"word":"café"}',
      "",
    ].join("\n");
    const file = writeTemp("large-records.jsonl", text);
    const options = {
      previewEntries: 1,
      maxCopyBytes: 1024 * 1024,
    };
    const preview = await _test.buildLargeFilePreview(file, options);
    assert.equal(preview.jsonl, true);
    assert.equal(preview.totalEntries, 2);
    assert.equal(preview.errors.length, 1);
    assert.equal(byteSlice(text, preview.offsets.get("$[0].value")), "100.00");
    const page = await _test.buildLargeFilePage(file, preview, 1, options);
    assert.equal(page.children.length, 1);
    assert.equal(byteSlice(text, page.offsets.get("$[1].word")), '"café"');
    const search = await _test.searchLargeFile(file, preview, "café", options);
    assert.equal(search.totalMatches, 1);
    assert.equal(byteSlice(text, search.offsets.get("$[1].word")), '"café"');
  }

  {
    const file = writeTemp("large-jsonl-oversize-line.jsonl", '{"big":"' + "x".repeat(2048) + '"}\n');
    await assert.rejects(
      () =>
        _test.buildLargeFilePreview(file, {
          previewEntries: 10,
          maxCopyBytes: 32,
        }),
      /JSONL record exceeds/
    );
  }

  console.log("parser tests ok");
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
