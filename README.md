# OMNeT++ INI support for VS Code

VS Code extension for OMNeT++ `.ini` files. Plain JavaScript, no build step or dependencies.

- **Comments use `#`** (`Cmd+/` / `Ctrl+/`). VS Code's built-in `ini` language comments with `;`, which makes OMNeT++ 6 abort with *"Use hash mark instead of semicolon to start comments"*.
- **Syntax highlighting** for `[General]`/`[Config X]` sections, `include`, `extends` (config names), `network`, global and per-object options (`sim-time-limit`, `**.typename`, `**.result-recording-modes`…), key patterns (`**`, `*`, `[*]`, `[0..3]`), iteration variables (`${load=10..100 step 10}`, `${a}`, `${x=1,2 ! y}`, predefined `${configname}`…), numbers with units (`5s`, `1e-6s`, `8KiB`), strings, functions and `\` line continuations.
- **Completion**: configuration options (global ones only in `[General]`), per-object options after a `.`, `${` variables, config names after `extends =`, NED networks after `network =`, file paths after `include`, `true`/`false` for boolean options, recording modes.
- **Submodules and statistics** from the NED files. After a `.` in a key, the extension resolves the module path from the network of the ini file (`network =`, also for fragments, through the files that include them): `**` matches any depth, `SW[*]` the submodules called `SW` of the current modules, and submodules declared with `like` match every implementation of the interface (and the types derived from them), since `typename` can select any of them. It then offers, in this order:
  - the submodules (`**.net[*].` → `router[*]`; `**.router[*].` → `ppp[*]`, `queue`, `routing`),
  - the statistics (`@statistic`, `@statisticTemplate`) of the module (`**.app[0].` → `endToEndDelay`, `throughput`…; templates appear with the name used in ini keys, e.g. `flow*-throughput`),
  - the per-object options; after a statistic, the recording options (`result-recording-modes`, `vector-recording`…) come first.

  - the parameters of the module, with their type, unit, default value and `//` documentation. Parameters that NED sets without `default()` (in the module, a derived type, or the parent's submodule body, e.g. `host[..]: Host { numApps = 2; }`) cannot be changed from the ini: they are shown struck through, at the end.

  After `typename =`, the possible types are offered (the default one first, e.g. `"DropTailQueue"` for `**.router[*].queue.typename`). After a parameter, its default value (and `true`/`false` for booleans).

  In `result-recording-modes` values, the modes declared in the statistic's `record=` are offered as `+mode` (optional ones, off by default) and `-mode`, followed by every result recorder of OMNeT++ (`psquare`, `timeavg`, `stats`…). Hover and `F12` on a submodule or statistic in a key show its type or declaration.
- **Hover**: documentation of options and predefined variables, definitions of iteration variables, fallback chain of a config (per `omnetpp.ini` that loads the file), NED file of the network.
- **Go to definition / Find references** (`F12` / `Shift+F12`) for `include` files, configs (section headings and `extends`), `${variables}` and `network`.
- **Running configs**: above each `[General]` / `[Config X]` (except abstract ones) there are three CodeLens buttons:
  - `▶ Run (N runs)` runs it with `./run.sh` in a terminal; with several runs it asks which ones (all, one, or a range). `N` comes from `opp_run -q numruns` (computed for the visible sections, refreshed on save); if OMNeT++ rejects the config, the button shows a warning with the error.
  - `Debug` starts a debug session of one run (it asks which one) with the debug binary (`<repo>_dbg`, offering to build it with `./build.sh debug` if it is missing), the same arguments as `./run.sh` and `--debug-on-errors=true`, so the debugger stops where an OMNeT++ runtime error is raised. It needs the CodeLLDB (recommended on macOS) or Microsoft C/C++ extension; the extension offers to install CodeLLDB.
  - `Qtenv` runs run 0 with the Qtenv GUI (`./run.sh -Qt`).
  - `Cluster` launches it with `./submit.sh`: asks for `--array=0-<N-1>` (one job per run), `-r all` (one job) or other runs, whether to compile first (`-b`), and the cluster username the first time.

  In a fragment included by several ini files (e.g. `fragments/traffic.ini`), it asks which `omnetpp.ini` to run it with and remembers the choice. The commands *OMNeT++: Run Configuration…* and *OMNeT++: Run Configurations on Cluster…* (several configs at once, `cfg1,cfg2`) are also in the command palette, and *Run* in the editor title bar. Settings: `omnetppIni.omnetppRoot` (if `OMNET_ROOT` is not in VS Code's environment), `omnetppIni.run.script` / `run.extraArgs`, `omnetppIni.cluster.script` / `cluster.user` / `cluster.extraArgs`, `omnetppIni.debug.*` (debugger, program, user interface, extra arguments), `omnetppIni.codeLens.enable`.
- **Outline and folding** by section, with includes and iteration variables.
- **NED diagnostics** (warnings): a parameter that NED sets without `default()` (the ini value is ignored), and a parameter that does not exist in the modules the key matches (typos, keys left over from older versions…), unless its value defines an iteration variable (`**.rt = ${rt="FA"}`, a common idiom to name runs). The latter can be disabled with the `omnetppIni.diagnostics.unknownParameters` setting.
- **Diagnostics** reproducing the errors OMNeT++ raises when loading an ini file: `;` comments, indented lines (indentation means line continuation), invalid or duplicate section names, unknown or misplaced options (global options outside `[General]`, per-object options without `**.`), unknown per-object options, `No such config` in `extends`, cycles in the fallback chain, missing or circular includes. Undefined `${variables}` are reported as warnings.

The extension indexes every `.ini` and `.ned` file in the workspace (NED files are scanned for networks, parameters, submodules, `extends`/`like` and statistics; it is not a full NED parser, and when a path cannot be resolved from the network, submodules are looked up by name). Configs and variables are resolved through the include graph: a fragment such as `fragments/traffic.ini` sees the configs of every `omnetpp.ini` that includes it. Fragments that no file includes are not checked for `extends` and variables.

Option names and documentation come from `data/options.json`, generated from the OMNeT++ installation with `./gen-options.py` (`opp_run -h configdetails`, `-h configvars` and `-h resultrecorders`, currently OMNeT++ 6.4). Rerun it after upgrading OMNeT++.

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
