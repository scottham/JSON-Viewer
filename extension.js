const vscode = require("vscode");
const path = require("path");

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
        document = await vscode.workspace.openTextDocument(uri);
      } else if (vscode.window.activeTextEditor) {
        document = vscode.window.activeTextEditor.document;
      }

      if (!document) {
        vscode.window.showErrorMessage(
          "Json Viewer: Inspector Tree: open a JSON file first, then run the command."
        );
        return;
      }

      openViewer(context, document);
    }
  );

  context.subscriptions.push(openCommand);
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
    `Json Viewer: Inspector Tree: ${path.basename(document.fileName)}`,
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
          `Json Viewer: Inspector Tree: copied ${msg.label}`,
          2000
        );
      } else if (msg.type === "copyRaw" && typeof msg.path === "string") {
        // Copy value: slice the exact source substring from the latest parse.
        if (document.getText() !== parsedText) post();
        const entry = offsetMap.get(msg.path);
        if (entry) {
          vscode.env.clipboard.writeText(parsedText.slice(entry.val, entry.end));
          vscode.window.setStatusBarMessage(
            "Json Viewer: Inspector Tree: copied value",
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
    <button id="expandAll" title="Expand all">Expand all</button>
    <button id="collapseAll" title="Collapse all">Collapse all</button>
  </div>
  <div id="status" class="muted"></div>
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
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  background: var(--vscode-sideBar-background, var(--vscode-editor-background));
  border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.3));
}
#toolbar .spacer { flex: 1; }
#search {
  flex: 0 1 320px;
  padding: 3px 8px;
  color: var(--vscode-input-foreground);
  background: var(--vscode-input-background);
  border: 1px solid var(--vscode-input-border, transparent);
  border-radius: 3px;
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

let model = null;       // root node
let filterText = "";

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
    node.children = n.c.map((ch, i) =>
      wrap(ch, String(i).padStart(pad, "0"), path + "[" + i + "]", depth + 1)
    );
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
  const q = filterText.trim().toLowerCase();
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

let searchTimer;
searchEl.addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    filterText = searchEl.value;
    render();
  }, 120);
});

window.addEventListener("message", (event) => {
  const msg = event.data;
  if (msg.type === "load") {
    if (!msg.ok) {
      model = null;
      treeEl.innerHTML = "";
      statusEl.innerHTML = "";
      const err = document.createElement("div");
      err.className = "error";
      err.textContent = "Invalid JSON — cannot inspect.\\n\\n" + msg.error;
      treeEl.appendChild(err);
      return;
    }
    idSeq = 0;
    model = wrap(msg.tree, msg.name || "root", "$", 0);
    model.expanded = true;
    statusEl.innerHTML = "";

    if (msg.jsonl) {
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
    render();
  }
});

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
  },
};
