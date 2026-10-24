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
- Tests for the parser, the diagnostics and the completion (`test/run.js`).

## 0.8.0

First public release.

- `.ini` language with `#` comments and syntax highlighting.
- Completion, hover and go to definition of options, NED submodules, parameters and statistics, configs, variables and includes.
- Diagnostics: the errors OMNeT++ raises when loading an ini file, and keys that silently do nothing.
- Run, debug and Qtenv buttons for each configuration, with the iteration variables of each run; optional project and cluster scripts.
- Option documentation read at runtime from the user's OMNeT++ installation.
