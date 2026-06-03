# JSON Viewer

A VSCode extension that renders an open JSON file as an interactive,
expandable **variable-inspector tree** — the same way PyCharm's debugger lets
you drill into a `dict`.

![concept](https://img.shields.io/badge/style-pycharm--inspector-blue)

## How it fits in

Installing the extension **does not change how JSON opens** — files still open
in VSCode's normal text editor. The viewer is strictly opt-in: a
**“Open with JSON Viewer”** switch appears in the editor title bar (and the
Explorer right-click menu / Command Palette) for `.json`, `.jsonc`, `.jsonl`,
and `.ndjson` files. Click it and the viewer opens in a panel beside the
source; the text editor stays exactly as it was.

## Features

- **PyCharm-style inspector rows**: each row reads `key = {type} value`, with
  Python-flavored type labels (`{dict}` / `{list}` / `{str}` / `{int}` /
  `{float}` / `{bool}` / `{NoneType}`) and values shown as `'text'`,
  `True/False`, `None`, numbers. Containers show their child count, e.g.
  `{dict: 13}`, `{list: 12}`. List indices are zero-padded (`000`, `001`, …).
  A flat, expandable indented list — not a node graph.
- **Root matches the data shape**: a JSON file opens as a `dict` (object) at the
  root; a JSONL file opens as a `list` of `dict` records.
- **Byte-faithful values**: displayed and copied values come from the exact
  source text, never from a re-serialized `JSON.parse` result. Large integers
  (beyond 2⁵³), `-0`, trailing zeros (`100.00`), and exponent forms (`6.022e23`)
  are shown and copied exactly as written — no precision loss or reformatting.
  Copying a whole object/array yields its exact source substring.
- **JSONL / NDJSON support**: each line is parsed as its own record and shown as
  a **list of dicts** (like PyCharm's dict-list view). A malformed line is
  reported and skipped instead of blanking the whole panel.
- **Expand / collapse** each node; child counts shown on branches (`{12}`, `[4]`).
- **Auto-expand** the first N levels (configurable).
- **Filter** by key or value; matching rows highlight and their ancestors
  auto-expand.
- **Right-click menu** on any row:
  - **复制结构 / copy structure** — the shape as a type skeleton (leaf values
    replaced by `int`/`str`/…, arrays collapsed to one sample element).
  - **复制值 / copy value** — the raw value (full pretty JSON for containers).
  - **复制路径 / copy path** — e.g. `$.users[3].preferences.theme`.
  - **跳转 / jump** — select and scroll the source editor to that exact element
    (works for JSON and per-record in JSONL).
- **Live update**: edit the JSON in the editor and the viewer re-parses.
- **Invalid JSON** shows the parser error instead of a blank panel.
- Honors your VSCode theme colors (works in light, dark, high-contrast).

## Usage

1. Open this folder in VSCode.
2. Press **F5** to launch the Extension Development Host.
3. In the new window, open `sample-complex.json`.
4. Click the **tree icon** in the editor title bar, or run
   **“Open with JSON Viewer”** from the Command Palette, or
   right-click the file in the Explorer.

The viewer opens in a panel beside the source.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `jsonViewer.autoExpandDepth` | `2` | Levels to auto-expand on open. |
| `jsonViewer.liveUpdate` | `true` | Re-parse as the document changes. |

## Sample data

- `sample-complex.json` (~21 KB, ~1050 lines) — a deliberately complex document:
  deep nesting (a 15-level chain), mixed-type arrays, a numeric matrix, unicode /
  emoji / RTL strings, empty object/array/string edge cases, `null`s, large and
  exponential numbers, and a 12-element array of richly structured user records.
  Regenerate with `node generate-sample.js`.
- `sample-records.jsonl` — 6 valid records (one JSON object per line) plus a
  deliberately malformed final line to show per-line error tolerance.
  Regenerate with `node generate-sample-jsonl.js`.

## Project layout

- `extension.js` — extension host: command, webview lifecycle, live updates.
  The webview client (tree build / render / filter) is embedded as a string.
- `generate-sample.js` — deterministic generator for the sample document.
- `package.json` — manifest (command, menus, settings contributions).

## Packaging

```bash
npm i -g @vscode/vsce
vsce package        # produces json-viewer-0.1.0.vsix
```

## Compatibility: VSCode, Cursor, Antigravity

The extension uses only **stable `vscode` APIs** (commands, webview, workspace,
window) — no proprietary or proposed APIs — so the same `.vsix` runs unmodified
in VSCode and its forks (Cursor, Antigravity, VSCodium, …). `engines.vscode` is
kept low (`^1.74.0`) and an explicit `onCommand` activation event is declared so
older-API forks still resolve and activate it.

**Installing the same .vsix in a fork** (works for all of them):

- Cursor / Antigravity / VSCodium: Extensions panel → `…` → **Install from
  VSIX…**, or `cursor --install-extension json-viewer-0.1.0.vsix`
  (Antigravity exposes an equivalent CLI).

**Publishing to a marketplace** — note the forks do **not** use the Microsoft
Marketplace (its terms forbid non-MS products); they pull from **Open VSX**:

```bash
npm i -g ovsx
ovsx create-namespace prokids        # one-time, register your publisher id
ovsx publish json-viewer-0.1.0.vsix -p <OPEN_VSX_TOKEN>
```

After that the extension is installable by name inside Cursor and Antigravity.
For official VSCode you would additionally `vsce publish` to the MS Marketplace.
