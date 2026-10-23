// Running configurations from the editor: CodeLens above each section and
// commands that launch ./run.sh (locally) or ./submit.sh (slurm)
// in a terminal. The number of runs comes from `opp_run -q numruns`.
'use strict';

const path = require('path');
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
    this.numruns = new Map(); // `${root}|${config}` => Promise<{runs} | {error}>
    this.lensEmitter = new vscode.EventEmitter();
  }

  // Called when ini files change: run counts may change.
  invalidate() {
    this.numruns.clear();
    this.lensEmitter.fire();
  }

  // ------------------------------------------------------------ queries

  // Number of runs of a config, as OMNeT++ computes it.
  countRuns(root, config) {
    const key = `${root}|${config}`;
    if (!this.numruns.has(key)) {
      this.numruns.set(key, new Promise((resolve) => {
        execFile(oppRun(), ['-s', '-c', config, '-q', 'numruns', path.basename(root)],
          { cwd: path.dirname(root), timeout: 20000, env: this.env() }, (err, stdout, stderr) => {
            const out = `${stdout}\n${stderr}`;
            const error = /Error:\s*(.*)/.exec(out);
            const lines = stdout.trim().split(/\r?\n/);
            const n = parseInt(lines[lines.length - 1], 10);
            if (error) resolve({ error: error[1].trim() });
            else if (err && err.code === 'ENOENT') resolve({ error: `${oppRun()} not found: set omnetppIni.omnetppRoot` });
            else if (Number.isNaN(n)) resolve({ error: (err && err.message) || 'cannot get the number of runs' });
            else resolve({ runs: n });
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

  // Script path as typed in the terminal, which starts in the workspace folder.
  script(file, key, fallback) {
    return setting(key, fallback);
  }

  execute(name, root, args) {
    const cwd = this.workspaceDir(root);
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
      for (let i = 0; i < Math.min(n || 0, 20); i++) items.push({ label: `Run ${i}`, args: ['-r', String(i)] });
      if (!n) items.push({ label: 'Run 0', args: [] });
      items.push({ label: '$(edit) Range…', description: 'e.g. 3 or 0-9', custom: true });
    }
    const pick = await vscode.window.showQuickPick(items, { title: `${config}${n ? ` (${n} runs)` : ''}`, placeHolder: 'Runs to execute' });
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
    const args = [this.script(root, 'run.script', './run.sh'), ...runs];
    if (qtenv) args.push('-Qt');
    args.push(...splitArgs(setting('run.extraArgs', '')));
    args.push(vscode.workspace.asRelativePath(root, false), config);
    this.execute(`${qtenv ? 'Qtenv' : 'Run'}: ${config}`, root, args);
  }

  async runCluster(file, configs) {
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
    const args = [this.script(root, 'cluster.script', './submit.sh'), ...build.args, ...runs,
      ...splitArgs(setting('cluster.extraArgs', '')), user, vscode.workspace.asRelativePath(root, false), configs.join(',')];
    this.execute(`Cluster: ${configs.join(',')}`, root, args);
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
      lenses.push(new vscode.CodeLens(range, { title: '$(debug-alt) Qtenv', tooltip: 'Run 0 with the Qtenv GUI', command: 'omnetppIni.runQtenv', arguments: args }));
      lenses.push(new vscode.CodeLens(range, { title: '$(cloud-upload) Cluster', tooltip: 'Launch on the cluster with ./submit.sh', command: 'omnetppIni.runCluster', arguments: args }));
    }
    return lenses;
  }

  // The Run lens shows the number of runs, computed only for visible lenses.
  async resolveCodeLens(lens) {
    const { file, config, roots } = lens.data;
    const args = [file, config];
    let title = '$(play) Run';
    let tooltip = 'Run with ./run.sh';
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

function splitArgs(s) {
  return s.trim() ? s.trim().split(/\s+/) : [];
}

module.exports = { Runner, quote };
