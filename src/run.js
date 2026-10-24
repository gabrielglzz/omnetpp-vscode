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
const project = require('./project');

const { quote } = project;

const CONFIG = 'omnetppIni';

function setting(key, fallback) {
  return vscode.workspace.getConfiguration(CONFIG).get(key, fallback);
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

  // Workspace folder of a file, which the paths in the settings are relative
  // to, or its folder if it is outside the workspace.
  workspaceDir(file) {
    const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(file));
    return folder ? folder.uri.fsPath : path.dirname(file);
  }

  // Folder of the OMNeT++ project of a file: the nearest folder above it with
  // a .project or .oppbuildspec file, as the IDE sees projects, or else its
  // workspace folder. A workspace folder may hold several projects (samples/),
  // and a file may be outside the workspace.
  projectDir(file) {
    for (let d = path.dirname(file); ; d = path.dirname(d)) {
      if (fs.existsSync(path.join(d, '.oppbuildspec')) || fs.existsSync(path.join(d, '.project'))) return d;
      if (path.dirname(d) === d) return this.workspaceDir(file);
    }
  }

  // Folders that may hold the projects a project uses: the workspace folders
  // and the folders next to them and to the project, as in an IDE workspace.
  projectCandidates(ws) {
    const folders = (vscode.workspace.workspaceFolders || []).map((f) => f.uri.fsPath);
    const dirs = [...folders];
    for (const parent of new Set([ws, ...folders].map((d) => path.dirname(d)))) {
      try {
        for (const e of fs.readdirSync(parent, { withFileTypes: true })) if (e.isDirectory()) dirs.push(path.join(parent, e.name));
      } catch {
        // unreadable folder
      }
    }
    return dirs;
  }

  // Folders of the projects the project of `root` uses (its .project), each
  // before the projects that use it.
  references(root) {
    const dir = this.projectDir(root);
    return project.references(dir, this.projectCandidates(dir));
  }

  // What runs the simulation, in release or debug mode: {command, output}
  // (see project.target), or the omnetppIni.run.program / debug.program
  // setting.
  target(root, debug = false) {
    const p = setting(debug ? 'debug.program' : 'run.program', '');
    if (p) {
      const program = path.isAbsolute(p) ? p : path.join(this.workspaceDir(root), p);
      return { command: [program], output: program };
    }
    return project.target(this.projectDir(root), debug, oppRun(debug));
  }

  // Parallel jobs of the build: omnetppIni.build.jobs, or the number of CPUs
  // minus one, which leaves one for the editor.
  jobs() {
    return setting('build.jobs', 0) || Math.max(os.cpus().length - 1, 1);
  }

  // Command that builds the project of `root`, as {dir, command}, `dir` being
  // the folder to run it from: the omnetppIni.run.buildCommand /
  // debug.buildCommand setting, run from the workspace folder, with `${mode}`
  // replaced by release or debug and `${jobs}` by the parallel jobs, or make
  // or the .oppbuildspec, run from the project folder (see
  // project.buildCommand). Null if there is no way to build it.
  buildCommand(root, debug = false) {
    const configured = setting(debug ? 'debug.buildCommand' : 'run.buildCommand', '');
    if (configured) {
      const command = configured.replace(/\$\{mode\}/g, debug ? 'debug' : 'release').replace(/\$\{jobs\}/g, String(this.jobs()));
      return { dir: this.workspaceDir(root), command };
    }
    const dir = this.projectDir(root);
    const command = project.buildCommand(dir, debug, this.jobs());
    return command && { dir, command };
  }

  // Does `target` of the project in `dir` need building? Per
  // omnetppIni.build.when: when it is missing, when it is missing or a file it
  // is built from changed (the default), or always. In the `linked` folders
  // (projects it uses, omnetppIni.build.watch), libraries count too. Changes
  // count after the output was written and after the last successful build: a
  // build with nothing to do does not touch the output.
  needsBuild(dir, target, linked = []) {
    if (!target.output) return false;
    const when = setting('build.when', 'changed');
    if (when === 'always' || !fs.existsSync(target.output)) return true;
    if (when !== 'changed') return false;
    const since = Math.max(fs.statSync(target.output).mtimeMs, this.context.workspaceState.get(`built:${target.output}`, 0));
    return project.changedSince(dir, since) || linked.some((d) => project.changedSince(d, since, project.LINKED));
  }

  // Builds the simulation if it needs it, after the projects it uses (with
  // their make or .oppbuildspec), in a single task; resolves to true when it
  // can be run.
  async ensureBuilt(root, target, debug) {
    const dir = this.projectDir(root);
    const refs = this.references(root);
    const steps = [];
    for (const ref of refs) {
      const t = project.target(ref, debug, oppRun(debug));
      const command = this.needsBuild(ref, t) && project.buildCommand(ref, debug, this.jobs());
      if (command) steps.push({ dir: ref, command, output: t.output });
    }
    const linked = [...refs, ...setting('build.watch', []).map((d) => path.resolve(this.workspaceDir(root), d))];
    if (steps.length || this.needsBuild(dir, target, linked)) {
      const build = this.buildCommand(root, debug);
      if (build) {
        steps.push({ ...build, output: target.output });
      } else if (target.output && !fs.existsSync(target.output)) {
        vscode.window.showWarningMessage(`Simulation not built: ${vscode.workspace.asRelativePath(target.output)} (no Makefile or .oppbuildspec; set omnetppIni.${debug ? 'debug' : 'run'}.buildCommand)`);
        return false;
      }
    }
    if (!steps.length) return true;
    const command = steps.map((s) => `(cd ${quote(s.dir)} && ${s.command})`).join(' && ');
    if (!(await this.build(root, command, debug ? 'Build (debug)' : 'Build'))) return false;
    for (const s of steps) {
      if (!s.output) continue;
      if (!fs.existsSync(s.output)) {
        vscode.window.showErrorMessage(`The build did not produce ${vscode.workspace.asRelativePath(s.output)}`);
        return false;
      }
      // The end of the build, not its start: the files the build writes
      // (_m.cc files of .msg files, Makefiles…) are not changes
      await this.context.workspaceState.update(`built:${s.output}`, Date.now());
    }
    return true;
  }

  // NED path for -n: the omnetppIni.nedPath setting, or the folders listed in
  // the .nedfolders files (OMNeT++ project convention) of the project and of
  // the projects it uses, or their folders.
  nedPath(root) {
    const configured = setting('nedPath', '');
    if (configured) return configured.split(path.delimiter).map((d) => path.resolve(this.workspaceDir(root), d)).join(path.delimiter);
    const folders = (dir) => {
      const listed = project.readList(dir, '.nedfolders');
      return (listed.length ? listed : ['.']).map((d) => path.resolve(dir, d));
    };
    return [this.projectDir(root), ...this.references(root)].flatMap(folders).join(path.delimiter);
  }

  // NED packages excluded with -x: the ones listed in the .nedexclusions files
  // of the project and of the projects it uses, as [] or ['-x', list].
  nedExclusions(root) {
    const pkgs = [this.projectDir(root), ...this.references(root)].flatMap((d) => project.readList(d, '.nedexclusions'));
    return pkgs.length ? ['-x', pkgs.join(';')] : [];
  }

  // Environment for terminals, build tasks and debug sessions: OMNET_ROOT and
  // its bin folder in the PATH (makefiles call opp_makemake, opp_featuretool…),
  // and with `root`, the folder of its project and of the projects it uses in
  // <NAME>_ROOT, as their makefiles and scripts expect (INET_ROOT…).
  shellEnv(root) {
    const env = {};
    if (omnetppRoot()) {
      env.OMNET_ROOT = omnetppRoot();
      env.PATH = `${path.join(omnetppRoot(), 'bin')}${path.delimiter}${process.env.PATH}`;
    }
    if (root) {
      for (const d of [...this.references(root), this.projectDir(root)]) env[project.rootVariable(d)] = d;
    }
    return Object.keys(env).length ? env : undefined;
  }

  // `command` run in the environment of the OMNeT++ installation, set up by
  // its setenv script: on macOS it also puts in the PATH the Homebrew tools
  // it needs, such as GNU make (the makefiles need make 4).
  withSetenv(command) {
    const setenv = omnetppRoot() && path.join(omnetppRoot(), 'setenv');
    if (!setenv || process.platform === 'win32' || !fs.existsSync(setenv)) return command;
    return `bash -c ${quote(`. ${quote(setenv)} -q && ${command}`)}`;
  }

  // Runs `args` in a new terminal, with the environment of the project of
  // `root`, and with `setenv` in the environment of the OMNeT++ installation.
  execute(name, cwd, args, root, setenv = false) {
    const terminal = vscode.window.createTerminal({ name, cwd, env: this.shellEnv(root) });
    terminal.show();
    const command = args.map(quote).join(' ');
    terminal.sendText(this.shortCommand(name, setenv ? this.withSetenv(`exec ${command}`) : command));
  }

  // `command`, or if it is long, a command that runs it from a script. The
  // terminal may get the text before the shell reads it, and the terminal
  // driver cuts longer input lines (at 1024 bytes on macOS): the NED path and
  // exclusions of a project that uses INET are longer.
  shortCommand(name, command) {
    if (command.length < 512) return command;
    const dir = path.join(this.context.globalStorageUri ? this.context.globalStorageUri.fsPath : os.tmpdir(), 'commands');
    const file = path.join(dir, `${name.replace(/[^\w.-]+/g, '_')}.sh`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, `#!/bin/sh\n# ${name}\n${command}\n`);
    return `sh ${quote(file)}`;
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
      this.execute(name, this.workspaceDir(root), args, root);
    } else {
      // The simulation itself, run from the ini file's folder, built first if
      // it is missing. Without -r, Cmdenv runs every run, so "run 0" ([] from
      // pickRuns) needs -r 0.
      const target = this.target(root);
      if (!(await this.ensureBuilt(root, target, false))) return;
      const r = runs.length === 0 ? ['-r', '0'] : runs[1] === 'all' ? [] : runs;
      const args = [...target.command, '-u', qtenv ? 'Qtenv' : 'Cmdenv', '-c', config, ...r,
        '-n', this.nedPath(root), ...this.nedExclusions(root), ...extra, path.basename(root)];
      this.execute(name, path.dirname(root), args, root, true);
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
    this.execute(`Cluster: ${configs.join(',')}`, this.workspaceDir(root), args, root);
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
      name, 'OMNeT++', new vscode.ShellExecution(this.withSetenv(command), { cwd: ws, env: this.shellEnv(root) }));
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

  // Asks which run to debug, as the debugger runs a single process: its
  // number, or undefined if cancelled. When the runs cannot be counted, the
  // number is typed.
  async pickDebugRun(root, config) {
    const res = await this.countRuns(root, config);
    if (res.runs === 1) return '0';
    const items = [];
    for (let i = 0; i < (res.runs || 0); i++) items.push({ label: `Run ${i}`, description: res.labels[i], run: String(i) });
    items.push({ label: '$(edit) Other…', description: 'run number', custom: true });
    const pick = await vscode.window.showQuickPick(items, {
      title: `Debug ${config}${res.runs ? ` (${res.runs} runs)` : ''}`,
      placeHolder: res.error ? `${res.error}: choose Other… to type the run` : 'Run to debug (type e.g. load=50 to filter)',
      matchOnDescription: true,
    });
    if (!pick) return undefined;
    if (!pick.custom) return pick.run;
    const value = await vscode.window.showInputBox({
      title: `Debug ${config}: run`, prompt: 'Run number', value: '0',
      validateInput: (v) => (/^\d+$/.test(v.trim()) ? null : 'A run number'),
    });
    return value === undefined ? undefined : value.trim();
  }

  async debug(file, config) {
    const root = await this.pickRoot(file);
    if (!root) return;
    const type = await this.debuggerType();
    if (!type) return;
    // The run first, as Run does: the build may take long
    const run = await this.pickDebugRun(root, config);
    if (run === undefined) return;
    const target = this.target(root, true);
    if (!(await this.ensureBuilt(root, target, true))) return;
    const [program, ...programArgs] = target.command;
    const args = [...programArgs, '-r', run, '-m', '-u', setting('debug.userInterface', 'Cmdenv'), '-c', config, '-n', this.nedPath(root),
      ...this.nedExclusions(root), '--debug-on-errors=true', ...splitArgs(setting('debug.extraArgs', '')), path.basename(root)];
    const env = { ...this.shellEnv(root) };
    if (omnetppRoot()) {
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

function splitArgs(s) {
  return s.trim() ? s.trim().split(/\s+/) : [];
}

module.exports = { Runner, quote, oppRun, omnetppRoot };
