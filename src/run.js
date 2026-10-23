// Running configurations from the editor: CodeLens above each section and
// commands that launch the simulation (or a project script) in a terminal,
// a debug session, or a cluster script. The runs and their iteration variables come from
// `opp_run -q runs`.
'use strict';

const path = require('path');
const fs = require('fs');
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

function oppRun() {
  const root = omnetppRoot();
  return root ? path.join(root, 'bin', 'opp_run') : 'opp_run';
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

  // Simulation executable: the omnetppIni.run.program setting, or the
  // executable opp_makemake builds (named after the project directory, with
  // `suffix` for debug builds), or opp_run.
  program(root, suffix = '') {
    const ws = this.workspaceDir(root);
    const p = setting(suffix ? 'debug.program' : 'run.program', '');
    if (p) return path.isAbsolute(p) ? p : path.join(ws, p);
    const built = path.join(ws, path.basename(ws) + suffix);
    return fs.existsSync(built) || suffix ? built : 'opp_run';
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

  execute(name, cwd, args) {
    const env = omnetppRoot() ? { OMNET_ROOT: omnetppRoot() } : undefined;
    const terminal = vscode.window.createTerminal({ name, cwd, env });
    terminal.show();
    terminal.sendText(args.map(quote).join(' '));
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
      // The simulation itself, run from the ini file's folder. Without -r,
      // Cmdenv runs every run, so "run 0" ([] from pickRuns) needs -r 0.
      const r = runs.length === 0 ? ['-r', '0'] : runs[1] === 'all' ? [] : runs;
      const args = [this.program(root), '-u', qtenv ? 'Qtenv' : 'Cmdenv', '-c', config, ...r,
        '-n', this.nedPath(root), ...extra, path.basename(root)];
      this.execute(name, path.dirname(root), args);
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

  // Debug executable: <workspace>/<project name>_dbg, as opp_makemake builds it with MODE=debug.
  debugProgram(root) {
    return this.program(root, '_dbg');
  }

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

  // Runs the debug build command as a task and resolves to true if it succeeds.
  buildDebug(root) {
    const ws = this.workspaceDir(root);
    const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(root));
    const task = new vscode.Task({ type: 'shell', task: 'build-debug' }, folder || vscode.TaskScope.Workspace,
      'Build (debug)', 'OMNeT++', new vscode.ShellExecution(setting('debug.buildCommand', 'make MODE=debug'), { cwd: ws, env: omnetppRoot() ? { OMNET_ROOT: omnetppRoot() } : undefined }));
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
    const program = this.debugProgram(root);
    if (!fs.existsSync(program)) {
      const ok = await vscode.window.showWarningMessage(
        `Debug executable not found: ${vscode.workspace.asRelativePath(program)}`, `Build it (${setting('debug.buildCommand', 'make MODE=debug')})`);
      if (!ok || !(await this.buildDebug(root)) || !fs.existsSync(program)) return;
    }
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
    const args = ['-r', run, '-m', '-u', setting('debug.userInterface', 'Cmdenv'), '-c', config, '-n', this.nedPath(root),
      '--debug-on-errors=true', ...splitArgs(setting('debug.extraArgs', '')), path.basename(root)];
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

function splitArgs(s) {
  return s.trim() ? s.trim().split(/\s+/) : [];
}

module.exports = { Runner, quote, oppRun, omnetppRoot };
