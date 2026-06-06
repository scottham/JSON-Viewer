const vscode = require("vscode");
const fs = require("fs");
const path = require("path");

const LARGE_FILE_DEFAULT_THRESHOLD_MB = 45;
const LARGE_FILE_DEFAULT_PREVIEW_ENTRIES = 1000;
const LARGE_FILE_DEFAULT_MAX_COPY_MB = 32;
const LARGE_FILE_DEFAULT_SOURCE_PREVIEW_KB = 64;

/**
 * Map of document URI string -> active webview panel, so re-running the
 * command on the same file focuses the existing panel instead of opening
 * a duplicate.
 * @type {Map<string, vscode.WebviewPanel>}
 */
const panels = new Map();

function activate(context) {
  const openCommand = vscode.commands.registerCommand(
    "jsonViewer.open",
    async (uri) => {
      // The command can be triggered from the editor title (no arg, use the
      // active editor) or the explorer context menu (passes the resource uri).
      let document;
      if (uri && uri instanceof vscode.Uri) {
        if (await shouldUseLargeFileMode(uri)) {
          openLargeFileViewer(context, uri);
          return;
        }
        document = await vscode.workspace.openTextDocument(uri);
      } else if (vscode.window.activeTextEditor) {
        const activeUri = vscode.window.activeTextEditor.document.uri;
        if (await shouldUseLargeFileMode(activeUri)) {
          openLargeFileViewer(context, activeUri);
          return;
        }
        document = vscode.window.activeTextEditor.document;
      }

      if (!document) {
        vscode.window.showErrorMessage(
          "JSON Viewer: Tree Inspector: open a JSON file first, then run the command."
        );
        return;
      }

      openViewer(context, document);
    }
  );

  context.subscriptions.push(openCommand);
}

async function shouldUseLargeFileMode(uri) {
  if (!uri || uri.scheme !== "file") return false;
  const fileName = uri.fsPath || uri.path || "";
  if (!isLargeFileModeSupportedFile(fileName)) return false;

  const config = vscode.workspace.getConfiguration("jsonViewer");
  const thresholdMb = Number(
    config.get("largeFileThresholdMb", LARGE_FILE_DEFAULT_THRESHOLD_MB)
  );
  if (!Number.isFinite(thresholdMb) || thresholdMb < 0) return false;

  try {
    const stat = await vscode.workspace.fs.stat(uri);
    return stat.size >= thresholdMb * 1024 * 1024;
  } catch (_e) {
    return false;
  }
}

function isLargeFileModeSupportedFile(fileName) {
  const ext = path.extname(fileName).toLowerCase();
  return ext === ".json" || ext === ".jsonl" || ext === ".ndjson";
}

// JSONL / NDJSON are detected by file extension. Each non-blank line is an
// independent JSON value; we parse them into an array so the inspector shows a
// "list of dicts" in an inspector-style view. A single malformed line is
// reported but does not blank out the rest.
function isLineDelimited(document) {
  return isLineDelimitedFile(document.fileName);
}

function isLineDelimitedFile(fileName) {
  const ext = path.extname(fileName).toLowerCase();
  return ext === ".jsonl" || ext === ".ndjson";
}

function isJsoncFile(fileName) {
  return path.extname(fileName).toLowerCase() === ".jsonc";
}

function parseDocumentText(fileName, text) {
  const offsets = new Map();

  if (isLineDelimitedFile(fileName)) {
    const errors = [];
    const children = [];
    let rec = 0;
    let lineNo = 1;
    let start = 0;

    while (start < text.length) {
      const nl = text.indexOf("\n", start);
      const end = nl === -1 ? text.length : nl + 1;
      const line = text.slice(start, end);
      if (line.trim() !== "") {
        try {
          JSON.parse(line); // validity gate; tree/values come from parseToTree
          const node = parseToTree(line);
          children.push(projectNode(node, "$[" + rec + "]", start, offsets));
          rec++;
        } catch (e) {
          errors.push({ line: lineNo, message: e.message });
        }
      }

      if (nl === -1) break;
      start = end;
      lineNo++;
    }
    if (children.length === 0) {
      return {
        ok: false,
        error:
          "No valid JSONL records.\n" +
          errors.map((e) => `line ${e.line}: ${e.message}`).join("\n"),
      };
    }
    offsets.set("$", { key: 0, val: 0, end: text.length });
    return {
      ok: true,
      tree: { t: "array", c: children },
      jsonl: true,
      errors,
      offsets,
    };
  }

  const jsonc = isJsoncFile(fileName);
  try {
    JSON.parse(jsonc ? jsoncToJson(text) : text); // validity gate
  } catch (e) {
    return { ok: false, error: e.message };
  }
  const root = parseToTree(text, { jsonc });
  return {
    ok: true,
    tree: projectNode(root, "$", 0, offsets),
    jsonl: false,
    offsets,
  };
}

function openViewer(context, document) {
  const key = document.uri.toString();
  const existing = panels.get(key);
  if (existing) {
    existing.reveal(vscode.ViewColumn.Beside);
    return;
  }

  const panel = vscode.window.createWebviewPanel(
    "jsonViewer",
    `JSON Viewer: Tree Inspector: ${path.basename(document.fileName)}`,
    vscode.ViewColumn.Beside,
    { enableScripts: true, retainContextWhenHidden: true }
  );

  panels.set(key, panel);

  const config = vscode.workspace.getConfiguration("jsonViewer");
  // Default expand level differs by file type: JSON opens with top-level
  // entries collapsed (level 0); JSONL opens with the record list shown but each
  // record collapsed (level 0). Root is level 0.
  const expandLevel = isLineDelimited(document)
    ? config.get("expandLevelJsonl", 0)
    : config.get("expandLevel", 0);
  const liveUpdate = config.get("liveUpdate", true);

  panel.webview.html = getHtml(panel.webview, expandLevel);

  // path string -> { key, val, end } source offsets, refreshed on every post so
  // double-click / "jump" can map an inspector row back to the source text.
  let offsetMap = new Map();
  let parsedText = "";
  let parseTimer;

  const post = () => {
    if (parseTimer) {
      clearTimeout(parseTimer);
      parseTimer = undefined;
    }
    const text = document.getText();
    const parsed = parseDocumentText(document.fileName, text);
    parsedText = parsed.ok ? text : "";
    offsetMap = parsed.ok ? parsed.offsets : new Map();
    panel.webview.postMessage({
      type: "load",
      name: path.basename(document.fileName),
      ok: parsed.ok,
      tree: parsed.tree,
      jsonl: parsed.jsonl,
      errors: parsed.errors,
      error: parsed.error,
    });
  };

  const schedulePost = () => {
    if (parseTimer) clearTimeout(parseTimer);
    parseTimer = setTimeout(() => {
      parseTimer = undefined;
      post();
    }, 120);
  };

  // Push the first payload once the webview signals it is ready.
  panel.webview.onDidReceiveMessage(
    (msg) => {
      if (msg.type === "ready") {
        post();
      } else if (msg.type === "copy") {
        vscode.env.clipboard.writeText(msg.value);
        vscode.window.setStatusBarMessage(
          `JSON Viewer: Tree Inspector: copied ${msg.label}`,
          2000
        );
      } else if (msg.type === "copyRaw" && typeof msg.path === "string") {
        // Copy value: slice the exact source substring from the latest parse.
        if (document.getText() !== parsedText) post();
        const entry = offsetMap.get(msg.path);
        if (entry) {
          vscode.env.clipboard.writeText(parsedText.slice(entry.val, entry.end));
          vscode.window.setStatusBarMessage(
            "JSON Viewer: Tree Inspector: copied value",
            2000
          );
        }
      } else if (msg.type === "reveal" && typeof msg.path === "string") {
        if (document.getText() !== parsedText) post();
        const entry = offsetMap.get(msg.path);
        if (entry) {
          if (msg.which === "key") {
            revealOffset(document, entry.key, entry.key);
          } else {
            revealOffset(document, entry.val, entry.end);
          }
        }
      }
    },
    undefined,
    context.subscriptions
  );

  let changeSub;
  if (liveUpdate) {
    changeSub = vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.uri.toString() === key) {
        schedulePost();
      }
    });
    context.subscriptions.push(changeSub);
  }

  panel.onDidDispose(
    () => {
      panels.delete(key);
      if (parseTimer) clearTimeout(parseTimer);
      if (changeSub) changeSub.dispose();
    },
    null,
    context.subscriptions
  );
}

function getLargeFileOptions() {
  const config = vscode.workspace.getConfiguration("jsonViewer");
  const previewEntries = Math.max(
    1,
    Math.floor(
      Number(
        config.get(
          "largeFilePreviewEntries",
          LARGE_FILE_DEFAULT_PREVIEW_ENTRIES
        )
      ) || LARGE_FILE_DEFAULT_PREVIEW_ENTRIES
    )
  );
  const maxCopyBytes = Math.max(
    1024,
    Math.floor(
      (Number(
        config.get("largeFileMaxCopyMb", LARGE_FILE_DEFAULT_MAX_COPY_MB)
      ) || LARGE_FILE_DEFAULT_MAX_COPY_MB) *
        1024 *
        1024
    )
  );
  const sourcePreviewBytes = Math.max(
    4096,
    Math.floor(
      (Number(
        config.get(
          "largeFileSourcePreviewKb",
          LARGE_FILE_DEFAULT_SOURCE_PREVIEW_KB
        )
      ) || LARGE_FILE_DEFAULT_SOURCE_PREVIEW_KB) * 1024
    )
  );
  return { previewEntries, maxCopyBytes, sourcePreviewBytes };
}

function clampLargeStartIndex(value, totalEntries) {
  const total = Math.max(0, Math.floor(Number(totalEntries) || 0));
  if (total === 0) return 0;
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(n, total - 1));
}

function clampLargePageSize(value, configuredPageSize) {
  const max = Math.max(1, Math.floor(Number(configuredPageSize) || 1));
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n) || n < 1) return max;
  return Math.max(1, Math.min(n, max));
}

function rootOffsetMap(indexState) {
  const offsets = new Map();
  const root = indexState && indexState.offsets && indexState.offsets.get("$");
  if (root) offsets.set("$", root);
  return offsets;
}

