# OMNeT++ for VS Code

[![CI](https://github.com/gabrielglzz/omnetpp-vscode/actions/workflows/ci.yml/badge.svg)](https://github.com/gabrielglzz/omnetpp-vscode/actions/workflows/ci.yml)

Support for [OMNeT++](https://omnetpp.org) `.ini` files in Visual Studio Code: highlighting, completion driven by your NED files, the same errors OMNeT++ would report when loading the file, and buttons to run and debug each configuration. Plain JavaScript, no dependencies.

## Features

### Editing
- **`#` comments** with `Ctrl+/` / `Cmd+/`. VS Code's built-in `ini` language comments with `;`, which makes OMNeT++ 6 abort with *"Use hash mark instead of semicolon to start comments"*.
- **Syntax highlighting**: `[General]` / `[Config X]` sections, `include`, `extends`, global and per-object options, key patterns (`**`, `*`, `[*]`, `[0..3]`), iteration variables (`${load=10..100 step 10}`, `${x=1,2 ! y}`, `${configname}`…), numbers with units, strings, functions and `\` line continuations.
- **Outline and folding** by section.

### Completion
- **Configuration options** (global ones only in `[General]`) with their documentation.
- **Module paths from your NED files.** After a `.` in a key, the path is resolved from the `network` of the ini file: `**` matches any depth, `host[*]` the submodules called `host` of the current modules, and submodules declared with `like` match every implementation of the interface (any of them can be chosen with `typename`). It offers:
  1. the **submodules** of the module,
  2. its **parameters**, with type, unit, default value and `//` documentation. Parameters that NED assigns without `default()` cannot be changed from the ini, so they are shown struck through,
  3. its **statistics** (`@statistic`, `@statisticTemplate`) and then the recording options (`result-recording-modes`, `vector-recording`…),
  4. the per-object options.
- **Values**: the possible types after `typename =` (the default one first), a parameter's default value, `true`/`false`, the recording modes of a statistic (`+histogram` for the optional ones, `-mean`…) and every result recorder of your OMNeT++ (`psquare`, `timeavg`…).
- `${` variables, configs after `extends =`, networks after `network =`, file paths after `include`.

### Navigation
- **Hover** and **Go to Definition** (`F12`) for options, parameters, statistics, submodules, networks, `include` files, configs (with their fallback chain) and `${variables}`.
- **Find References** (`Shift+F12`) for configs and variables.

### Diagnostics
- **Errors** for the checks OMNeT++ makes when it loads an ini file: `;` comments, indented lines (indentation means line continuation), invalid or duplicate sections, misplaced options, `No such config` in `extends`, cycles in the fallback chain, missing or circular includes.
- **Warnings** for keys that silently do nothing: parameters that NED sets without `default()`, and keys that match no parameter of the modules they address (typos, leftovers…). Keys that just define an iteration variable (`**.label = ${label="A"}`) are not reported. The second check can be disabled with `omnetppIni.diagnostics.unknownParameters`.
- Warnings for unknown options. They are not errors because simulation libraries can register their own options from C++ (INET's `unshare-namespaces`…), which `opp_run` does not list.
- Undefined `${variables}`.

Ini fragments included from several files are analysed through the files that include them: a fragment sees the configs, variables and network of every `omnetpp.ini` that includes it.

### Running and debugging
Above each runnable section:
- **▶ Run (N runs)** runs it in a terminal. With several runs it asks which ones, showing the iteration variables that change between runs (`Run 4  load=50`; type `load=50` to filter). The runs come from `opp_run -q runs`; if OMNeT++ rejects the config, the button shows the error.
- **Debug** starts a debug session of one run with the debug executable (`<project>_dbg`, built with `make MODE=debug` if it is missing) and `--debug-on-errors=true`, so the debugger stops where an OMNeT++ runtime error is raised. It needs the [CodeLLDB](https://marketplace.visualstudio.com/items?itemName=vadimcn.vscode-lldb) or [C/C++](https://marketplace.visualstudio.com/items?itemName=ms-vscode.cpptools) extension.
- **Qtenv** runs it with the Qtenv GUI.
- **Cluster**, if a cluster script is configured (see below).

By default the simulation executable built by `opp_makemake` (named after the project folder) is run from the ini file's folder, with the NED path from the project's `.nedfolders` file. The same actions are in the command palette (*OMNeT++: Run Configuration…*).

## Requirements

- VS Code 1.80 or later.
- An OMNeT++ installation (6.x recommended) for the option documentation, run counts, running and debugging. Without it, highlighting, NED-based completion, navigation and diagnostics still work, with a built-in list of option names. The extension uses the `opp_run` of `omnetppIni.omnetppRoot`, of `$OMNET_ROOT`, or in the `PATH`.

## Installation

Download the `.vsix` from the [releases](https://github.com/gabrielglzz/omnetpp-vscode/releases) and install it:

```bash
code --install-extension omnetpp-vscode-<version>.vsix
```

or use *Extensions: Install from VSIX…* in VS Code. To work on the extension, link the repository instead and reload VS Code:

```bash
ln -s "$PWD" ~/.vscode/extensions/gabrielglzz.omnetpp-vscode
```

`omnetpp.ini` files always open as *OMNeT++ ini (Run & Debug)*. If other `.ini` files open with the built-in *Ini* language (see the status bar), add this to your settings:

```json
"files.associations": { "*.ini": "omnetpp-ini" }
```

## Settings

| Setting | Default | Description |
|---|---|---|
| `omnetppIni.omnetppRoot` | `$OMNET_ROOT` | OMNeT++ installation |
| `omnetppIni.run.program` | `.oppbuildspec`, `<project>` or `opp_run` | Simulation executable |
| `omnetppIni.run.buildCommand` | `.oppbuildspec` | Builds the simulation (`${mode}`: `release`) |
| `omnetppIni.build.when` | `changed` | Build before launching: `changed`, `missing` or `always` |
| `omnetppIni.build.jobs` | CPUs − 1 | Parallel jobs (`make -j`, `${jobs}` in the build commands) |
| `omnetppIni.build.watch` | | Folders of libraries the project depends on |
| `omnetppIni.nedPath` | `.nedfolders` | NED path passed with `-n` |
| `omnetppIni.run.extraArgs` | | Extra arguments for the simulation |
| `omnetppIni.run.script` | | Project script to run configs instead of the executable |
| `omnetppIni.debug.program` | `.oppbuildspec` or `<project>_dbg` | Debug executable |
| `omnetppIni.debug.buildCommand` | `.oppbuildspec` | Builds the debug executable (`${mode}`: `debug`) |
| `omnetppIni.debug.debugger` | `auto` | `lldb` (CodeLLDB) or `cppdbg` (C/C++) |
| `omnetppIni.debug.userInterface` | `Cmdenv` | `Cmdenv` or `Qtenv` |
| `omnetppIni.debug.extraArgs` | | Extra arguments in debug sessions |
| `omnetppIni.cluster.script` | | Script that launches configs on a cluster; enables the Cluster button |
| `omnetppIni.cluster.user`, `cluster.extraArgs` | | Cluster username and extra options |
| `omnetppIni.codeLens.enable` | `true` | Show the Run / Debug / Qtenv buttons |
| `omnetppIni.diagnostics.unknownParameters` | `true` | Warn about keys that match no parameter |

### Building

Run, Qtenv and Debug build the simulation first when it has not been built, or when a file it is built from changed since the last build (`omnetppIni.build.when`): the C++ sources, headers, `.msg` and `.sm` files and build files of the project, and the sources and libraries of the `omnetppIni.build.watch` folders. What to build comes from the `.oppbuildspec` the OMNeT++ IDE writes: its first makemake folder that links gives the target, an executable or a shared library (`--make-so`, run with `opp_run -l`), and the build is `make -j<CPUs − 1> MODE=release` (or `MODE=debug`) in the project folder if it has a Makefile, or else in each makemake folder, generating its Makefile with `opp_makemake` and the folder's options if it is missing. The `--meta:` options are only understood by the IDE: projects that use other projects (`--meta:use-exported-libs`) need a Makefile of their own or `omnetppIni.run.buildCommand`.

The projects a project uses (the *Project References* of its `.project`, such as INET for Simu5G) are looked up by name or folder name among the workspace folders and the folders next to them. They are built first when they need it (with their Makefile or `.oppbuildspec`), a change in their sources or libraries rebuilds the project, their `.nedfolders` and `.nedexclusions` are added to `-n` and `-x`, and the folder of each project is passed to builds and simulations in `<NAME>_ROOT` (`INET_ROOT`, `SIMU5G_ROOT`…), as their makefiles and scripts expect. Without `.oppbuildspec`, the executable is the one `opp_makemake` builds in the project folder. Builds and simulations run in the environment set up by the `setenv` script of `omnetppIni.omnetppRoot`.

### Project scripts

Projects that launch simulations with their own scripts can configure them in the workspace's `.vscode/settings.json`. The run script is called from the workspace folder as `<script> [-r <runs>] [-Qt] <ini> <config>`, and the cluster script as `<script> [-b] [--array=<runs> | -r <runs>] <user> <ini> <config>[,<config>...]`. For example:

```json
{
  "omnetppIni.run.script": "./run.sh",
  "omnetppIni.cluster.script": "./submit.sh",
  "omnetppIni.run.buildCommand": "./build.sh ${mode} -j${jobs}",
  "omnetppIni.debug.buildCommand": "./build.sh ${mode} -j${jobs}",
  "omnetppIni.build.watch": ["../inet/src", "../mylib"]
}
```

## Limitations

- NED files are scanned, not fully parsed: types, parameters, submodules, `extends` / `like` and statistics are read with a lightweight parser. When a module path cannot be resolved from the network, submodules are looked up by name, and diagnostics only report the parameters that no NED type declares.
- Built-in NED types of OMNeT++ (`ned.DatarateChannel`…) are not indexed.
- `typename` keys of the ini file are not used to resolve paths: after a submodule declared with `like`, completion offers the parameters of every implementation of the interface.
- Modules created from C++ at run time are not known. A key that ends in `**.name` is therefore only reported when no NED type declares `name`.

## Development

`src/parser.js`, `index.js`, `ned.js`, `diagnostics.js`, `options.js` and `project.js` do not depend on VS Code; `extension.js` and `run.js` register the providers. There is no build step: reload VS Code (*Developer: Reload Window*) after a change. The test scripts run with the Node bundled in VS Code:

```bash
CODE="/Applications/Visual Studio Code.app/Contents/MacOS/Code"   # or `code` on Linux
ELECTRON_RUN_AS_NODE=1 "$CODE" test/run.js                       # tests: parser, diagnostics, completion, projects
ELECTRON_RUN_AS_NODE=1 "$CODE" test/tokenize.js test/sample.ini   # grammar scopes of each token
ELECTRON_RUN_AS_NODE=1 "$CODE" test/diagnose.js <project dir>     # diagnostics of every ini file
python3 package.py                                               # build the .vsix
```

The tests activate the extension on `test/fixtures/project` with a stub of the `vscode` module. The expected diagnostics are written in its ini files as `# expect warning: <part of the message>` comments on their line.

## License and disclaimer

[MIT](LICENSE). This extension is an independent project, not affiliated with or endorsed by OpenSim Ltd. or the OMNeT++ project. It contains no part of OMNeT++: the option documentation shown in VS Code is read at runtime from your own OMNeT++ installation, which is subject to its own license.
