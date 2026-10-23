# OMNeT++ INI support for VS Code

VS Code extension for OMNeT++ `.ini` files. Plain JavaScript, no build step or dependencies.

- **Comments use `#`** (`Cmd+/` / `Ctrl+/`). VS Code's built-in `ini` language comments with `;`, which makes OMNeT++ 6 abort with *"Use hash mark instead of semicolon to start comments"*.
- **Syntax highlighting** for `[General]`/`[Config X]` sections, `include`, `extends` (config names), `network`, global and per-object options (`sim-time-limit`, `**.typename`, `**.result-recording-modes`…), key patterns (`**`, `*`, `[*]`, `[0..3]`), iteration variables (`${load=10..100 step 10}`, `${a}`, `${x=1,2 ! y}`, predefined `${configname}`…), numbers with units (`5s`, `1e-6s`, `8KiB`), strings, functions and `\` line continuations.
- **Completion**: configuration options (global ones only in `[General]`), per-object options after a `.`, `${` variables, config names after `extends =`, NED networks after `network =`, file paths after `include`, `true`/`false` for boolean options, recording modes.
- **Hover**: documentation of options and predefined variables, definitions of iteration variables, fallback chain of a config (per `omnetpp.ini` that loads the file), NED file of the network.
- **Go to definition / Find references** (`F12` / `Shift+F12`) for `include` files, configs (section headings and `extends`), `${variables}` and `network`.
- **Outline and folding** by section, with includes and iteration variables.
- **Diagnostics** reproducing the errors OMNeT++ raises when loading an ini file: `;` comments, indented lines (indentation means line continuation), invalid or duplicate section names, unknown or misplaced options (global options outside `[General]`, per-object options without `**.`), unknown per-object options, `No such config` in `extends`, cycles in the fallback chain, missing or circular includes. Undefined `${variables}` are reported as warnings.

The extension indexes every `.ini` (and `.ned`, for network names) in the workspace. Configs and variables are resolved through the include graph: a fragment such as `fragments/traffic.ini` sees the configs of every `omnetpp.ini` that includes it. Fragments that no file includes are not checked for `extends` and variables.

Option names and documentation come from `data/options.json`, generated from the OMNeT++ installation with `./gen-options.py` (`opp_run -h configdetails` / `-h configvars`, currently OMNeT++ 6.4). Rerun it after upgrading OMNeT++.

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

The code in `src/` is split into pure modules (`parser.js`, `index.js`, `diagnostics.js`, `options.js`), which do not depend on VS Code, and `extension.js`, which registers the providers. The test scripts run with the Node bundled in VS Code (no `npm install` needed):

```bash
CODE="/Applications/Visual Studio Code.app/Contents/MacOS/Code"
# scopes assigned by the grammar to each token
ELECTRON_RUN_AS_NODE=1 "$CODE" test/tokenize.js test/sample.ini
# diagnostics for every ini file under a directory
ELECTRON_RUN_AS_NODE=1 "$CODE" test/diagnose.js ../..
```

After a change, run *Developer: Reload Window* in VS Code. *Developer: Inspect Editor Tokens and Scopes* shows the scopes under the cursor, and the extension host log (*Output* → *Extension Host*) shows runtime errors.