function largeFileMeta(indexState, pageStart, shownEntries, pageSize) {
  const total = Math.max(0, Number(indexState.totalEntries) || 0);
  const start = total ? clampLargeStartIndex(pageStart, total) : 0;
  const shown = Math.max(0, Math.floor(Number(shownEntries) || 0));
  const maxPageSize = Math.max(1, Math.floor(Number(indexState.pageSize) || shown || 1));
  const pageCount = clampLargePageSize(pageSize || shown || maxPageSize, maxPageSize);
  const end = Math.min(total, start + shown);
  return {
    fileSize: indexState.fileSize,
    rootType: indexState.rootType,
    totalEntries: total,
    shownEntries: shown,
    indexedEntries: indexState.indexedEntries,
    truncated: end < total,
    mode: indexState.mode,
    pageStart: start,
    pageEnd: end,
    pageSize: maxPageSize,
    pageCount,
    canPrevious: start > 0,
    canNext: end < total,
    canLoadMore: end < total,
  };
}

function openLargeFileViewer(context, uri) {
  const key = "large:" + uri.toString();
  const existing = panels.get(key);
  if (existing) {
    existing.reveal(vscode.ViewColumn.Beside);
    return;
  }

  const options = getLargeFileOptions();
  const panel = vscode.window.createWebviewPanel(
    "jsonViewer",
    `JSON Viewer: Tree Inspector: ${path.basename(uri.fsPath)}`,
    vscode.ViewColumn.Beside,
    { enableScripts: true, retainContextWhenHidden: true }
  );

  panels.set(key, panel);
  panel.webview.html = getHtml(panel.webview, 0);

  let disposed = false;
  const cancelToken = { cancelled: false };
  let searchToken = null;
  let indexState = null;
  let offsetMap = new Map();
  let loadingRange = false;

  const postStatus = (text) => {
    panel.webview.postMessage({
      type: "largeStatus",
      name: path.basename(uri.fsPath),
      text,
    });
  };

  const load = async () => {
    try {
      postStatus("Large file mode: indexing top-level entries...");
      indexState = await buildLargeFilePreview(
        uri.fsPath,
        options,
        (progress) => {
          if (!disposed) {
            postStatus(
              `Large file mode: indexed ${progress.entries.toLocaleString()} entries · ` +
                `${formatBytes(progress.bytesRead)} read`
            );
          }
        },
        cancelToken
      );
      if (disposed) return;
      indexState.currentStart = 0;
      offsetMap = indexState.offsets;
      panel.webview.postMessage({
        type: "load",
        name: path.basename(uri.fsPath),
        ok: true,
        tree: indexState.tree,
        jsonl: indexState.jsonl,
        errors: indexState.errors,
        large: largeFileMeta(indexState, 0, indexState.shownEntries),
      });
    } catch (e) {
      if (disposed) return;
      panel.webview.postMessage({
        type: "load",
        name: path.basename(uri.fsPath),
        ok: false,
        error: e && e.message ? e.message : String(e),
      });
    }
  };

  panel.webview.onDidReceiveMessage(
    async (msg) => {
      if (msg.type === "ready") {
        load();
      } else if (msg.type === "copy") {
        vscode.env.clipboard.writeText(msg.value);
        vscode.window.setStatusBarMessage(
          `JSON Viewer: Tree Inspector: copied ${msg.label}`,
          2000
        );
      } else if (msg.type === "copyRaw" && typeof msg.path === "string") {
        const entry = offsetMap.get(msg.path);
        if (!entry) return;
        const size = entry.end - entry.val;
        if (size > options.maxCopyBytes) {
          vscode.window.showWarningMessage(
            `Value is ${formatBytes(size)}. Large-file mode copy limit is ${formatBytes(options.maxCopyBytes)}.`
          );
          return;
        }
        const value = await readUtf8Range(uri.fsPath, entry.val, entry.end);
        vscode.env.clipboard.writeText(value);
        vscode.window.setStatusBarMessage(
          "JSON Viewer: Tree Inspector: copied value",
          2000
        );
      } else if (msg.type === "reveal" && typeof msg.path === "string") {
        const entry = offsetMap.get(msg.path);
        if (!entry) return;
        const preview = await readSourcePreview(
          uri.fsPath,
          msg.which === "key" ? entry.key : entry.val,
          msg.which === "key" ? entry.key : entry.end,
          options.sourcePreviewBytes
        );
        panel.webview.postMessage({
          type: "sourcePreview",
          path: msg.path,
          which: msg.which || "value",
          ...preview,
        });
      } else if (msg.type === "largeLoadRange") {
        if (!indexState || loadingRange) return;
        const startIndex = clampLargeStartIndex(msg.start, indexState.totalEntries);
        const count = clampLargePageSize(msg.count, options.previewEntries);
        loadingRange = true;
        try {
          const pageOptions = { ...options, previewEntries: count };
          const page = await buildLargeFilePage(
            uri.fsPath,
            indexState,
            startIndex,
            pageOptions
          );
          offsetMap = rootOffsetMap(indexState);
          for (const [k, v] of page.offsets) offsetMap.set(k, v);
          indexState.currentStart = page.start;
          indexState.shownEntries = page.children.length;
          panel.webview.postMessage({
            type: "largeRange",
            children: page.children,
            start: page.start,
            large: largeFileMeta(indexState, page.start, page.children.length, count),
          });
        } catch (e) {
          panel.webview.postMessage({
            type: "largeRangeError",
            error: e && e.message ? e.message : String(e),
          });
          vscode.window.showErrorMessage(
            `Large-file mode: failed to load entry range: ${
              e && e.message ? e.message : String(e)
            }`
          );
        } finally {
          loadingRange = false;
        }
      } else if (msg.type === "largeSearch" && typeof msg.query === "string") {
        if (!indexState) return;
        if (searchToken) searchToken.cancelled = true;
        searchToken = { cancelled: false };
        const seq = msg.seq;
        const query = msg.query;
        if (!query.trim()) {
          panel.webview.postMessage({ type: "largeSearchCleared", seq });
          return;
        }
        try {
          const results = await searchLargeFile(
            uri.fsPath,
            indexState,
            query,
            options,
            searchToken
          );
          if (searchToken.cancelled) return;
          for (const [k, v] of results.offsets) offsetMap.set(k, v);
          panel.webview.postMessage({
            type: "largeSearchResults",
            seq,
            query,
            tree: {
              t: indexState.rootType,
              c: results.children,
            },
            largeSearch: {
              fileSize: indexState.fileSize,
              rootType: indexState.rootType,
              totalMatches: results.totalMatches,
              shownMatches: results.children.length,
              truncated: results.totalMatches > results.children.length,
            },
          });
        } catch (e) {
          if (searchToken.cancelled) return;
          panel.webview.postMessage({
            type: "largeSearchError",
            seq,
            error: e && e.message ? e.message : String(e),
          });
        }
      }
    },
    undefined,
    context.subscriptions
  );

  panel.onDidDispose(
    () => {
      disposed = true;
      cancelToken.cancelled = true;
      if (searchToken) searchToken.cancelled = true;
      panels.delete(key);
      indexState = null;
      offsetMap = new Map();
    },
    null,
    context.subscriptions
  );
}

// Select [start, end) in the source editor and scroll it into view. Reuses the
// document's existing editor column if it is already open somewhere.
async function revealOffset(document, start, end) {
  const open = vscode.window.visibleTextEditors.find(
    (e) => e.document.uri.toString() === document.uri.toString()
  );
  const editor = await vscode.window.showTextDocument(document, {
    viewColumn: open ? open.viewColumn : vscode.ViewColumn.One,
    preserveFocus: false,
  });
  const a = document.positionAt(start);
  const b = document.positionAt(typeof end === "number" ? end : start);
  editor.selection = new vscode.Selection(a, b);
  editor.revealRange(
    new vscode.Range(a, b),
    vscode.TextEditorRevealType.InCenter
  );
}

// JSON keys that are valid identifiers are shown unquoted in paths; others are
// JSON-quoted. Must stay identical to escapeKey() in the webview client.
function escapeKeyExt(k) {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(k) ? k : JSON.stringify(k);
}

// Convert JSONC to strict JSON for the JSON.parse validity gate. Comments are
// replaced with spaces/newlines so parse errors stay roughly aligned; trailing
// commas are skipped only when the next significant token closes the branch.
function jsoncToJson(text) {
  let i = 0;
  const n = text.length;
  let lastSig = "";
  let parts = null;
  let lastEmit = 0;

  const skipJsoncSpace = (j) => {
    while (j < n) {
      const c = text.charCodeAt(j);
      if (c === 32 || c === 9 || c === 10 || c === 13) { j++; continue; }
      if (text[j] === "/" && text[j + 1] === "/") {
        j += 2;
        while (j < n && text[j] !== "\n" && text[j] !== "\r") j++;
        continue;
      }
      if (text[j] === "/" && text[j + 1] === "*") {
        j += 2;
        while (j < n && !(text[j] === "*" && text[j + 1] === "/")) j++;
        if (j >= n) throw new Error("Unterminated block comment in JSONC");
        j += 2;
        continue;
      }
      break;
    }
    return j;
  };

  const replaceRange = (start, end) => {
    if (!parts) parts = [];
    parts.push(text.slice(lastEmit, start));
    parts.push(text.slice(start, end).replace(/[^\r\n]/g, " "));
    lastEmit = end;
  };

  while (i < n) {
    if (text[i] === '"') {
      i++;
      while (i < n) {
        if (text[i] === "\\") {
          i += 2;
        } else if (text[i] === '"') {
          i++;
          break;
        } else {
          i++;
        }
      }
      lastSig = '"';
      continue;
    }

    if (text[i] === "/" && text[i + 1] === "/") {
      const start = i;
      i += 2;
      while (i < n && text[i] !== "\n" && text[i] !== "\r") i++;
      replaceRange(start, i);
      continue;
    }

    if (text[i] === "/" && text[i + 1] === "*") {
      const start = i;
      i += 2;
      while (i < n && !(text[i] === "*" && text[i + 1] === "/")) i++;
      if (i >= n) throw new Error("Unterminated block comment in JSONC");
      i += 2;
      replaceRange(start, i);
      continue;
    }

    if (text[i] === ",") {
      const j = skipJsoncSpace(i + 1);
      if (
        (text[j] === "}" || text[j] === "]") &&
        lastSig &&
        !"{[,:".includes(lastSig)
      ) {
        replaceRange(i, i + 1);
        i++;
        continue;
      }
    }

    const ch = text[i++];
    if (!/\s/.test(ch)) lastSig = ch;
  }

  if (!parts) return text;
  parts.push(text.slice(lastEmit));
  return parts.join("");
}

