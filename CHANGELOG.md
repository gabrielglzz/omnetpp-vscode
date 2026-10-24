# Changelog

## 0.9.0

Run, Qtenv and Debug now build the simulation when needed, for any OMNeT++ project with a `.oppbuildspec`, including projects that use other projects. Tried with INET 4.7 and Simu5G 1.8 on OMNeT++ 6.4.

### Building before running

- Run, Qtenv and Debug build the simulation first when it has not been built, or when a source file (`.cc`, `.h`, `.msg`, `.sm`) or build file changed since the last build. `omnetppIni.build.when` selects `changed` (the default), `missing` or `always`.
- The build is `make -j<CPUs − 1> MODE=release|debug` in the project folder if it has a Makefile, or else in each makemake folder of `.oppbuildspec`, generating its Makefile with `opp_makemake` and the options stored by the IDE.
- A project build script can be set in `omnetppIni.run.buildCommand` / `debug.buildCommand`; `${mode}` is replaced by `release` or `debug`, and `${jobs}` by the parallel jobs (`omnetppIni.build.jobs`).
- `omnetppIni.build.watch`: folders of other libraries the project depends on; a change in their sources or libraries also rebuilds it.
- Builds and simulations run in the environment of the OMNeT++ `setenv` script. On macOS this provides the GNU make 4 of Homebrew that the OMNeT++ makefiles need (the system make is 3.81).

### Running

- The program to run is read from `.oppbuildspec`: an executable, or a shared library such as INET, run with `opp_run -l` (`opp_run_dbg -l` when debugging). Before, INET ran `opp_run` without `-l`, and Debug looked for an executable that INET does not build.
- Projects that use other projects (the references of `.project`, such as Simu5G and INET): the projects they use are built first when they need it, watched for changes, added to the NED path, and passed to builds and simulations in `<NAME>_ROOT` (`INET_ROOT`…).
- The NED packages of `.nedexclusions` are excluded with `-x`.
- The project of an ini file is the nearest folder above it with a `.project` or `.oppbuildspec` file, so Run works on ini files outside the workspace and in workspaces with several projects.
- Long simulation commands run from a script. On macOS the terminal cut lines longer than 1024 bytes, which the NED path of a project that uses INET exceeds, and nothing ran.
- Debug asks which run to debug before building, and lets a run number be typed when the runs cannot be counted. It no longer asks before building.

### Diagnostics

Fixes found by running the extension on the ini files of INET 4.7:

- Strings and keys that go on after a `\` line continuation, and comments followed by `\`, are read as OMNeT++ reads them (no more *Unterminated string constant* in `xml("...")` values).
- NED parameters with properties such as `@enum("g(erp)")`, interfaces that extend other interfaces, types nested in `types:` sections, and types with the same name in different packages are resolved.
- Keys use the `network` of their section and of the sections it extends, not only the one of `[General]`.
- Fewer false *No parameter* warnings: when the module path cannot be resolved from the network, and for `**.name` keys, only names that no NED type declares are reported.
- Unknown configuration options are warnings, since simulation libraries can register their own options.
- Diagnostics are several times faster in large projects.

### Other

- The language is shown as *OMNeT++ ini (Run & Debug)*.
- Tests for the parser, the diagnostics, the completion and the projects (`test/run.js`), run in GitHub Actions.

## 0.8.0

First public release.

- `.ini` language with `#` comments and syntax highlighting.
- Completion, hover and go to definition of options, NED submodules, parameters and statistics, configs, variables and includes.
- Diagnostics: the errors OMNeT++ raises when loading an ini file, and keys that silently do nothing.
- Run, debug and Qtenv buttons for each configuration, with the iteration variables of each run; optional project and cluster scripts.
- Option documentation read at runtime from the user's OMNeT++ installation.
