// Running configurations from the editor: CodeLens above each section and
// commands that launch the simulation (or a project script) in a terminal,
// a debug session, or a cluster script. The runs and their iteration variables come from
// `opp_run -q runs`.
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');
const vscode = require('vscode');

const CONFIG = 'omnetppIni';

function setting(key, fallback) {
  return vscode.workspace.getConfiguration(CONFIG).get(key, fallback);
}

// Single-quotes an argument for the shell when needed.
function quote(arg) {
  return /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${String(arg).replace(/'/g, `'\\''`)}'`;
}

function omnetppRoot() {
  return setting('omnetppRoot', '') || process.env.OMNET_ROOT || '';
}

// opp_run, or opp_run_dbg for debug builds, from the OMNeT++ installation.
function oppRun(debug = false) {
  const root = omnetppRoot();
  const name = debug ? 'opp_run_dbg' : 'opp_run';
  return root ? path.join(root, 'bin', name) : name;
}

class Runner {
  constructor(index, context) {
    this.index = index;
    this.context = context;
    this.numruns = new Map(); // `${root}|${config}` => Promise<{runs, labels} | {error}>
    this.lensEmitter = new vscode.EventEmitter();
  }

  // Called when ini files change: run counts may change.
  invalidate() {
    this.numruns.clear();
    this.lensEmitter.fire();
  }

  // ------------------------------------------------------------ queries

  // Runs of a config, as OMNeT++ computes them: {runs, names, labels}, where
  // names are the iteration variables that differ between runs and labels[i]
  // their values in run i (e.g. `load=50`), or {error}.
  countRuns(root, config) {
    const key = `${root}|${config}`;
    if (!this.numruns.has(key)) {
      this.numruns.set(key, new Promise((resolve) => {
        execFile(oppRun(), ['-s', '-c', config, '-q', 'runs', path.basename(root)],
          { cwd: path.dirname(root), timeout: 20000, maxBuffer: 64 * 1024 * 1024, env: this.env() }, (err, stdout, stderr) => {
            const out = `${stdout}\n${stderr}`;
            const error = /Error:\s*(.*)/.exec(out);
            const runs = parseRuns(stdout);
            if (error) resolve({ error: error[1].trim() });
            else if (err && err.code === 'ENOENT') resolve({ error: `${oppRun()} not found: set omnetppIni.omnetppRoot` });
            else if (!runs.length) resolve({ error: (err && err.message) || 'cannot get the runs' });
            else resolve({ runs: runs.length, ...varying(runs) });
          });
      }));
    }
    return this.numruns.get(key);
  }

  // Does `config` set abstract=true in the files loaded from `root`?
  isAbstract(root, config) {
    for (const f of this.index.descendants(root)) {
      const e = this.index.get(f);
      if (!e) continue;
      for (const en of e.doc.entries) {
        if (en.section === config && en.key === 'abstract' && en.value === 'true') return true;
      }
    }
    return false;
  }

  // Top-level ini file to run a config of `file` with; asks if there are several.
  async pickRoot(file) {
    const roots = this.index.roots(file).sort();
    if (roots.length <= 1) return roots[0];
    const key = `root:${file}`;
    const last = this.context.workspaceState.get(key);
    const items = roots.map((r) => ({ label: vscode.workspace.asRelativePath(r), root: r }));
    items.sort((a, b) => (b.root === last) - (a.root === last));
    const pick = await vscode.window.showQuickPick(items, {
      title: `${path.basename(file)} is included by several ini files`,
      placeHolder: 'Ini file to run it with',
    });
    if (pick) await this.context.workspaceState.update(key, pick.root);
    return pick && pick.root;
  }

  // ------------------------------------------------------------ execution

  env() {
    const root = omnetppRoot();
    return root ? { ...process.env, OMNET_ROOT: root } : process.env;
  }

  workspaceDir(file) {
    const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(file));
    return folder ? folder.uri.fsPath : path.dirname(file);
  }

  // What runs the simulation, in release or debug mode: {command, output},
  // `command` being the program and its first arguments and `output` the file
  // the build produces (null if there is nothing to build). It is the
  // omnetppIni.run.program / debug.program setting, or the target of the
  // project's .oppbuildspec (an executable, or a shared library loaded with
  // opp_run -l), or the executable opp_makemake builds in the workspace folder
  // (named after it), or opp_run. Debug builds have the _dbg suffix.
  target(root, debug = false) {
    const ws = this.workspaceDir(root);
    const p = setting(debug ? 'debug.program' : 'run.program', '');
    if (p) {
      const program = path.isAbsolute(p) ? p : path.join(ws, p);
      return { command: [program], output: program };
    }
    const d = debug ? '_dbg' : '';
    const exeSuffix = process.platform === 'win32' ? '.exe' : '';
    const target = buildSpecTarget(ws);
    if (target && target.library) {
      const lib = process.platform === 'win32' ? `${target.name}${d}.dll`
        : `lib${target.name}${d}${process.platform === 'darwin' ? '.dylib' : '.so'}`;
      return { command: [oppRun(debug), '-l', path.join(target.dir, target.name)], output: path.join(target.dir, lib) };
    }
    if (target) {
      const exe = path.join(target.dir, target.name + d + exeSuffix);
      return { command: [exe], output: exe };
    }
    const exe = path.join(ws, path.basename(ws) + d + exeSuffix);
    if (debug || fs.existsSync(exe) || fs.existsSync(path.join(ws, 'Makefile'))) return { command: [exe], output: exe };
    return { command: [oppRun()], output: null };
  }

  // Command that builds the simulation: the omnetppIni.run.buildCommand /
  // debug.buildCommand setting, or `make MODE=release|debug` in the workspace
  // folder if it has a Makefile, or else in each makemake folder of the
  // .oppbuildspec, creating its Makefile with opp_makemake if it is missing.
  // Null if there is no way to build it. `${mode}` in the setting is replaced
  // by release or debug, and `${jobs}` by the number of parallel jobs
  // (omnetppIni.build.jobs, or the number of CPUs minus one, which leaves one
  // for the editor).
  buildCommand(root, debug = false) {
    const jobs = setting('build.jobs', 0) || Math.max(os.cpus().length - 1, 1);
    const configured = setting(debug ? 'debug.buildCommand' : 'run.buildCommand', '');
    if (configured) return configured.replace(/\$\{mode\}/g, debug ? 'debug' : 'release').replace(/\$\{jobs\}/g, String(jobs));
    const ws = this.workspaceDir(root);
    const make = `make -j${jobs} MODE=${debug ? 'debug' : 'release'}`;
    if (fs.existsSync(path.join(ws, 'Makefile'))) return make;
    // Subfolders first: the folders above may link what they build
    const dirs = buildSpecDirs(ws).filter((d) => d.type === 'makemake').sort((a, b) => b.dir.length - a.dir.length);
    if (!dirs.length) return null;
    return dirs.map((d) => `(cd ${quote(d.dir)} && (test -f Makefile || opp_makemake ${makemakeArgs(d.options).map(quote).join(' ')}) && ${make})`).join(' && ');
  }

  // Does `target` need building? Per omnetppIni.build.when: when it is missing,
  // when it is missing or a file it is built from changed (the default), or
  // always. Changes count after the output was written and after the last
  // successful build: a build with nothing to do does not touch the output.
  needsBuild(root, target) {
    if (!target.output) return false;
    const when = setting('build.when', 'changed');
    if (when === 'always' || !fs.existsSync(target.output)) return true;
    if (when !== 'changed') return false;
    const since = Math.max(fs.statSync(target.output).mtimeMs, this.context.workspaceState.get(`built:${target.output}`, 0));
    return this.changedSince(root, since);
  }

  // Did a file the simulation is built from change after `since`? The sources
  // and build files of the folders of the .oppbuildspec (or of the workspace
  // folder), and the sources and libraries of the omnetppIni.build.watch
  // folders (libraries the project depends on).
  changedSince(root, since) {
    const ws = this.workspaceDir(root);
    if (newerFile(ws, since, SOURCES, false)) return true;
    const dirs = buildSpecDirs(ws);
    // A custom Makefile in the workspace folder: only its own files count
    const scan = dirs.length ? dirs.filter((d) => d.dir !== ws || d.type === 'makemake').map((d) => d.dir) : [ws];
    if (scan.some((d) => newerFile(d, since, SOURCES))) return true;
    return setting('build.watch', []).some((d) => newerFile(path.resolve(ws, d), since, WATCHED));
  }

  // Builds the simulation if it needs it; resolves to true when it can be run.
  async ensureBuilt(root, target, debug) {
    if (!this.needsBuild(root, target)) return true;
    const what = vscode.workspace.asRelativePath(target.output);
    const command = this.buildCommand(root, debug);
    if (!command) {
      if (fs.existsSync(target.output)) return true;
      vscode.window.showWarningMessage(`Simulation not built: ${what} (no Makefile or .oppbuildspec; set omnetppIni.${debug ? 'debug' : 'run'}.buildCommand)`);
      return false;
    }
    if (!(await this.build(root, command, debug ? 'Build (debug)' : 'Build'))) return false;
    if (!fs.existsSync(target.output)) {
      vscode.window.showErrorMessage(`The build did not produce ${what}`);
      return false;
    }
    // The end of the build, not its start: the files the build writes
    // (_m.cc files of .msg files, Makefiles…) are not changes
    await this.context.workspaceState.update(`built:${target.output}`, Date.now());
    return true;
  }

  // NED path for -n: the omnetppIni.nedPath setting, or the folders listed in
  // the project's .nedfolders file (OMNeT++ project convention), or the
  // workspace folder.
  nedPath(root) {
    const ws = this.workspaceDir(root);
    const configured = setting('nedPath', '');
    let dirs;
    if (configured) {
      dirs = configured.split(path.delimiter);
    } else {
      try {
        dirs = fs.readFileSync(path.join(ws, '.nedfolders'), 'utf8').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
      } catch {
        dirs = [];
      }
    }
    if (!dirs.length) dirs = ['.'];
    return dirs.map((d) => path.resolve(ws, d)).join(path.delimiter);
  }

  // NED packages excluded with -x: the ones listed in the project's
  // .nedexclusions file (OMNeT++ project convention), as [] or ['-x', list].
  nedExclusions(root) {
    let pkgs;
    try {
      pkgs = fs.readFileSync(path.join(this.workspaceDir(root), '.nedexclusions'), 'utf8').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
    } catch {
      pkgs = [];
    }
    return pkgs.length ? ['-x', pkgs.join(';')] : [];
  }

  // Environment for terminals and build tasks: OMNET_ROOT, and its bin folder
  // in the PATH (makefiles call opp_makemake, opp_featuretool…).
  shellEnv() {
    const root = omnetppRoot();
    return root ? { OMNET_ROOT: root, PATH: `${path.join(root, 'bin')}${path.delimiter}${process.env.PATH}` } : undefined;
  }

  // `command` run in the environment of the OMNeT++ installation, set up by
  // its setenv script: on macOS it also puts in the PATH the Homebrew tools
  // it needs, such as GNU make (the makefiles need make 4).
  withSetenv(command) {
    const setenv = omnetppRoot() && path.join(omnetppRoot(), 'setenv');
    if (!setenv || process.platform === 'win32' || !fs.existsSync(setenv)) return command;
    return `bash -c ${quote(`. ${quote(setenv)} -q && ${command}`)}`;
  }

  execute(name, cwd, args, setenv = false) {
    const terminal = vscode.window.createTerminal({ name, cwd, env: this.shellEnv() });
    terminal.show();
    const command = args.map(quote).join(' ');
    terminal.sendText(setenv ? this.withSetenv(`exec ${command}`) : command);
  }

  // Asks which runs to execute: [] for run 0 (the default), ['-r', x] otherwise.
  async pickRuns(root, config, forCluster = false) {
    const res = await this.countRuns(root, config);
    if (res.error) {
      const go = await vscode.window.showWarningMessage(`${config}: ${res.error}`, 'Run anyway');
      if (!go) return undefined;
    }
    const n = res.runs;
    if (!forCluster && n === 1) return [];
    const items = [];
    if (forCluster) {
      if (n > 1) items.push({ label: `$(server-process) All ${n} runs in parallel`, description: `--array=0-${n - 1}`, args: [`--array=0-${n - 1}`] });
      items.push({ label: `$(list-ordered) All runs in a single job`, description: '-r all', args: ['-r', 'all'] });
      items.push({ label: '$(play) Run 0', description: 'default', args: [] });
      items.push({ label: '$(edit) Other…', description: '--array=<runs> or -r <runs>', custom: true });
    } else {
      if (n > 1 || n === undefined) items.push({ label: `$(run-all) All ${n || ''} runs`.replace('  ', ' '), description: '-r all', args: ['-r', 'all'] });
      for (let i = 0; i < (n || 0); i++) items.push({ label: `Run ${i}`, description: res.labels[i], args: ['-r', String(i)] });
      if (!n) items.push({ label: 'Run 0', args: [] });
      items.push({ label: '$(edit) Range…', description: 'e.g. 3 or 0-9', custom: true });
    }
    const pick = await vscode.window.showQuickPick(items, {
      title: `${config}${n ? ` (${n} runs)` : ''}`, placeHolder: 'Runs to execute (type e.g. load=50 to filter)', matchOnDescription: true,
    });
    if (!pick) return undefined;
    if (!pick.custom) return pick.args;
    const value = await vscode.window.showInputBox({
      title: `${config}: runs`,
      prompt: forCluster ? '--array=0-9 (one job per run) or -r 0-9 (one job)' : 'Run number or range, e.g. 3 or 0-9',
      validateInput: (v) => (forCluster
        ? (/^(--array=\S+|-r\s+(\d+(-\d+)?|all))$/.test(v.trim()) ? null : 'Use --array=<runs> or -r <runs>')
        : (/^(\d+(-\d+)?|all)$/.test(v.trim()) ? null : 'A number, a range (0-9) or all')),
    });
    if (!value) return undefined;
    return forCluster ? value.trim().split(/\s+/) : ['-r', value.trim()];
  }

  async run(file, config, qtenv = false) {
    const root = await this.pickRoot(file);
    if (!root) return;
    const runs = qtenv ? [] : await this.pickRuns(root, config);
    if (runs === undefined) return;
    const name = `${qtenv ? 'Qtenv' : 'Run'}: ${config}`;
    const extra = splitArgs(setting('run.extraArgs', ''));
    const script = setting('run.script', '');
    if (script) {
      // Project script, run from the workspace folder: <script> [-r runs] [-Qt] <ini> <config>
      const args = [script, ...runs, ...(qtenv ? ['-Qt'] : []), ...extra, vscode.workspace.asRelativePath(root, false), config];
      this.execute(name, this.workspaceDir(root), args);
    } else {
      // The simulation itself, run from the ini file's folder, built first if
      // it is missing. Without -r, Cmdenv runs every run, so "run 0" ([] from
      // pickRuns) needs -r 0.
      const target = this.target(root);
      if (!(await this.ensureBuilt(root, target, false))) return;
      const r = runs.length === 0 ? ['-r', '0'] : runs[1] === 'all' ? [] : runs;
      const args = [...target.command, '-u', qtenv ? 'Qtenv' : 'Cmdenv', '-c', config, ...r,
        '-n', this.nedPath(root), ...this.nedExclusions(root), ...extra, path.basename(root)];
      this.execute(name, path.dirname(root), args, true);
    }
  }

  async runCluster(file, configs) {
    const script = setting('cluster.script', '');
    if (!script) {
      const open = await vscode.window.showWarningMessage(
        'No cluster script configured. Set omnetppIni.cluster.script to a script called as: <script> [options] <user> <ini> <config>[,<config>...]',
        'Open Settings');
      if (open) vscode.commands.executeCommand('workbench.action.openSettings', 'omnetppIni.cluster');
      return;
    }
    const root = await this.pickRoot(file);
    if (!root) return;
    const runs = await this.pickRuns(root, configs[0], true);
    if (runs === undefined) return;
    const build = await vscode.window.showQuickPick([
      { label: 'Do not compile', args: [] },
      { label: 'Compile in the cluster first', description: '-b (needed after changing the C++ code)', args: ['-b'] },
    ], { title: 'Cluster', placeHolder: 'Compile in the cluster first?' });
    if (!build) return;
    let user = setting('cluster.user', '');
    if (!user) {
      user = await vscode.window.showInputBox({ title: 'Cluster', prompt: 'Cluster username (saved in the omnetppIni.cluster.user setting)' });
      if (!user) return;
      await vscode.workspace.getConfiguration(CONFIG).update('cluster.user', user, vscode.ConfigurationTarget.Global);
    }
    const args = [script, ...build.args, ...runs,
      ...splitArgs(setting('cluster.extraArgs', '')), user, vscode.workspace.asRelativePath(root, false), configs.join(',')];
    this.execute(`Cluster: ${configs.join(',')}`, this.workspaceDir(root), args);
  }

  // ------------------------------------------------------------ debugging

  // Debugger extension to use: 'lldb' (CodeLLDB) or 'cppdbg' (Microsoft C/C++).
  async debuggerType() {
    const pref = setting('debug.debugger', 'auto');
    const has = (id) => Boolean(vscode.extensions.getExtension(id));
    if ((pref === 'auto' || pref === 'lldb') && has('vadimcn.vscode-lldb')) return 'lldb';
    if ((pref === 'auto' || pref === 'cppdbg') && has('ms-vscode.cpptools')) return 'cppdbg';
    const install = await vscode.window.showWarningMessage(
      'Debugging needs a C++ debugger extension: CodeLLDB or Microsoft C/C++.', 'Install CodeLLDB', 'Install C/C++');
    if (install) {
      const id = install === 'Install CodeLLDB' ? 'vadimcn.vscode-lldb' : 'ms-vscode.cpptools';
      await vscode.commands.executeCommand('workbench.extensions.installExtension', id);
      vscode.window.showInformationMessage(`Installing ${id}: launch the debug session again when it finishes.`);
    }
    return undefined;
  }

  // Runs a build command from the workspace folder as a task and resolves to
  // true if it succeeds.
  build(root, command, name) {
    const ws = this.workspaceDir(root);
    const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(root));
    const task = new vscode.Task({ type: 'shell', task: name }, folder || vscode.TaskScope.Workspace,
      name, 'OMNeT++', new vscode.ShellExecution(this.withSetenv(command), { cwd: ws, env: this.shellEnv() }));
    task.presentationOptions = { reveal: vscode.TaskRevealKind.Always, clear: true };
    return new Promise((resolve) => {
      const done = vscode.tasks.onDidEndTaskProcess((e) => {
        if (e.execution.task === task || e.execution.task.name === task.name) {
          done.dispose();
          resolve(e.exitCode === 0);
        }
      });
      vscode.tasks.executeTask(task).then(undefined, () => { done.dispose(); resolve(false); });
    });
  }

  async debug(file, config) {
    const root = await this.pickRoot(file);
    if (!root) return;
    const type = await this.debuggerType();
    if (!type) return;
    const target = this.target(root, true);
    if (!(await this.ensureBuilt(root, target, true))) return;
    const [program, ...programArgs] = target.command;
    // A single run: the debugger runs one process
    const res = await this.countRuns(root, config);
    let run = '0';
    if (res.runs > 1) {
      const items = [];
      for (let i = 0; i < res.runs; i++) items.push({ label: `Run ${i}`, description: res.labels[i], run: String(i) });
      const pick = await vscode.window.showQuickPick(items, {
        title: `Debug ${config} (${res.runs} runs)`, placeHolder: 'Run to debug (type e.g. load=50 to filter)', matchOnDescription: true,
      });
      if (!pick) return;
      run = pick.run;
    }
    const args = [...programArgs, '-r', run, '-m', '-u', setting('debug.userInterface', 'Cmdenv'), '-c', config, '-n', this.nedPath(root),
      ...this.nedExclusions(root), '--debug-on-errors=true', ...splitArgs(setting('debug.extraArgs', '')), path.basename(root)];
    const env = {};
    if (omnetppRoot()) {
      env.OMNET_ROOT = omnetppRoot();
      env.PATH = `${path.join(omnetppRoot(), 'bin')}:${process.env.PATH}`;
      env[process.platform === 'darwin' ? 'DYLD_LIBRARY_PATH' : 'LD_LIBRARY_PATH'] = path.join(omnetppRoot(), 'lib');
    }
    const name = `Debug ${config} #${run}`;
    const cwd = path.dirname(root);
    const configuration = type === 'lldb'
      ? { type, request: 'launch', name, program, args, cwd, env }
      : {
        type, request: 'launch', name, program, args, cwd, externalConsole: false,
        MIMode: process.platform === 'darwin' ? 'lldb' : 'gdb',
        environment: Object.entries(env).map(([n, value]) => ({ name: n, value })),
      };
    const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(root));
    await vscode.debug.startDebugging(folder, configuration);
  }

  // ------------------------------------------------------------ CodeLens

  provideCodeLenses(document) {
    if (!setting('codeLens.enable', true) || document.uri.scheme !== 'file') return [];
    const e = this.index.get(document.fileName);
    if (!e) return [];
    const roots = this.index.roots(document.fileName);
    const lenses = [];
    for (const s of e.doc.sections) {
      // Abstract in every ini file that loads this one: nothing to run
      if (roots.length && roots.every((r) => this.isAbstract(r, s.name))) continue;
      const range = new vscode.Range(s.line, 0, s.line, 0);
      const args = [document.fileName, s.name];
      const lens = new vscode.CodeLens(range);
      lens.data = { file: document.fileName, config: s.name, roots };
      lenses.push(lens);
      lenses.push(new vscode.CodeLens(range, { title: '$(debug) Debug', tooltip: 'Debug a run with the debug executable', command: 'omnetppIni.debug', arguments: args }));
      lenses.push(new vscode.CodeLens(range, { title: '$(debug-alt) Qtenv', tooltip: 'Run 0 with the Qtenv GUI', command: 'omnetppIni.runQtenv', arguments: args }));
      if (setting('cluster.script', '')) {
        lenses.push(new vscode.CodeLens(range, { title: '$(cloud-upload) Cluster', tooltip: `Launch on the cluster with ${setting('cluster.script', '')}`, command: 'omnetppIni.runCluster', arguments: args }));
      }
    }
    return lenses;
  }

  // The Run lens shows the number of runs, computed only for visible lenses.
  async resolveCodeLens(lens) {
    const { file, config, roots } = lens.data;
    const args = [file, config];
    let title = '$(play) Run';
    let tooltip = `Run with ${setting('run.script', '') || 'the simulation executable'}`;
    // For a fragment included by several ini files, use the one chosen last time
    const last = this.context.workspaceState.get(`root:${file}`);
    const root = roots.length === 1 ? roots[0] : roots.includes(last) ? last : null;
    if (root) {
      const res = await this.countRuns(root, config);
      if (res.error) {
        title = '$(warning) Run';
        tooltip = res.error;
      } else {
        title += ` (${res.runs} run${res.runs === 1 ? '' : 's'})`;
        if (res.names.length) tooltip += ` — varies ${res.names.join(', ')}`;
      }
      if (roots.length > 1) tooltip += ` with ${vscode.workspace.asRelativePath(root)} (one of the ${roots.length} ini files that include this one)`;
    } else if (roots.length > 1) {
      tooltip += ` (included by ${roots.length} ini files: you will be asked which one)`;
    }
    lens.command = { title, tooltip, command: 'omnetppIni.run', arguments: args };
    return lens;
  }

  get onDidChangeCodeLenses() {
    return this.lensEmitter.event;
  }

  // ------------------------------------------------------------ commands

  // Configs of the active ini file, for the command palette.
  async pickConfigs(many) {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.languageId !== 'omnetpp-ini') {
      vscode.window.showWarningMessage('Open an OMNeT++ ini file first');
      return undefined;
    }
    const file = editor.document.fileName;
    const e = this.index.get(file);
    const roots = this.index.roots(file);
    const line = editor.selection.active.line;
    const items = e.doc.sections
      .filter((s) => !(roots.length && roots.every((r) => this.isAbstract(r, s.name))))
      .map((s) => ({ label: s.name, picked: s.line <= line && line <= s.endLine }));
    const pick = await vscode.window.showQuickPick(items, { canPickMany: many, title: many ? 'Configs to launch' : 'Config to run' });
    if (!pick || (many && !pick.length)) return undefined;
    return { file, configs: many ? pick.map((p) => p.label) : [pick.label] };
  }

  register(context) {
    const sub = (d) => context.subscriptions.push(d);
    sub(vscode.languages.registerCodeLensProvider({ language: 'omnetpp-ini' }, this));
    sub(vscode.commands.registerCommand('omnetppIni.run', async (file, config) => {
      if (!file) {
        const p = await this.pickConfigs(false);
        if (!p) return;
        [file, config] = [p.file, p.configs[0]];
      }
      return this.run(file, config);
    }));
    sub(vscode.commands.registerCommand('omnetppIni.runQtenv', async (file, config) => {
      if (!file) {
        const p = await this.pickConfigs(false);
        if (!p) return;
        [file, config] = [p.file, p.configs[0]];
      }
      return this.run(file, config, true);
    }));
    sub(vscode.commands.registerCommand('omnetppIni.debug', async (file, config) => {
      if (!file) {
        const p = await this.pickConfigs(false);
        if (!p) return;
        [file, config] = [p.file, p.configs[0]];
      }
      return this.debug(file, config);
    }));
    sub(vscode.commands.registerCommand('omnetppIni.runCluster', async (file, config) => {
      let configs = config ? [config] : null;
      if (!file) {
        const p = await this.pickConfigs(true);
        if (!p) return;
        file = p.file;
        configs = p.configs;
      }
      return this.runCluster(file, configs);
    }));
    sub(vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration(CONFIG)) this.invalidate();
    }));
  }
}