// Parse `text` into a node tree that carries the EXACT source substring (`raw`)
// of every value. This is the single source of truth for what the viewer shows
// and copies — we never round-trip values through JSON.parse for display, since
// that is lossy for numbers (precision past 2^53, -0, trailing zeros, exponent
// form). Each node: { type, raw, value?, key?, keyStart, valStart, valEnd,
// children? } with offsets relative to `text`.
function parseToTree(text, options = {}) {
  let i = 0;
  const n = text.length;
  const jsonc = !!options.jsonc;

  const skipWs = () => {
    while (i < n) {
      const c = text.charCodeAt(i);
      if (c === 32 || c === 9 || c === 10 || c === 13) i++;
      else if (jsonc && text[i] === "/" && text[i + 1] === "/") {
        i += 2;
        while (i < n && text[i] !== "\n" && text[i] !== "\r") i++;
      } else if (jsonc && text[i] === "/" && text[i + 1] === "*") {
        i += 2;
        while (i < n && !(text[i] === "*" && text[i + 1] === "/")) i++;
        i = Math.min(n, i + 2);
      }
      else break;
    }
  };

  const parseString = () => {
    i++; // opening quote
    let s = "";
    while (i < n) {
      const ch = text[i];
      if (ch === '"') { i++; break; }
      if (ch === "\\") {
        const esc = text[i + 1];
        i += 2;
        if (esc === "n") s += "\n";
        else if (esc === "t") s += "\t";
        else if (esc === "r") s += "\r";
        else if (esc === "b") s += "\b";
        else if (esc === "f") s += "\f";
        else if (esc === "u") { s += String.fromCharCode(parseInt(text.substr(i, 4), 16)); i += 4; }
        else s += esc;
      } else { s += ch; i++; }
    }
    return s;
  };

  const parseValue = () => {
    skipWs();
    const valStart = i;
    const c = text[i];
    const node = {};
    if (c === "{") {
      node.type = "object";
      node.children = [];
      i++; skipWs();
      if (text[i] === "}") { i++; }
      else {
        while (i < n) {
          skipWs();
          if (jsonc && text[i] === "}") { i++; break; }
          const keyStart = i;
          const k = parseString();
          skipWs();
          if (text[i] === ":") i++;
          skipWs();
          const child = parseValue();
          child.key = k;
          child.keyStart = keyStart;
          node.children.push(child);
          skipWs();
          if (text[i] === ",") { i++; continue; }
          if (text[i] === "}") { i++; break; }
          break;
        }
      }
    } else if (c === "[") {
      node.type = "array";
      node.children = [];
      i++; skipWs();
      if (text[i] === "]") { i++; }
      else {
        while (i < n) {
          skipWs();
          if (jsonc && text[i] === "]") { i++; break; }
          const child = parseValue();
          child.keyStart = child.valStart;
          node.children.push(child);
          skipWs();
          if (text[i] === ",") { i++; continue; }
          if (text[i] === "]") { i++; break; }
          break;
        }
      }
    } else if (c === '"') {
      node.type = "string";
      node.value = parseString();
    } else if (c === "t") { node.type = "boolean"; node.value = true; i += 4; }
    else if (c === "f") { node.type = "boolean"; node.value = false; i += 5; }
    else if (c === "n") { node.type = "null"; node.value = null; i += 4; }
    else {
      node.type = "number";
      let j = i;
      while (j < n && "-+0123456789.eE".indexOf(text[j]) >= 0) j++;
      node.value = Number(text.slice(i, j));
      i = j;
    }
    node.valStart = valStart;
    node.valEnd = i;
    if (!node.children) node.raw = text.slice(valStart, i);
    return node;
  };

  skipWs();
  const root = parseValue();
  root.keyStart = root.valStart;
  return root;
}

// Reduce a parsed node to the minimal shape sent to the webview while filling
// path -> {key,val,end} offsets in the same walk. Branches carry no raw —
// copying a whole object/array is sliced from source on demand by offset.
function projectNode(node, nodePath, base, map) {
  map.set(nodePath, {
    key: base + node.keyStart,
    val: base + node.valStart,
    end: base + node.valEnd,
  });

  const out = { t: node.type };
  if (node.key !== undefined) out.k = node.key;
  if (node.type === "object") {
    out.c = node.children.map((ch) =>
      projectNode(ch, nodePath + "." + escapeKeyExt(ch.key), base, map)
    );
  } else if (node.type === "array") {
    out.c = node.children.map((ch, idx) =>
      projectNode(ch, nodePath + "[" + idx + "]", base, map)
    );
  } else {
    out.r = node.raw;
    out.v = node.value;
  }
  return out;
}

function projectNodeByteOffsets(node, nodePath, baseByte, text, map) {
  const byteCache = new Map([
    [0, 0],
    [text.length, Buffer.byteLength(text, "utf8")],
  ]);
  const byteAt = (charOffset) => {
    if (!byteCache.has(charOffset)) {
      byteCache.set(
        charOffset,
        Buffer.byteLength(text.slice(0, charOffset), "utf8")
      );
    }
    return byteCache.get(charOffset);
  };

  const walk = (n, p) => {
    map.set(p, {
      key: baseByte + byteAt(n.keyStart),
      val: baseByte + byteAt(n.valStart),
      end: baseByte + byteAt(n.valEnd),
    });

    const out = { t: n.type };
    if (n.key !== undefined) out.k = n.key;
    if (n.type === "object") {
      out.c = n.children.map((ch) =>
        walk(ch, p + "." + escapeKeyExt(ch.key))
      );
    } else if (n.type === "array") {
      out.c = n.children.map((ch, idx) => walk(ch, p + "[" + idx + "]"));
    } else {
      out.r = n.raw;
      out.v = n.value;
    }
    return out;
  };

  return walk(node, nodePath);
}

function isWsByte(b) {
  return b === 32 || b === 9 || b === 10 || b === 13;
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return String(bytes);
  const units = ["B", "KB", "MB", "GB", "TB"];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

async function readUtf8Range(fileName, start, end) {
  const handle = await fs.promises.open(fileName, "r");
  try {
    return await readUtf8RangeFromHandle(handle, start, end);
  } finally {
    await handle.close();
  }
}

async function readUtf8RangeFromHandle(handle, start, end) {
  const length = Math.max(0, end - start);
  const buffer = Buffer.allocUnsafe(length);
  const { bytesRead } = await handle.read(buffer, 0, length, start);
  return buffer.subarray(0, bytesRead).toString("utf8");
}

async function readSourcePreview(fileName, targetStart, targetEnd, windowBytes) {
  const stat = await fs.promises.stat(fileName);
  const targetSize = Math.max(0, targetEnd - targetStart);
  let start;
  let end;
  if (targetSize >= windowBytes) {
    start = Math.max(0, targetStart - Math.floor(windowBytes / 4));
    end = Math.min(stat.size, start + windowBytes);
  } else {
    const padding = Math.max(0, Math.floor((windowBytes - targetSize) / 2));
    start = Math.max(0, targetStart - padding);
    end = Math.min(stat.size, Math.max(targetEnd + padding, start + 1));
    if (end - start > windowBytes) end = start + windowBytes;
  }
  const length = Math.max(0, end - start);
  const handle = await fs.promises.open(fileName, "r");
  let buffer;
  try {
    buffer = Buffer.allocUnsafe(length);
    const { bytesRead } = await handle.read(buffer, 0, length, start);
    buffer = buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }

  const highlightByteStart = Math.max(0, targetStart - start);
  const highlightByteEnd = Math.max(
    highlightByteStart,
    Math.min(buffer.length, targetEnd - start)
  );
  const raw = buffer.toString("utf8");
  const highlightStart = buffer.subarray(0, highlightByteStart).toString("utf8").length;
  const highlightEnd = buffer.subarray(0, highlightByteEnd).toString("utf8").length;
  return {
    fileSize: stat.size,
    windowStart: start,
    windowEnd: end,
    targetStart,
    targetEnd,
    targetTruncated: targetEnd > end || targetStart < start,
    highlightStart,
    highlightEnd,
    text: raw,
  };
}

async function readJsonKeyRange(fileName, start, end) {
  try {
    return JSON.parse(await readUtf8Range(fileName, start, end));
  } catch (_e) {
    return "key@" + start;
  }
}

async function buildLargeFilePreview(fileName, options, onProgress, cancelToken) {
  if (isJsoncFile(fileName)) {
    throw new Error(
      "Large-file mode does not support JSONC yet. Use strict .json, .jsonl, or .ndjson for large files."
    );
  }

  if (isLineDelimitedFile(fileName)) {
    return buildLargeJsonlPreview(fileName, options, onProgress, cancelToken);
  }

  return buildLargeJsonPreview(fileName, options, onProgress, cancelToken);
}

async function buildLargeJsonlPreview(fileName, options, onProgress, cancelToken) {
  const stat = await fs.promises.stat(fileName);
  const offsets = new Map();
  const children = [];
  const errors = [];
  const previewLimit = options.previewEntries;
  const pageCursors = [];

  let bytesRead = 0;
  let lastProgress = 0;
  let carry = Buffer.alloc(0);
  let carryStart = 0;
  let lineNo = 1;
  let records = 0;

  const scanLine = (lineBuf, lineStart) => {
    let start = 0;
    let end = lineBuf.length;
    if (end > start && lineBuf[end - 1] === 13) end--;
    while (start < end && isWsByte(lineBuf[start])) start++;
    while (end > start && isWsByte(lineBuf[end - 1])) end--;
    if (start >= end) return;

    const valStart = lineStart + start;
    const valEnd = lineStart + end;
    const text = lineBuf.subarray(start, end).toString("utf8");
    try {
      JSON.parse(text);
      if (records % previewLimit === 0) {
        pageCursors.push({ index: records, offset: valStart, line: lineNo });
      }
      if (children.length < previewLimit) {
        const node = parseToTree(text);
        const pathName = "$[" + records + "]";
        const projected = projectNodeByteOffsets(
          node,
          pathName,
          valStart,
          text,
          offsets
        );
        children.push(projected);
      }
      records++;
    } catch (e) {
      if (errors.length < 50) {
        errors.push({ line: lineNo, message: e.message });
      }
    }
  };

  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(fileName, { highWaterMark: 1024 * 1024 });
    stream.on("data", (chunk) => {
      if (cancelToken && cancelToken.cancelled) {
        stream.destroy(new Error("Large-file indexing cancelled."));
        return;
      }
      const buf = carry.length ? Buffer.concat([carry, chunk]) : chunk;
      let lineStart = carryStart;
      let start = 0;
      let nl;
      while ((nl = buf.indexOf(10, start)) !== -1) {
        scanLine(buf.subarray(start, nl), lineStart);
        start = nl + 1;
        lineStart = carryStart + start;
        lineNo++;
      }
      carry = buf.subarray(start);
      carryStart = lineStart;
      bytesRead += chunk.length;
      if (bytesRead - lastProgress >= 64 * 1024 * 1024) {
        lastProgress = bytesRead;
        onProgress && onProgress({ bytesRead, entries: records });
      }
    });
    stream.on("error", reject);
    stream.on("end", () => {
      try {
        if (carry.length) scanLine(carry, carryStart);
        resolve();
      } catch (e) {
        reject(e);
      }
    });
  });

  if (records === 0) {
    throw new Error(
      "No valid JSONL records found." +
        (errors.length
          ? "\n" + errors.map((e) => `line ${e.line}: ${e.message}`).join("\n")
          : "")
    );
  }

  offsets.set("$", { key: 0, val: 0, end: stat.size });
  return {
    tree: { t: "array", c: children },
    offsets,
    errors,
    jsonl: true,
    rootType: "array",
    mode: "jsonl",
    fileSize: stat.size,
    totalEntries: records,
    indexedEntries: children.length,
    shownEntries: children.length,
    truncated: records > children.length,
    pageSize: previewLimit,
    pageCursors,
  };
}

