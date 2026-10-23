# OMNeT++ INI support for VS Code

Declarative VS Code extension for OMNeT++ `.ini` files:

- **Comments use `#`** (`Cmd+/` / `Ctrl+/`). VS Code's built-in `ini` language comments with `;`, which makes OMNeT++ 6 abort with *"Use hash mark instead of semicolon to start comments"*. Lines starting with `;` are highlighted as errors.
- **Syntax highlighting** for `[General]`/`[Config X]` sections, `include`, `extends` (config names), `network`, global and per-object options (`sim-time-limit`, `**.typename`, `**.result-recording-modes`…), key patterns (`**`, `*`, `[*]`, `[0..3]`), iteration variables (`${load=10..100 step 10}`, `${a}`, `${x=1,2 ! y}`, predefined `${configname}`…), numbers with units (`5s`, `1e-6s`, `8KiB`), strings, functions and `\` line continuations.

Option names come from `opp_run -h config` / `opp_run -h configvars` (OMNeT++ 6.4).

## Installation

From the repository root, link the extension into your VS Code extensions directory and restart VS Code:

```bash
ln -s "$PWD" ~/.vscode/extensions/omnetpp-vscode
```

(Copy the directory instead of linking it if you do not want it to follow your checkout.) Remove the link to uninstall.

### Associating `.ini` files

`omnetpp.ini` files are always opened as *OMNeT++ INI*. The extension also claims the `.ini` extension, but VS Code's built-in `ini` language may win for other files (the status bar shows *Ini* instead of *OMNeT++ INI*). In that case add this to your user or workspace `settings.json`:

```json
"files.associations": {
    "*.ini": "omnetpp-ini"
}
```

Note that associating `*.ini` with `properties` does **not** fix the comment character: the built-in `ini` and `properties` languages share the same grammar, and VS Code takes the comment character from the `ini` language.

## Development

`test/tokenize.js` prints the scopes assigned to each token, using the TextMate engine bundled with VS Code (no `npm install` needed):

```bash
ELECTRON_RUN_AS_NODE=1 "/Applications/Visual Studio Code.app/Contents/MacOS/Code" test/tokenize.js test/sample.ini
```

After editing the grammar, run *Developer: Reload Window* in VS Code to see the changes, and *Developer: Inspect Editor Tokens and Scopes* to check the scopes under the cursor.
