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

![Open JSON Viewer: Tree Inspector and jump back to source](https://raw.githubusercontent.com/scottham/JSON-Viewer/main/media/json-viewer-demo.gif)

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
- Large local files use a streaming range mode to avoid VS Code's extension
  document-sync limit, with direct navigation to any top-level entry range.

## Settings

| Setting                       | Default | Description                                              |
| ----------------------------- | ------- | -------------------------------------------------------- |
| `jsonViewer.expandLevel`      | `0`     | JSON: expand to this level on open (`root = 0`).         |
| `jsonViewer.expandLevelJsonl` | `0`     | JSONL/NDJSON: expand to this level on open (`root = 0`). |
| `jsonViewer.liveUpdate`       | `true`  | Re-parse as the document changes.                        |
| `jsonViewer.largeFileThresholdMb` | `45` | Local `.json`, `.jsonl`, and `.ndjson` files at or above this size use large-file mode. Set `0` to force it for local supported files, or a negative value to disable it. |
| `jsonViewer.largeFilePreviewEntries` | `1000` | Large-file mode: maximum top-level entries per visible range. |
| `jsonViewer.largeFileMaxCopyMb` | `32` | Large-file mode: maximum single value copy size.          |
| `jsonViewer.largeFileSourcePreviewKb` | `64` | Large-file mode: source bytes to read around a value when jumping to source. |

Large-file mode is read-only, local-file only, and currently supports strict
`.json`, `.jsonl`, and `.ndjson` files. It streams the source file, counts
top-level entries, renders a bounded top-level range, lets you jump directly to
another range by index, searches top-level values by streaming the file, and
copies values from exact source byte ranges without loading the full file into
memory. Jump to source shows a focused source preview around the selected byte
range because VS Code cannot extension-sync very large files. When copying
structure from a partially loaded large root object, the output includes an
omitted-entry marker.

## Development

```bash
npm test
npx @vscode/vsce package
```

The generated `.vsix` can be installed locally or published to the VS Code
Marketplace and Open VSX.