async function buildLargeJsonPreview(fileName, options, onProgress, cancelToken) {
  const stat = await fs.promises.stat(fileName);
  const scanned = await scanLargeJsonTopLevel(
    fileName,
    onProgress,
    options.previewEntries,
    options.previewEntries,
    cancelToken
  );
  const previewLimit = Math.min(options.previewEntries, scanned.entries.length);
  const projected = await projectLargeJsonEntries(
    fileName,
    scanned.rootType,
    scanned.entries.slice(0, previewLimit),
    0,
    options
  );
  const offsets = projected.offsets;
  const children = projected.children;

  offsets.set("$", {
    key: scanned.rootStart,
    val: scanned.rootStart,
    end: scanned.rootEnd || stat.size,
  });

  return {
    tree: { t: scanned.rootType, c: children },
    offsets,
    errors: [],
    jsonl: false,
    rootType: scanned.rootType,
    mode: "json",
    fileSize: stat.size,
    totalEntries: scanned.totalEntries,
    indexedEntries: scanned.entries.length,
    shownEntries: children.length,
    truncated: scanned.totalEntries > children.length,
    pageSize: options.previewEntries,
    pageCursors: scanned.pageCursors,
  };
}

async function buildLargeFilePage(fileName, indexState, startIndex, options) {
  if (indexState.mode === "jsonl") {
    return buildLargeJsonlPage(fileName, indexState, startIndex, options);
  }
  return buildLargeJsonPage(fileName, indexState, startIndex, options);
}

function findPageCursor(indexState, startIndex) {
  const cursors = indexState.pageCursors || [];
  let best = null;
  for (const cursor of cursors) {
    if (cursor.index <= startIndex && (!best || cursor.index > best.index)) {
      best = cursor;
    }
  }
  if (!best) {
    throw new Error(`No page cursor for entry ${startIndex}.`);
  }
  return best;
}

async function buildLargeJsonlPage(fileName, indexState, startIndex, options) {
  const cursor = findPageCursor(indexState, startIndex);
  const skip = startIndex - cursor.index;
  const scanned = await scanLargeJsonlPageFromOffset(
    fileName,
    cursor.offset,
    options.previewEntries + skip,
    cursor.index,
    cursor.line || 1
  );
  const selected = scanned.entries.slice(skip, skip + options.previewEntries);
  const offsets = new Map();
  const children = [];
  for (let i = 0; i < selected.length; i++) {
    const entry = selected[i];
    const text = await readUtf8Range(fileName, entry.valStart, entry.valEnd);
    const node = parseToTree(text);
    const globalIndex = startIndex + i;
    const projected = projectNodeByteOffsets(
      node,
      "$[" + globalIndex + "]",
      entry.valStart,
      text,
      offsets
    );
    projected.k = String(globalIndex);
    projected.i = globalIndex;
    children.push(projected);
  }
  return { start: startIndex, children, offsets };
}

async function buildLargeJsonPage(fileName, indexState, startIndex, options) {
  const cursor = findPageCursor(indexState, startIndex);
  const skip = startIndex - cursor.index;
  const scanned = await scanJsonTopLevelPageFromOffset(
    fileName,
    indexState.rootType,
    cursor.offset,
    options.previewEntries + skip
  );
  const selected = scanned.entries.slice(skip, skip + options.previewEntries);
  const projected = await projectLargeJsonEntries(
    fileName,
    indexState.rootType,
    selected,
    startIndex,
    options
  );
  return { start: startIndex, children: projected.children, offsets: projected.offsets };
}

async function scanLargeJsonlPageFromOffset(
  fileName,
  offset,
  limit,
  startRecordIndex,
  startLineNo
) {
  const entries = [];
  let carry = Buffer.alloc(0);
  let carryStart = offset;
  let lineNo = startLineNo;
  let recordIndex = startRecordIndex;

  const scanLine = (lineBuf, lineStart) => {
    let start = 0;
    let end = lineBuf.length;
    if (end > start && lineBuf[end - 1] === 13) end--;
    while (start < end && isWsByte(lineBuf[start])) start++;
    while (end > start && isWsByte(lineBuf[end - 1])) end--;
    if (start >= end) return;

    const valStart = lineStart + start;
    const valEnd = lineStart + end;
    const text = lineBuf.subarray(start, end).toString("utf8");
    try {
      JSON.parse(text);
      entries.push({ index: recordIndex, valStart, valEnd });
      recordIndex++;
    } catch (_e) {
      // Keep moving; malformed lines are already summarized by the initial scan.
    }
  };

  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(fileName, {
      start: offset,
      highWaterMark: 1024 * 1024,
    });
    stream.on("data", (chunk) => {
      const buf = carry.length ? Buffer.concat([carry, chunk]) : chunk;
      let lineStart = carryStart;
      let start = 0;
      let nl;
      while ((nl = buf.indexOf(10, start)) !== -1) {
        scanLine(buf.subarray(start, nl), lineStart);
        if (entries.length >= limit) {
          stream.destroy();
          resolve();
          return;
        }
        start = nl + 1;
        lineStart = carryStart + start;
        lineNo++;
      }
      carry = buf.subarray(start);
      carryStart = lineStart;
    });
    stream.on("error", reject);
    stream.on("end", () => {
      try {
        if (carry.length && entries.length < limit) scanLine(carry, carryStart);
        resolve();
      } catch (e) {
        reject(e);
      }
    });
    stream.on("close", resolve);
  });

  return { entries };
}

async function scanJsonTopLevelPageFromOffset(fileName, rootType, offset, limit) {
  return rootType === "array"
    ? scanJsonArrayPageFromOffset(fileName, offset, limit)
    : scanJsonObjectPageFromOffset(fileName, offset, limit);
}

async function scanJsonArrayPageFromOffset(fileName, offset, limit) {
  const entries = [];
  let depth = 0;
  let inString = false;
  let escape = false;
  let valueStart = -1;
  let valueEnd = -1;

  const push = () => {
    if (valueStart >= 0 && valueEnd > valueStart) {
      entries.push({ valStart: valueStart, valEnd: valueEnd });
    }
    valueStart = -1;
    valueEnd = -1;
  };

  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(fileName, {
      start: offset,
      highWaterMark: 1024 * 1024,
    });
    stream.on("data", (chunk) => {
      try {
        for (let i = 0; i < chunk.length; i++) {
          const b = chunk[i];
          const pos = offset + i;

          if (inString) {
            valueEnd = pos + 1;
            if (escape) escape = false;
            else if (b === 92) escape = true;
            else if (b === 34) inString = false;
            continue;
          }

          if (valueStart < 0) {
            if (isWsByte(b) || b === 44) continue;
            if (b === 93) {
              stream.destroy();
              resolve();
              return;
            }
            valueStart = pos;
            valueEnd = pos + 1;
          }

          if (b === 34) {
            inString = true;
            valueEnd = pos + 1;
          } else if (b === 91 || b === 123) {
            depth++;
            valueEnd = pos + 1;
          } else if (b === 93 || b === 125) {
            if (depth > 0) {
              depth--;
              valueEnd = pos + 1;
            } else {
              push();
              stream.destroy();
              resolve();
              return;
            }
          } else if (b === 44 && depth === 0) {
            push();
            if (entries.length >= limit) {
              stream.destroy();
              resolve();
              return;
            }
          } else if (!isWsByte(b)) {
            valueEnd = pos + 1;
          }
        }
        offset += chunk.length;
      } catch (e) {
        stream.destroy(e);
      }
    });
    stream.on("error", reject);
    stream.on("end", () => {
      push();
      resolve();
    });
    stream.on("close", resolve);
  });

  return { entries };
}

async function scanJsonObjectPageFromOffset(fileName, offset, limit) {
  const entries = [];
  let depth = 0;
  let inString = false;
  let escape = false;
  let stringRole = "";
  let state = "key";
  let keyStart = -1;
  let keyEnd = -1;
  let valueStart = -1;
  let valueEnd = -1;

  const reset = () => {
    state = "key";
    keyStart = -1;
    keyEnd = -1;
    valueStart = -1;
    valueEnd = -1;
  };

  const push = () => {
    if (keyStart >= 0 && valueStart >= 0 && valueEnd > valueStart) {
      entries.push({ keyStart, keyEnd, valStart: valueStart, valEnd: valueEnd });
    }
    reset();
  };

  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(fileName, {
      start: offset,
      highWaterMark: 1024 * 1024,
    });
    stream.on("data", (chunk) => {
      try {
        for (let i = 0; i < chunk.length; i++) {
          const b = chunk[i];
          const pos = offset + i;

          if (inString) {
            if (state === "value" && valueStart >= 0) valueEnd = pos + 1;
            if (escape) escape = false;
            else if (b === 92) escape = true;
            else if (b === 34) {
              inString = false;
              if (stringRole === "key") {
                keyEnd = pos + 1;
                state = "colon";
                stringRole = "";
              }
            }
            continue;
          }

          if (state === "key") {
            if (isWsByte(b) || b === 44) continue;
            if (b === 125) {
              stream.destroy();
              resolve();
              return;
            }
            if (b === 34) {
              keyStart = pos;
              inString = true;
              stringRole = "key";
              continue;
            }
            throw new Error("Expected object key while loading large JSON page.");
          }

          if (state === "colon") {
            if (isWsByte(b)) continue;
            if (b === 58) {
              state = "value";
              continue;
            }
            throw new Error("Expected ':' while loading large JSON page.");
          }

          if (state === "value") {
            if (valueStart < 0) {
              if (isWsByte(b)) continue;
              valueStart = pos;
              valueEnd = pos + 1;
            }

            if (b === 34) {
              inString = true;
              valueEnd = pos + 1;
            } else if (b === 91 || b === 123) {
              depth++;
              valueEnd = pos + 1;
            } else if (b === 93 || b === 125) {
              if (depth > 0) {
                depth--;
                valueEnd = pos + 1;
              } else {
                push();
                stream.destroy();
                resolve();
                return;
              }
            } else if (b === 44 && depth === 0) {
              push();
              if (entries.length >= limit) {
                stream.destroy();
                resolve();
                return;
              }
            } else if (!isWsByte(b)) {
              valueEnd = pos + 1;
            }
          }
        }
        offset += chunk.length;
      } catch (e) {
        stream.destroy(e);
      }
    });
    stream.on("error", reject);
    stream.on("end", () => {
      push();
      resolve();
    });
    stream.on("close", resolve);
  });

  return { entries };
}

