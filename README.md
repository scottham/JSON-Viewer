# JSON Viewer: Tree Inspector

Open a JSON file as an IDE debugger-style inspector tree, without changing VS
Code's normal text editor.

## Demo

Open any `.json`, `.jsonc`, `.jsonl`, or `.ndjson` file, then use one of:

- Click the **Open with JSON Viewer** tree icon in the editor title bar.
- Run **JSON Viewer: Tree Inspector: Open with JSON Viewer** from the Command Palette.
- Right-click the file in Explorer and choose **Open with JSON Viewer**.

The viewer opens beside the source file. The original editor stays exactly as it
was. Right-click any row in the tree to copy values, copy paths, copy structure,
or jump to the exact source location.

![Open JSON Viewer: Tree Inspector and jump back to source](media/json-viewer-demo.gif)

## Features

- IDE debugger-style rows: `key = {type} value`.
- Objects and arrays show child counts and can be expanded or collapsed.
- JSON opens with top-level branches collapsed by default.
- JSONL/NDJSON opens as a list of records; malformed lines are reported without
  hiding valid records.
- JSONC supports `//` comments, `/* ... */` comments, and trailing commas.
- Copy value uses the exact source text, so large integers, `-0`, `100.00`,
  exponent forms, spacing, and object/array formatting are preserved.
- Filter by key or value; matches auto-expand.
- Live update re-parses as the source document changes.

## Settings

| Setting                       | Default | Description                                              |
| ----------------------------- | ------- | -------------------------------------------------------- |
| `jsonViewer.expandLevel`      | `0`     | JSON: expand to this level on open (`root = 0`).         |
| `jsonViewer.expandLevelJsonl` | `0`     | JSONL/NDJSON: expand to this level on open (`root = 0`). |
| `jsonViewer.liveUpdate`       | `true`  | Re-parse as the document changes.                        |

## Development

```bash
npm test
npx @vscode/vsce package
```

The generated `.vsix` can be installed locally or published to the VS Code
Marketplace and Open VSX.