// Parses `opp_run -q runs`: one {name: value} object per run.
function parseRuns(stdout) {
  const runs = [];
  for (const line of stdout.split(/\r?\n/)) {
    const m = /^Run (\d+):\s*(.*)$/.exec(line);
    if (!m) continue;
    const vars = {};
    // `$a=1, $b=f(1, 2), $c=3`: split only before the next `$name=`
    for (const part of m[2].split(/,\s*(?=\$\w+=)/)) {
      const v = /^\$(\w+)=(.*)$/.exec(part.trim());
      if (v) vars[v[1]] = v[2];
    }
    runs[parseInt(m[1], 10)] = vars;
  }
  return runs.filter(Boolean);
}

// Iteration variables whose value changes between runs: {names, labels},
// labels[i] being `name=value, ...` for run i.
function varying(runs) {
  const names = Object.keys(runs[0] || {}).filter((n) => runs.some((r) => r[n] !== runs[0][n]));
  return { names, labels: runs.map((r) => names.map((n) => `${n}=${r[n]}`).join(', ')) };
}

// Folders of the project's .oppbuildspec (written by the OMNeT++ IDE):
// [{dir, type, options}], type being 'makemake' (Makefile generated with
// opp_makemake and `options`) or 'custom' (hand-written Makefile).
function buildSpecDirs(ws) {
  let spec;
  try {
    spec = fs.readFileSync(path.join(ws, '.oppbuildspec'), 'utf8');
  } catch {
    return [];
  }
  return [...spec.matchAll(/<dir\b([^>]*)>/g)].map((m) => {
    const attr = (name) => (new RegExp(`\\b${name}="([^"]*)"`).exec(m[1]) || [])[1];
    return { dir: path.join(ws, attr('path') || '.'), type: attr('type'), options: splitArgs(attr('makemake-options') || '') };
  });
}