async function searchLargeFile(fileName, indexState, query, options, cancelToken) {
  return indexState.mode === "jsonl"
    ? searchLargeJsonl(fileName, query, options, cancelToken)
    : searchLargeJson(fileName, indexState, query, options, cancelToken);
}

async function searchLargeJsonl(fileName, query, options, cancelToken) {
  const q = query.toLowerCase();
  const offsets = new Map();
  const children = [];
  let totalMatches = 0;
  let carry = Buffer.alloc(0);
  let carryStart = 0;
  let recordIndex = 0;

  const scanLine = (lineBuf, lineStart) => {
    let start = 0;
    let end = lineBuf.length;
    if (end > start && lineBuf[end - 1] === 13) end--;
    while (start < end && isWsByte(lineBuf[start])) start++;
    while (end > start && isWsByte(lineBuf[end - 1])) end--;
    if (start >= end) return;

    const valStart = lineStart + start;
    const valEnd = lineStart + end;
    const text = lineBuf.subarray(start, end).toString("utf8");
    try {
      JSON.parse(text);
      const currentIndex = recordIndex++;
      if (!text.toLowerCase().includes(q)) return;
      totalMatches++;
      if (children.length >= options.previewEntries) return;

      const node = parseToTree(text);
      const projected = projectNodeByteOffsets(
        node,
        "$[" + currentIndex + "]",
        valStart,
        text,
        offsets
      );
      projected.k = String(currentIndex);
      projected.i = currentIndex;
      children.push(projected);
    } catch (_e) {
      // Ignore malformed lines during search; initial indexing reports samples.
    }
  };

  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(fileName, { highWaterMark: 1024 * 1024 });
    stream.on("data", (chunk) => {
      if (cancelToken && cancelToken.cancelled) {
        stream.destroy(new Error("Large-file search cancelled."));
        return;
      }
      const buf = carry.length ? Buffer.concat([carry, chunk]) : chunk;
      let lineStart = carryStart;
      let start = 0;
      let nl;
      while ((nl = buf.indexOf(10, start)) !== -1) {
        scanLine(buf.subarray(start, nl), lineStart);
        start = nl + 1;
        lineStart = carryStart + start;
      }
      carry = buf.subarray(start);
      carryStart = lineStart;
    });
    stream.on("error", reject);
    stream.on("end", () => {
      try {
        if (carry.length) scanLine(carry, carryStart);
        resolve();
      } catch (e) {
        reject(e);
      }
    });
  });

  return { children, offsets, totalMatches };
}

async function searchLargeJson(fileName, indexState, query, options, cancelToken) {
  const q = query.toLowerCase();
  const offsets = new Map();
  const children = [];
  let totalMatches = 0;
  const pageSize = indexState.pageSize || options.previewEntries;
  const handle = await fs.promises.open(fileName, "r");
  try {
    for (const cursor of indexState.pageCursors || []) {
      if (cancelToken && cancelToken.cancelled) {
        throw new Error("Large-file search cancelled.");
      }
      const scanned = await scanJsonTopLevelPageFromOffset(
        fileName,
        indexState.rootType,
        cursor.offset,
        pageSize
      );
      for (let i = 0; i < scanned.entries.length; i++) {
        if (cancelToken && cancelToken.cancelled) {
          throw new Error("Large-file search cancelled.");
        }
        const entry = scanned.entries[i];
        const globalIndex = cursor.index + i;
        let key = "";
        if (indexState.rootType === "object") {
          key = await readJsonKeyRange(fileName, entry.keyStart, entry.keyEnd);
        }
        let matched = key && key.toLowerCase().includes(q);
        const valueSize = entry.valEnd - entry.valStart;
        if (!matched && valueSize <= options.maxCopyBytes) {
          const text = await readUtf8RangeFromHandle(
            handle,
            entry.valStart,
            entry.valEnd
          );
          matched = text.toLowerCase().includes(q);
        } else if (!matched) {
          matched = await rangeIncludesText(
            fileName,
            entry.valStart,
            entry.valEnd,
            q,
            cancelToken
          );
        }
        if (!matched) continue;

        totalMatches++;
        if (children.length >= options.previewEntries) continue;
        const projected = await projectLargeJsonEntries(
          fileName,
          indexState.rootType,
          [entry],
          globalIndex,
          options
        );
        for (const [k, v] of projected.offsets) offsets.set(k, v);
        children.push(projected.children[0]);
      }
    }
  } finally {
    await handle.close();
  }

  return { children, offsets, totalMatches };
}

async function rangeIncludesText(fileName, start, end, lowerQuery, cancelToken) {
  if (!lowerQuery) return true;
  const overlapSize = Math.max(0, lowerQuery.length - 1);
  let carry = "";

  return new Promise((resolve, reject) => {
    const stream = fs.createReadStream(fileName, {
      start,
      end: Math.max(start, end - 1),
      highWaterMark: 1024 * 1024,
    });
    stream.on("data", (chunk) => {
      if (cancelToken && cancelToken.cancelled) {
        stream.destroy(new Error("Large-file search cancelled."));
        return;
      }
      const text = carry + chunk.toString("utf8").toLowerCase();
      if (text.includes(lowerQuery)) {
        stream.destroy();
        resolve(true);
        return;
      }
      carry = overlapSize ? text.slice(-overlapSize) : "";
    });
    stream.on("error", reject);
    stream.on("end", () => resolve(false));
    stream.on("close", () => resolve(false));
  });
}

async function projectLargeJsonEntries(
  fileName,
  rootType,
  entries,
  startIndex,
  options
) {
  const offsets = new Map();
  const children = [];

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const globalIndex = startIndex + i;
    let entryKey = entry.key;
    if (rootType === "object") {
      entryKey = await readJsonKeyRange(fileName, entry.keyStart, entry.keyEnd);
    }
    const nodePath =
      rootType === "array"
        ? "$[" + globalIndex + "]"
        : "$." + escapeKeyExt(entryKey);
    let projected;
    const entrySize = entry.valEnd - entry.valStart;
    if (entrySize > options.maxCopyBytes) {
      projected = {
        t: "string",
        k: rootType === "array" ? String(globalIndex) : entryKey,
        i: rootType === "array" ? globalIndex : undefined,
        r: `"<${formatBytes(entrySize)} value>"`,
        v: `<${formatBytes(entrySize)} value>`,
      };
      offsets.set(nodePath, {
        key: rootType === "object" ? entry.keyStart : entry.valStart,
        val: entry.valStart,
        end: entry.valEnd,
      });
    } else {
      const text = await readUtf8Range(fileName, entry.valStart, entry.valEnd);
      let node;
      try {
        JSON.parse(text);
        node = parseToTree(text);
      } catch (e) {
        throw new Error(
          `Invalid JSON value at byte ${entry.valStart}: ${
            e && e.message ? e.message : String(e)
          }`
        );
      }
      projected = projectNodeByteOffsets(
        node,
        nodePath,
        entry.valStart,
        text,
        offsets
      );
      if (rootType === "array") {
        projected.k = String(globalIndex);
        projected.i = globalIndex;
      }
    }
    if (rootType === "object") {
      projected.k = entryKey;
      offsets.set(nodePath, {
        key: entry.keyStart,
        val: entry.valStart,
        end: entry.valEnd,
      });
    }
    children.push(projected);
  }

  return { children, offsets };
}

