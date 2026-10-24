# Changelog

## Unreleased

Fixes found by running the extension on the ini files of INET 4.7:

- Strings and keys that go on after a `\` line continuation, and comments followed by `\`, are read as OMNeT++ reads them (no more *Unterminated string constant* in `xml("...")` values).
- NED parameters with properties such as `@enum("g(erp)")`, interfaces that extend other interfaces, types nested in `types:` sections, and types with the same name in different packages are resolved.
- Keys use the `network` of their section and of the sections it extends, not only the one of `[General]`.
- Fewer false *No parameter* warnings: when the module path cannot be resolved from the network, and for `**.name` keys, only names that no NED type declares are reported.
- Unknown configuration options are warnings, since simulation libraries can register their own options.
- The language is shown as *OMNeT++ ini (Run & Debug)*.
- Diagnostics are several times faster in large projects.
- Run, Qtenv and Debug build the simulation first when it has not been built or its sources changed (`omnetppIni.build.when`, and `omnetppIni.build.watch` for the libraries it depends on); `${mode}` in the build commands is `release` or `debug`, and `${jobs}` the parallel jobs (`omnetppIni.build.jobs`, the number of CPUs minus one by default, also passed to make with `-j`). Builds: with `make MODE=release|debug`, or with the makemake folders of `.oppbuildspec` (generating their Makefiles if needed), or with `omnetppIni.run.buildCommand` / `debug.buildCommand`.
- The executable or shared library to run is read from `.oppbuildspec`; libraries, such as INET, run with `opp_run -l` (`opp_run_dbg -l` when debugging). The NED packages of `.nedexclusions` are excluded with `-x`.
- Builds and simulations run in the environment of the OMNeT++ `setenv` script (on macOS it provides the GNU make 4 of Homebrew that the makefiles need); terminals and build tasks also get its `bin` folder in the `PATH`.
- Tests for the parser, the diagnostics and the completion (`test/run.js`).

## 0.8.0

First public release.

- `.ini` language with `#` comments and syntax highlighting.
- Completion, hover and go to definition of options, NED submodules, parameters and statistics, configs, variables and includes.
- Diagnostics: the errors OMNeT++ raises when loading an ini file, and keys that silently do nothing.
- Run, debug and Qtenv buttons for each configuration, with the iteration variables of each run; optional project and cluster scripts.
- Option documentation read at runtime from the user's OMNeT++ installation.