// Target of the first linked makemake folder of the .oppbuildspec:
// {dir, name, library}, or null. opp_makemake names it after its folder
// unless -o is given, and builds a shared library with --make-so (-s).
function buildSpecTarget(ws) {
  for (const { dir, type, options: opts } of buildSpecDirs(ws)) {
    if (type !== 'makemake' || opts.includes('--nolink') || opts.includes('-a') || opts.includes('--make-lib')) continue;
    const o = opts.findIndex((x) => x.startsWith('-o'));
    const name = o < 0 ? path.basename(dir) : opts[o] === '-o' ? opts[o + 1] : opts[o].slice(2);
    return { dir, name, library: opts.includes('--make-so') || opts.includes('-s') };
  }
  return null;
}

// Files the simulation is built from, and in the omnetppIni.build.watch
// folders also the libraries the project links.
const SOURCES = /\.(cc|cpp|cxx|c|h|hh|hpp|hxx|msg|sm)$|^(Makefile|makefrag|\.oppbuildspec|\.oppfeatures|\.oppfeaturestate)$/;
const WATCHED = new RegExp(`${SOURCES.source}|\\.(so|dylib|dll|a|lib)$`);

// Does `dir` (and its subfolders if `deep`) have a file matching `pattern`
// modified after `since`? Skips the build output (out) and hidden folders.
function newerFile(dir, since, pattern, deep = true) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const e of entries) {
    const f = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (deep && e.name !== 'out' && !e.name.startsWith('.') && newerFile(f, since, pattern)) return true;
    } else if (pattern.test(e.name)) {
      try {
        if (fs.statSync(f).mtimeMs > since) return true;
      } catch {
        // broken symbolic link
      }
    }
  }
  return false;
}

// opp_makemake arguments for the options of a makemake folder, as the IDE
// passes them: with -f, and without the --meta: options, which only the IDE
// understands.
function makemakeArgs(options) {
  const args = options.filter((o) => !o.startsWith('--meta:'));
  return args.includes('-f') || args.includes('--force') ? args : ['-f', ...args];
}

function splitArgs(s) {
  return s.trim() ? s.trim().split(/\s+/) : [];
}

module.exports = { Runner, quote, oppRun, omnetppRoot };