async function scanLargeJsonTopLevel(
  fileName,
  onProgress,
  maxStoredEntries = Infinity,
  pageSize = maxStoredEntries,
  cancelToken
) {
  const entries = [];
  const pageCursors = [];
  let totalEntries = 0;
  let rootType = null;
  let rootStart = 0;
  let rootEnd = 0;
  let depth = 0;
  let inString = false;
  let escape = false;
  let stringRole = "";
  let bytesRead = 0;
  let lastProgress = 0;

  let arrayValueStart = -1;
  let arrayValueEnd = -1;
  let arrayAfterComma = false;

  let objectState = "key";
  let keyStart = -1;
  let keyEnd = -1;
  let objectValueStart = -1;
  let objectValueEnd = -1;
  let objectAfterComma = false;

  const resetObjectEntry = () => {
    objectState = "key";
    keyStart = -1;
    keyEnd = -1;
    objectValueStart = -1;
    objectValueEnd = -1;
  };

  const pushArrayEntry = () => {
    if (arrayValueStart >= 0 && arrayValueEnd > arrayValueStart) {
      if (pageSize > 0 && totalEntries % pageSize === 0) {
        pageCursors.push({ index: totalEntries, offset: arrayValueStart });
      }
      totalEntries++;
      if (entries.length < maxStoredEntries) {
        entries.push({ valStart: arrayValueStart, valEnd: arrayValueEnd });
      }
      arrayAfterComma = false;
    }
    arrayValueStart = -1;
    arrayValueEnd = -1;
  };

  const pushObjectEntry = () => {
    if (keyStart >= 0 && objectValueStart >= 0 && objectValueEnd > objectValueStart) {
      if (pageSize > 0 && totalEntries % pageSize === 0) {
        pageCursors.push({ index: totalEntries, offset: keyStart });
      }
      totalEntries++;
      if (entries.length < maxStoredEntries) {
        entries.push({
          keyStart,
          keyEnd,
          valStart: objectValueStart,
          valEnd: objectValueEnd,
        });
      }
      objectAfterComma = false;
    }
    resetObjectEntry();
  };

  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(fileName, { highWaterMark: 1024 * 1024 });
    stream.on("data", (chunk) => {
      try {
        if (cancelToken && cancelToken.cancelled) {
          stream.destroy(new Error("Large-file indexing cancelled."));
          return;
        }
        for (let i = 0; i < chunk.length; i++) {
          const b = chunk[i];
          const pos = bytesRead + i;
          if (rootEnd) {
            if (!isWsByte(b)) {
              throw new Error("Unexpected content after JSON root.");
            }
            continue;
          }

          if (inString) {
            if (rootType === "array" && arrayValueStart >= 0) {
              arrayValueEnd = pos + 1;
            } else if (
              rootType === "object" &&
              objectState === "value" &&
              objectValueStart >= 0
            ) {
              objectValueEnd = pos + 1;
            }

            if (escape) {
              escape = false;
            } else if (b === 92) {
              escape = true;
            } else if (b === 34) {
              inString = false;
              if (stringRole === "objectKey") {
                keyEnd = pos + 1;
                objectState = "colon";
                stringRole = "";
              }
            }
            continue;
          }

          if (!rootType) {
            if (isWsByte(b)) continue;
            if (b === 91) {
              rootType = "array";
              rootStart = pos;
              depth = 1;
              continue;
            }
            if (b === 123) {
              rootType = "object";
              rootStart = pos;
              depth = 1;
              continue;
            }
            throw new Error("Large-file mode supports JSON arrays or objects at the root.");
          }

          if (rootType === "array") {
            if (depth === 1) {
              if (arrayValueStart < 0 && b === 44) {
                throw new Error("Unexpected comma while indexing large JSON array.");
              }
              if (arrayValueStart < 0 && b === 93) {
                if (arrayAfterComma) {
                  throw new Error("Trailing comma while indexing large JSON array.");
                }
                rootEnd = pos + 1;
                depth = 0;
                continue;
              }
              if (arrayValueStart < 0 && !isWsByte(b)) {
                arrayValueStart = pos;
                arrayValueEnd = pos + 1;
                arrayAfterComma = false;
              }
              if (b === 34) {
                inString = true;
                if (arrayValueStart < 0) arrayValueStart = pos;
                arrayValueEnd = pos + 1;
                continue;
              }
              if (b === 91 || b === 123) {
                if (arrayValueStart < 0) arrayValueStart = pos;
                depth++;
                arrayValueEnd = pos + 1;
                continue;
              }
              if (b === 44) {
                pushArrayEntry();
                arrayAfterComma = true;
                continue;
              }
              if (b === 93) {
                pushArrayEntry();
                rootEnd = pos + 1;
                depth = 0;
                continue;
              }
              if (arrayValueStart >= 0 && !isWsByte(b)) arrayValueEnd = pos + 1;
              continue;
            }

            if (b === 34) {
              inString = true;
              arrayValueEnd = pos + 1;
            } else if (b === 91 || b === 123) {
              depth++;
              arrayValueEnd = pos + 1;
            } else if (b === 93 || b === 125) {
              depth--;
              arrayValueEnd = pos + 1;
            } else {
              arrayValueEnd = pos + 1;
            }
            continue;
          }

          if (rootType === "object") {
            if (depth === 1) {
              if (objectState === "key") {
                if (isWsByte(b)) continue;
                if (b === 44) {
                  throw new Error("Unexpected comma while indexing large JSON object.");
                }
                if (b === 125) {
                  if (objectAfterComma) {
                    throw new Error("Trailing comma while indexing large JSON object.");
                  }
                  rootEnd = pos + 1;
                  depth = 0;
                  continue;
                }
                if (b === 34) {
                  objectAfterComma = false;
                  keyStart = pos;
                  inString = true;
                  stringRole = "objectKey";
                  continue;
                }
                throw new Error("Expected object key while indexing large JSON.");
              }

              if (objectState === "colon") {
                if (isWsByte(b)) continue;
                if (b === 58) {
                  objectState = "value";
                  continue;
                }
                throw new Error("Expected ':' while indexing large JSON object.");
              }

              if (objectState === "value") {
                if (objectValueStart < 0) {
                  if (isWsByte(b)) continue;
                  objectValueStart = pos;
                  objectValueEnd = pos + 1;
                }
                if (b === 34) {
                  inString = true;
                  objectValueEnd = pos + 1;
                  continue;
                }
                if (b === 91 || b === 123) {
                  depth++;
                  objectValueEnd = pos + 1;
                  continue;
                }
                if (b === 44) {
                  pushObjectEntry();
                  objectAfterComma = true;
                  continue;
                }
                if (b === 125) {
                  pushObjectEntry();
                  rootEnd = pos + 1;
                  depth = 0;
                  continue;
                }
                if (!isWsByte(b)) objectValueEnd = pos + 1;
                continue;
              }
            }

            if (b === 34) {
              inString = true;
              objectValueEnd = pos + 1;
            } else if (b === 91 || b === 123) {
              depth++;
              objectValueEnd = pos + 1;
            } else if (b === 93 || b === 125) {
              depth--;
              objectValueEnd = pos + 1;
            } else {
              objectValueEnd = pos + 1;
            }
          }
        }

        bytesRead += chunk.length;
        if (bytesRead - lastProgress >= 64 * 1024 * 1024) {
          lastProgress = bytesRead;
          onProgress && onProgress({ bytesRead, entries: totalEntries });
        }
      } catch (e) {
        stream.destroy(e);
      }
    });
    stream.on("error", reject);
    stream.on("end", resolve);
  });

  if (!rootType) throw new Error("No JSON root value found.");
  if (inString) throw new Error("Unterminated string while indexing large JSON.");
  if (!rootEnd || depth !== 0) {
    throw new Error("Unexpected end of JSON while indexing large JSON.");
  }
  return { rootType, rootStart, rootEnd, entries, totalEntries, pageCursors };
}

function getHtml(webview, expandLevel) {
  const nonce = String(Date.now()) + Math.random().toString(36).slice(2);
  const csp = [
    `default-src 'none'`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${nonce}'`,
  ].join("; ");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<style>${STYLES}</style>
</head>
<body>
  <div id="toolbar">
    <input id="search" type="text" placeholder="Filter by key or value…" />
    <span id="matchCount" class="muted"></span>
    <span class="spacer"></span>
    <div id="rangeControls" class="range-controls" hidden>
      <button id="prevPage" title="Previous entry range">Prev</button>
      <input id="rangeStart" type="number" min="0" step="1" placeholder="Start" title="Start index" />
      <input id="rangeCount" type="number" min="1" step="1" placeholder="Count" title="Entry count" />
      <button id="goRange" title="Load entry range">Go</button>
      <button id="nextPage" title="Next entry range">Next</button>
    </div>
    <button id="expandAll" title="Expand all">Expand all</button>
    <button id="collapseAll" title="Collapse all">Collapse all</button>
  </div>
  <div id="status" class="muted"></div>
  <div id="sourcePreview" hidden>
    <div class="source-head">
      <span id="sourceTitle"></span>
      <button id="closeSourcePreview" title="Close source preview">Close</button>
      <button id="copySourceRange" title="Copy byte range">Copy range</button>
    </div>
    <pre id="sourceText"></pre>
  </div>
  <div id="tree"></div>
  <script nonce="${nonce}">
    const AUTO_EXPAND_LEVEL = ${Number(expandLevel) || 0};
    ${CLIENT_JS}
  </script>
</body>
</html>`;
}

const STYLES = `
:root {
  --row-h: 22px;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  padding: 0;
  font-family: var(--vscode-editor-font-family, monospace);
  font-size: var(--vscode-editor-font-size, 13px);
  color: var(--vscode-foreground);
  background: var(--vscode-editor-background);
}
#toolbar {
  position: sticky;
  top: 0;
  z-index: 2;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  background: var(--vscode-sideBar-background, var(--vscode-editor-background));
  border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.3));
}
#toolbar .spacer { flex: 1; }
#search,
.range-controls input {
  flex: 0 1 320px;
  padding: 3px 8px;
  color: var(--vscode-input-foreground);
  background: var(--vscode-input-background);
  border: 1px solid var(--vscode-input-border, transparent);
  border-radius: 3px;
}
.range-controls {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.range-controls[hidden] { display: none; }
.range-controls input {
  flex: 0 0 86px;
  width: 86px;
}
button {
  padding: 3px 10px;
  color: var(--vscode-button-secondaryForeground, var(--vscode-button-foreground));
  background: var(--vscode-button-secondaryBackground, var(--vscode-button-background));
  border: none;
  border-radius: 3px;
  cursor: pointer;
}
button:hover { background: var(--vscode-button-hoverBackground); }
.muted { color: var(--vscode-descriptionForeground); }
#status { padding: 6px 10px; }
#tree { padding: 4px 0 40px; }
#sourcePreview {
  margin: 8px 10px;
  border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.3));
  background: var(--vscode-editorWidget-background, var(--vscode-editor-background));
}
.source-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 8px;
  border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.3));
}
#sourceTitle { flex: 1; color: var(--vscode-descriptionForeground); }
#sourceText {
  max-height: 260px;
  overflow: auto;
  margin: 0;
  padding: 8px;
  white-space: pre-wrap;
  word-break: break-word;
}
.source-hit {
  color: var(--vscode-editor-foreground);
  background: var(--vscode-editor-findMatchHighlightBackground, rgba(234,92,0,0.35));
  outline: 1px solid var(--vscode-editor-findMatchBorder, rgba(234,92,0,0.6));
}

.row {
  display: flex;
  align-items: center;
  height: var(--row-h);
  line-height: var(--row-h);
  white-space: nowrap;
  cursor: default;
}
.row:hover { background: var(--vscode-list-hoverBackground); }
.row.match { background: var(--vscode-editor-findMatchHighlightBackground, rgba(234,92,0,0.2)); }

.twisty {
  width: 16px;
  text-align: center;
  flex: 0 0 16px;
  color: var(--vscode-icon-foreground, var(--vscode-foreground));
  cursor: pointer;
  user-select: none;
}
.twisty.leaf { visibility: hidden; }

