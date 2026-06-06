const fs = require("fs");
const Module = require("module");
const path = require("path");

const file = process.argv[2];
const previewEntries = Number(process.argv[3] || 1000);
const rangeStart = Number(process.argv[4] || previewEntries);
const searchQuery = process.argv[5] || "";

if (!file) {
  console.error(
    "Usage: node scripts/measure-large-file-memory.js <file> [previewEntries] [rangeStart] [searchQuery]"
  );
  process.exit(2);
}

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "vscode") {
    return {
      commands: { registerCommand() { return { dispose() {} }; } },
      env: { clipboard: { writeText() {} } },
      Range: function () {},
      Selection: function () {},
      TextEditorRevealType: { InCenter: 1 },
      Uri: { file: (fsPath) => ({ scheme: "file", fsPath }) },
      ViewColumn: { Beside: 2, One: 1 },
      window: {
        createWebviewPanel() {},
        setStatusBarMessage() {},
        showErrorMessage() {},
        showInformationMessage() {},
        showTextDocument() {},
        showWarningMessage() {},
        visibleTextEditors: [],
      },
      workspace: {
        getConfiguration() { return { get(_key, fallback) { return fallback; } }; },
        fs: { async stat(uri) { return fs.statSync(uri.fsPath); } },
        onDidChangeTextDocument() { return { dispose() {} }; },
        openTextDocument() {},
      },
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const { _test } = require("../extension");

function mb(n) {
  return (n / 1024 / 1024).toFixed(1);
}

function snapshot() {
  const m = process.memoryUsage();
  return {
    rss: m.rss,
    heapUsed: m.heapUsed,
    heapTotal: m.heapTotal,
    external: m.external,
  };
}

function printMemory(label, m) {
  console.log(
    `${label}: rss=${mb(m.rss)}MB heapUsed=${mb(m.heapUsed)}MB ` +
      `heapTotal=${mb(m.heapTotal)}MB external=${mb(m.external)}MB`
  );
}

(async () => {
  const fileName = path.resolve(file);
  const stat = fs.statSync(fileName);
  let peak = snapshot();
  const timer = setInterval(() => {
    const current = snapshot();
    if (current.rss > peak.rss) peak = current;
  }, 100);

  const start = Date.now();
  printMemory("before", snapshot());
  const options = {
    previewEntries,
    maxCopyBytes: 32 * 1024 * 1024,
    sourcePreviewBytes: 64 * 1024,
  };
  const preview = await _test.buildLargeFilePreview(
    fileName,
    options,
    (progress) => {
      console.log(
        `progress: read=${mb(progress.bytesRead)}MB entries=${progress.entries}`
      );
    }
  );
  if (preview.totalEntries > preview.shownEntries) {
    const start = Math.max(
      0,
      Math.min(Math.floor(rangeStart), preview.totalEntries - 1)
    );
    const range = await _test.buildLargeFilePage(
      fileName,
      preview,
      start,
      options
    );
    preview.shownEntries = range.children.length;
    console.log(
      `loaded range: start=${start} entries=${range.children.length}`
    );
  }
  let search = null;
  if (searchQuery) {
    search = await _test.searchLargeFile(
      fileName,
      preview,
      searchQuery,
      options
    );
    console.log(
      `search: query=${JSON.stringify(searchQuery)} matches=${search.totalMatches} shown=${search.children.length}`
    );
  }
  clearInterval(timer);
  const end = Date.now();

  printMemory("after", snapshot());
  printMemory("peak", peak);
  console.log(
    JSON.stringify(
      {
        file: fileName,
        fileSizeBytes: stat.size,
        elapsedMs: end - start,
        rootType: preview.rootType,
        mode: preview.mode,
        totalEntries: preview.totalEntries,
        shownEntries: preview.shownEntries,
        indexedEntries: preview.indexedEntries,
        truncated: preview.truncated,
        search: search
          ? {
              query: searchQuery,
              totalMatches: search.totalMatches,
              shownMatches: search.children.length,
            }
          : undefined,
      },
      null,
      2
    )
  );
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