.key { color: var(--vscode-symbolIcon-variableForeground, #9cdcfe); }
.eq { opacity: 0.6; margin: 0 6px; }
.type-label { color: var(--vscode-descriptionForeground); margin-right: 6px; }

.val { }
.t-string { color: var(--vscode-debugTokenExpression-string, #ce9178); }
.t-number { color: var(--vscode-debugTokenExpression-number, #b5cea8); }
.t-boolean { color: var(--vscode-debugTokenExpression-boolean, #569cd6); }
.t-null { color: var(--vscode-debugTokenExpression-name, #808080); font-style: italic; }

.badge {
  margin-left: 8px;
  padding: 0 5px;
  font-size: 0.82em;
  border-radius: 3px;
  color: var(--vscode-badge-foreground);
  background: var(--vscode-badge-background);
  opacity: 0.75;
}
.actions {
  margin-left: 10px;
  display: none;
  gap: 8px;
}
.row:hover .actions { display: inline-flex; }
.actions a {
  color: var(--vscode-textLink-foreground);
  cursor: pointer;
  font-size: 0.85em;
  text-decoration: none;
}
.actions a:hover { text-decoration: underline; }
.ctxmenu {
  position: fixed;
  z-index: 50;
  min-width: 200px;
  padding: 4px 0;
  color: var(--vscode-menu-foreground, var(--vscode-foreground));
  background: var(--vscode-menu-background, var(--vscode-editorWidget-background));
  border: 1px solid var(--vscode-menu-border, var(--vscode-widget-border, rgba(128,128,128,0.35)));
  border-radius: 4px;
  box-shadow: 0 2px 10px rgba(0,0,0,0.35);
}
.ctxitem {
  display: flex;
  justify-content: space-between;
  gap: 18px;
  padding: 4px 14px;
  cursor: pointer;
  white-space: nowrap;
}
.ctxitem .hint { opacity: 0.55; font-size: 0.85em; }
.ctxitem:hover {
  color: var(--vscode-menu-selectionForeground, var(--vscode-list-activeSelectionForeground));
  background: var(--vscode-menu-selectionBackground, var(--vscode-list-activeSelectionBackground));
}
.error {
  margin: 12px;
  padding: 10px 12px;
  color: var(--vscode-inputValidation-errorForeground, #f48771);
  border: 1px solid var(--vscode-inputValidation-errorBorder, #be1100);
  background: var(--vscode-inputValidation-errorBackground, rgba(190,17,0,0.1));
  border-radius: 3px;
  white-space: pre-wrap;
}
`;

const CLIENT_JS = `
const vscode = acquireVsCodeApi();
const treeEl = document.getElementById("tree");
const statusEl = document.getElementById("status");
const searchEl = document.getElementById("search");
const matchCountEl = document.getElementById("matchCount");
const rangeControlsEl = document.getElementById("rangeControls");
const prevPageBtn = document.getElementById("prevPage");
const nextPageBtn = document.getElementById("nextPage");
const rangeStartEl = document.getElementById("rangeStart");
const rangeCountEl = document.getElementById("rangeCount");
const goRangeBtn = document.getElementById("goRange");
const sourcePreviewEl = document.getElementById("sourcePreview");
const sourceTitleEl = document.getElementById("sourceTitle");
const sourceTextEl = document.getElementById("sourceText");
const copySourceRangeBtn = document.getElementById("copySourceRange");
let lastSourceRange = "";

let model = null;       // root node
let normalModel = null;
let filterText = "";
let largeMeta = null;
let loadingRange = false;
let largeSearchSeq = 0;
let backendSearchActive = false;

// Wrap the lean tree from the extension (nodes: {t,r,k?,v?,c?}) into the render
// model, adding stable ids, depth, paths, and expand state. The raw source text
// (node.raw) is preserved untouched so display/copy are byte-faithful to file.
let idSeq = 0;
function wrap(n, key, path, depth) {
  const node = {
    id: ++idSeq,
    key,
    path,
    type: n.t,
    raw: n.r,
    value: n.v, // leaves: decoded primitive (string/bool/null) or parsed number
    depth,
    children: null,
    expanded: depth <= AUTO_EXPAND_LEVEL,
  };
  if (n.t === "object") {
    node.children = n.c.map((ch) =>
      wrap(ch, ch.k, path + "." + escapeKey(ch.k), depth + 1)
    );
  } else if (n.t === "array") {
    // Zero-pad indices so long lists still scan in numeric order.
    const pad = String(Math.max(0, n.c.length - 1)).length;
    node.children = n.c.map((ch, i) => {
      const index = typeof ch.i === "number" ? ch.i : i;
      const key = ch.k !== undefined ? String(ch.k) : String(index).padStart(pad, "0");
      return wrap(ch, key, path + "[" + index + "]", depth + 1);
    });
  }
  return node;
}

function escapeKey(k) {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(k) ? k : JSON.stringify(k);
}

function isBranchNode(node) {
  return node.type === "object" || node.type === "array";
}

// int vs float is decided from the RAW source token, not the parsed number, so
// "100.00" reads {float} and a 30-digit integer reads {int}.
function numKind(node) {
  return /[.eE]/.test(node.raw) ? "float" : "int";
}

// Python-style type names keep object/list/string labels compact in the tree.
function pyType(node) {
  switch (node.type) {
    case "object": return "dict";
    case "array": return "list";
    case "string": return "str";
    case "boolean": return "bool";
    case "null": return "NoneType";
    case "number": return numKind(node);
  }
  return node.type;
}

// Leaf display. Numbers show their EXACT source text (no precision loss / no
// reformatting); strings show the decoded text in single quotes (truncated for
// display only — copy always uses the full raw source).
function pyValue(node) {
  if (node.type === "number") return node.raw;
  if (node.type === "string") {
    const s = "'" + node.value + "'";
    return s.length > 200 ? s.slice(0, 199) + "…'" : s;
  }
  if (node.type === "boolean") return node.value ? "True" : "False";
  if (node.type === "null") return "None";
  return node.raw;
}

// "Copy structure": replace every leaf value with its type name, and collapse
// arrays to a single representative element, producing a shape/skeleton.
function skeleton(node) {
  if (node.type === "object") {
    const o = {};
    for (const c of node.children) o[c.key] = skeleton(c);
    if (
      largeMeta &&
      node.path === "$" &&
      node.children &&
      node.children.length < (largeMeta.totalEntries || 0)
    ) {
      o.__jsonViewerOmittedTopLevelEntries =
        (largeMeta.totalEntries || 0) - node.children.length;
    }
    return o;
  }
  if (node.type === "array") {
    return node.children.length ? [skeleton(node.children[0])] : [];
  }
  return node.type === "number"
    ? numKind(node)
    : { string: "str", boolean: "bool", null: "NoneType" }[node.type];
}

function copyStructure(node) {
  const skel = skeleton(node);
  const out = isBranchNode(node) ? JSON.stringify(skel, null, 2) : String(skel);
  vscode.postMessage({ type: "copy", value: out, label: "structure" });
}

// Copy the EXACT source text of the value — byte-for-byte identical to the
// file. Leaves carry their raw text; branches are sliced from source by the
// extension (it holds the offset map) to avoid shipping duplicated text.
function copyNodeValue(node) {
  vscode.postMessage({ type: "copyRaw", path: node.path });
}

function jumpTo(node, which) {
  vscode.postMessage({ type: "reveal", path: node.path, which: which });
}

// --- custom right-click menu ---
let menuEl = null;
function closeMenu() {
  if (menuEl) { menuEl.remove(); menuEl = null; }
}
document.addEventListener("click", closeMenu);
document.addEventListener("scroll", closeMenu, true);
window.addEventListener("blur", closeMenu);
document.addEventListener("keydown", function (e) { if (e.key === "Escape") closeMenu(); });

function showMenu(x, y, node) {
  closeMenu();
  menuEl = document.createElement("div");
  menuEl.className = "ctxmenu";
  const items = [
    ["Copy structure", "", function () { copyStructure(node); }],
    ["Copy value", "", function () { copyNodeValue(node); }],
    ["Copy path", "", function () { vscode.postMessage({ type: "copy", value: node.path, label: "path" }); }],
    ["Jump to source", "", function () { jumpTo(node, "value"); }],
  ];
  for (const it of items) {
    const el = document.createElement("div");
    el.className = "ctxitem";
    const label = document.createElement("span");
    label.textContent = it[0];
    el.appendChild(label);
    if (it[1]) {
      const hint = document.createElement("span");
      hint.className = "hint";
      hint.textContent = it[1];
      el.appendChild(hint);
    }
    el.addEventListener("click", function (e) {
      e.stopPropagation();
      it[2]();
      closeMenu();
    });
    menuEl.appendChild(el);
  }
  document.body.appendChild(menuEl);
  const r = menuEl.getBoundingClientRect();
  menuEl.style.left = Math.min(x, window.innerWidth - r.width - 6) + "px";
  menuEl.style.top = Math.min(y, window.innerHeight - r.height - 6) + "px";
}

function nodeMatches(node, q) {
  if (!q) return true;
  if (String(node.key).toLowerCase().includes(q)) return true;
  if (!isBranchNode(node)) {
    if (node.raw && node.raw.toLowerCase().includes(q)) return true;
    if (node.value != null && String(node.value).toLowerCase().includes(q)) return true;
  }
  return false;
}

// Returns true if node or any descendant matches; marks node.\_match for the
// row that directly matches and node.\_visible for rows to render.
function computeFilter(node, q) {
  const self = nodeMatches(node, q);
  let childHit = false;
  if (node.children) {
    for (const c of node.children) {
      if (computeFilter(c, q)) childHit = true;
    }
  }
  node._match = self && !!q;
  node._visible = !q || self || childHit;
  // Auto-expand to reveal matches while filtering.
  if (q && childHit) node._forceOpen = true;
  else node._forceOpen = false;
  return self || childHit;
}

function render() {
  treeEl.innerHTML = "";
  if (!model) return;
  const q = backendSearchActive ? "" : filterText.trim().toLowerCase();
  let matches = 0;
  if (q) {
    computeFilter(model, q);
  }
  const frag = document.createDocumentFragment();
  const walk = (node) => {
    if (q && !node._visible) return;
    if (node._match) matches++;
    frag.appendChild(rowEl(node, q));
    const open = q ? node._forceOpen || node.expanded : node.expanded;
    if (node.children && open) {
      for (const c of node.children) walk(c);
    }
  };
  walk(model);
  treeEl.appendChild(frag);
  matchCountEl.textContent = q ? matches + " match" + (matches === 1 ? "" : "es") : "";
}

function rowEl(node, q) {
  const row = document.createElement("div");
  row.className = "row" + (node._match ? " match" : "");
  row.style.paddingLeft = 8 + node.depth * 14 + "px";

  const isBranch = node.type === "object" || node.type === "array";
  const open = q ? node._forceOpen || node.expanded : node.expanded;

  const tw = document.createElement("span");
  tw.className = "twisty" + (isBranch ? "" : " leaf");
  tw.textContent = isBranch ? (open ? "▾" : "▸") : "•";
  if (isBranch) {
    tw.addEventListener("click", () => {
      node.expanded = !open;
      render();
    });
  }
  row.appendChild(tw);

  // key = {type} …   (inspector-style row)
  const key = document.createElement("span");
  key.className = "key";
  key.textContent = node.key;
  row.appendChild(key);

  const eq = document.createElement("span");
  eq.className = "eq";
  eq.textContent = "=";
  row.appendChild(eq);

  const typeSpan = document.createElement("span");
  typeSpan.className = "type-label";
  typeSpan.textContent =
    "{" + pyType(node) + (isBranch ? ": " + node.children.length : "") + "}";
  row.appendChild(typeSpan);

  if (!isBranch) {
    const val = document.createElement("span");
    val.className = "val t-" + node.type;
    val.textContent = pyValue(node);
    row.appendChild(val);
  }

  // Right-click -> custom context menu (copy structure / value / path / jump).
  row.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    showMenu(e.clientX, e.clientY, node);
  });
  row.title = "Right-click for menu (copy / jump)";

  return row;
}

function setAll(node, expanded) {
  node.expanded = expanded;
  if (node.children) for (const c of node.children) setAll(c, expanded);
}

document.getElementById("expandAll").addEventListener("click", () => {
  if (model) { setAll(model, true); render(); }
});
document.getElementById("collapseAll").addEventListener("click", () => {
  if (model) { setAll(model, false); model.expanded = true; render(); }
});

document.getElementById("closeSourcePreview").addEventListener("click", () => {
  sourcePreviewEl.hidden = true;
});

copySourceRangeBtn.addEventListener("click", () => {
  if (lastSourceRange) vscode.postMessage({ type: "copy", value: lastSourceRange, label: "byte range" });
});

function requestLargeRange(start, count) {
  if (!largeMeta || loadingRange) return;
  const total = largeMeta.totalEntries || 0;
  if (total <= 0) return;
  const maxCount = largeMeta.pageSize || largeMeta.shownEntries || 1;
  const nextStart = clampClientInt(start, 0, total - 1, largeMeta.pageStart || 0);
  const nextCount = clampClientInt(count, 1, maxCount, maxCount);
  rangeStartEl.value = String(nextStart);
  rangeCountEl.value = String(nextCount);
  loadingRange = true;
  updateRangeControls();
  statusEl.textContent = "Large file mode: loading entry range...";
  vscode.postMessage({ type: "largeLoadRange", start: nextStart, count: nextCount });
}

function currentRangeCount() {
  return clampClientInt(
    rangeCountEl.value,
    1,
    largeMeta ? largeMeta.pageSize || 1 : 1,
    largeMeta ? largeMeta.pageCount || largeMeta.pageSize || 1 : 1
  );
}

goRangeBtn.addEventListener("click", () => {
  requestLargeRange(rangeStartEl.value, currentRangeCount());
});
rangeStartEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter") requestLargeRange(rangeStartEl.value, currentRangeCount());
});
rangeCountEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter") requestLargeRange(rangeStartEl.value, currentRangeCount());
});
prevPageBtn.addEventListener("click", () => {
  if (!largeMeta) return;
  const count = currentRangeCount();
  requestLargeRange((largeMeta.pageStart || 0) - count, count);
});
nextPageBtn.addEventListener("click", () => {
  if (!largeMeta) return;
  const count = currentRangeCount();
  requestLargeRange(largeMeta.pageEnd || (largeMeta.pageStart || 0) + count, count);
});

let searchTimer;
searchEl.addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    filterText = searchEl.value;
    if (largeMeta) {
      const q = filterText.trim();
      largeSearchSeq++;
      if (!q) {
        backendSearchActive = false;
        model = normalModel;
        updateLargeStatus();
        updateRangeControls();
        render();
      } else {
        backendSearchActive = true;
        rangeControlsEl.hidden = true;
        statusEl.textContent = "Large file mode: searching...";
        vscode.postMessage({ type: "largeSearch", query: q, seq: largeSearchSeq });
      }
    } else {
      backendSearchActive = false;
      render();
    }
  }, 120);
});

window.addEventListener("message", (event) => {
  const msg = event.data;
  if (msg.type === "largeStatus") {
    statusEl.textContent = msg.text || "Large file mode...";
    return;
  }
  if (msg.type === "sourcePreview") {
    showSourcePreview(msg);
    return;
  }
  if (msg.type === "largeRange") {
    if (!normalModel || !normalModel.children) return;
    largeMeta = msg.large || largeMeta;
    replaceLargeChildren(msg.children || [], msg.start || 0);
    if (!filterText.trim()) model = normalModel;
    loadingRange = false;
    updateLargeStatus();
    updateRangeControls();
    render();
    return;
  }
  if (msg.type === "largeSearchResults") {
    if (msg.seq !== largeSearchSeq) return;
    backendSearchActive = true;
    idSeq = 0;
    const q = msg.query || "";
    model = wrap(msg.tree, "Search: " + q, "$", 0);
    model.expanded = true;
    const info = msg.largeSearch || {};
    statusEl.textContent =
      "Large file search · " +
      (info.totalMatches || 0).toLocaleString() + " match" +
      ((info.totalMatches || 0) === 1 ? "" : "es") +
      " · showing " + (info.shownMatches || 0).toLocaleString();
    updateRangeControls();
    rangeControlsEl.hidden = true;
    render();
    return;
  }
  if (msg.type === "largeSearchError") {
    if (msg.seq !== largeSearchSeq) return;
    backendSearchActive = false;
    statusEl.textContent = "Large file search: " + (msg.error || "failed");
    updateRangeControls();
    return;
  }
  if (msg.type === "largeSearchCleared") {
    if (msg.seq !== largeSearchSeq) return;
    backendSearchActive = false;
    model = normalModel;
    updateLargeStatus();
    updateRangeControls();
    render();
    return;
  }
  if (msg.type === "largeRangeError") {
    loadingRange = false;
    updateRangeControls();
    if (msg.error) statusEl.textContent = "Large file mode: " + msg.error;
    return;
  }
  if (msg.type === "load") {
    if (!msg.ok) {
      model = null;
      normalModel = null;
      largeMeta = null;
      treeEl.innerHTML = "";
      statusEl.innerHTML = "";
      const err = document.createElement("div");
      err.className = "error";
      err.textContent = "Invalid JSON — cannot inspect.\\n\\n" + msg.error;
      treeEl.appendChild(err);
      return;
    }
    idSeq = 0;
    largeMeta = msg.large || null;
    backendSearchActive = false;
    model = wrap(msg.tree, msg.name || "root", "$", 0);
    normalModel = model;
    model.expanded = true;
    statusEl.innerHTML = "";

    if (msg.large) {
      updateLargeStatus();
    } else if (msg.jsonl) {
      // Top level is a list of records; zero-padded indices already read 000…
      const n = model.children ? model.children.length : 0;
      const errCount = (msg.errors || []).length;
      statusEl.textContent =
        "JSONL · " + n + " record" + (n === 1 ? "" : "s") +
        (errCount ? " · " + errCount + " line(s) failed to parse" : "");
      if (errCount) {
        const warn = document.createElement("div");
        warn.className = "error";
        warn.textContent =
          "Skipped malformed lines:\\n" +
          msg.errors.map(function (e) { return "line " + e.line + ": " + e.message; }).join("\\n");
        statusEl.appendChild(warn);
      }
    } else {
      const t = model.type;
      const size = model.children ? model.children.length : 0;
      statusEl.textContent =
        "Root: " + t + (model.children ? " · " + size + " top-level entries" : "");
    }
    updateRangeControls();
    render();
  }
});

function replaceLargeChildren(children, start) {
  normalModel.children = [];
  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    const globalIndex = start + i;
    const key = normalModel.type === "array" ? String(globalIndex) : child.k;
    const childPath =
      normalModel.type === "array"
        ? "$[" + globalIndex + "]"
        : "$." + escapeKey(key);
    normalModel.children.push(wrap(child, key, childPath, 1));
  }
  normalModel.expanded = true;
}

function updateLargeStatus() {
  if (!largeMeta) return;
  const total = largeMeta.totalEntries || 0;
  const shown = largeMeta.shownEntries || 0;
  const start = largeMeta.pageStart || 0;
  const end = largeMeta.pageEnd || start + shown;
  const range = shown > 0
    ? start.toLocaleString() + "-" + Math.max(start, end - 1).toLocaleString()
    : "empty";
  statusEl.textContent =
    "Large file mode · " +
    formatClientBytes(largeMeta.fileSize || 0) +
    " · root " + largeMeta.rootType +
    " · " + total.toLocaleString() + " top-level " +
    (total === 1 ? "entry" : "entries") +
    " · entries " + range + " of " + total.toLocaleString();
}

function updateRangeControls() {
  if (!largeMeta || filterText.trim() || backendSearchActive) {
    rangeControlsEl.hidden = true;
    return;
  }
  const total = largeMeta.totalEntries || 0;
  const pageSize = largeMeta.pageSize || largeMeta.shownEntries || 1;
  const pageCount = largeMeta.pageCount || pageSize;
  rangeControlsEl.hidden = total <= 0;
  rangeStartEl.max = String(Math.max(0, total - 1));
  rangeCountEl.max = String(pageSize);
  if (!loadingRange) {
    rangeStartEl.value = String(largeMeta.pageStart || 0);
    rangeCountEl.value = String(pageCount);
  }
  prevPageBtn.disabled = loadingRange || !largeMeta.canPrevious;
  nextPageBtn.disabled = loadingRange || !largeMeta.canNext;
  goRangeBtn.disabled = loadingRange;
  rangeStartEl.disabled = loadingRange;
  rangeCountEl.disabled = loadingRange;
}

function showSourcePreview(msg) {
  const text = msg.text || "";
  const start = Math.max(0, Math.min(text.length, msg.highlightStart || 0));
  const end = Math.max(start, Math.min(text.length, msg.highlightEnd || start));
  lastSourceRange = String(msg.targetStart) + "-" + String(msg.targetEnd);
  sourceTitleEl.textContent =
    (msg.path || "source") +
    " · bytes " + lastSourceRange +
    " · window " + msg.windowStart + "-" + msg.windowEnd +
    (msg.targetTruncated ? " · target truncated" : "");
  sourceTextEl.textContent = "";
  sourceTextEl.appendChild(document.createTextNode(text.slice(0, start)));
  const hit = document.createElement("span");
  hit.className = "source-hit";
  hit.textContent = text.slice(start, end) || " ";
  sourceTextEl.appendChild(hit);
  sourceTextEl.appendChild(document.createTextNode(text.slice(end)));
  sourcePreviewEl.hidden = false;
  hit.scrollIntoView({ block: "center", inline: "nearest" });
}

function clampClientInt(value, min, max, fallback) {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(n, max));
}

function formatClientBytes(bytes) {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let n = Number(bytes) || 0;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return n.toFixed(i === 0 ? 0 : 1) + " " + units[i];
}

vscode.postMessage({ type: "ready" });
`;

function deactivate() {}

module.exports = {
  activate,
  deactivate,
  _test: {
    jsoncToJson,
    parseDocumentText,
    parseToTree,
    buildLargeFilePreview,
    buildLargeFilePage,
    searchLargeFile,
    readSourcePreview,
    scanLargeJsonTopLevel,
    shouldUseLargeFileMode,
  },
};
