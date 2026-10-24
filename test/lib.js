// Minimal test runner and a stub of the `vscode` module, so that the extension
// can be activated with plain Node against a fixture project.
'use strict';

const fs = require('fs');
const path = require('path');
const Module = require('module');

// ---------------------------------------------------------------- runner

const tests = [];

function test(name, fn) {
  tests.push({ name, fn });
}

async function run() {
  let failed = 0;
  for (const t of tests) {
    try {
      await t.fn();
      console.log(`ok   ${t.name}`);
    } catch (e) {
      failed++;
      console.log(`FAIL ${t.name}\n     ${String(e.message).split('\n').join('\n     ')}`);
    }
  }
  console.log(`\n${tests.length - failed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
}

// ---------------------------------------------------------------- vscode stub

function walk(dir, ext, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, ext, out);
    else if (e.name.endsWith(ext)) out.push(p);
  }
  return out;
}

const disposable = { dispose() {} };
const event = () => () => disposable;
const uri = (p) => ({ fsPath: p, path: p, scheme: 'file', toString: () => `file://${p}`, with() { return this; } });
const anyKey = new Proxy({}, { get: (_, k) => String(k) });
class Data { constructor(...args) { this.args = args; } }

function stub(projectDir, providers) {
  return {
    Range: class { constructor(a, b, c, d) { Object.assign(this, { start: { line: a, character: b }, end: { line: c, character: d } }); } },
    Position: class { constructor(line, character) { Object.assign(this, { line, character }); } },
    Location: class { constructor(u, range) { Object.assign(this, { uri: u, range }); } },
    Uri: { file: uri },
    MarkdownString: class { constructor(v = '') { this.value = v; } appendMarkdown(s) { this.value += s; return this; } },
    SnippetString: class { constructor(v) { this.value = v; } },
    CompletionItem: class { constructor(label, kind) { Object.assign(this, { label, kind }); } },
    Hover: class { constructor(contents, range) { Object.assign(this, { contents, range }); } },
    Diagnostic: Data, DocumentSymbol: Data, FoldingRange: Data, CodeLens: Data, Task: Data, ShellExecution: Data,
    EventEmitter: class { constructor() { this.event = event(); } fire() {} dispose() {} },
    CompletionItemKind: anyKey, CompletionItemTag: anyKey, SymbolKind: anyKey, FoldingRangeKind: anyKey,
    DiagnosticSeverity: { Error: 'error', Warning: 'warning' }, TaskScope: anyKey, TaskRevealKind: anyKey, ConfigurationTarget: anyKey,
    languages: {
      createDiagnosticCollection: () => ({ set() {}, delete() {}, dispose() {} }),
      registerCompletionItemProvider: (_, p) => { providers.completion = p; return disposable; },
      registerHoverProvider: (_, p) => { providers.hover = p; return disposable; },
      registerDefinitionProvider: (_, p) => { providers.definition = p; return disposable; },
      registerReferenceProvider: () => disposable,
      registerDocumentSymbolProvider: () => disposable,
      registerFoldingRangeProvider: () => disposable,
      registerCodeLensProvider: () => disposable,
    },
    workspace: {
      textDocuments: [],
      asRelativePath: (p) => path.relative(projectDir, typeof p === 'string' ? p : p.fsPath),
      getWorkspaceFolder: () => ({ uri: uri(projectDir), name: path.basename(projectDir) }),
      // No OMNeT++ installation: the built-in option list is used, so results do not depend on the machine
      getConfiguration: () => ({ get: (k, d) => (k === 'omnetppRoot' ? path.join(projectDir, 'no-omnetpp') : d), update: async () => {} }),
      findFiles: async (glob) => walk(projectDir, glob.endsWith('.ned') ? '.ned' : '.ini').map(uri),
      createFileSystemWatcher: () => ({ onDidCreate() {}, onDidChange() {}, onDidDelete() {}, dispose() {} }),
      onDidOpenTextDocument: event(), onDidChangeTextDocument: event(), onDidCloseTextDocument: event(),
      onDidSaveTextDocument: event(), onDidChangeConfiguration: event(),
    },
    window: {
      createOutputChannel: () => ({ appendLine() {}, dispose() {} }),
      showWarningMessage() {}, showInformationMessage() {}, showQuickPick() {}, showInputBox() {}, createTerminal() {},
    },
    commands: { registerCommand: () => disposable, executeCommand: async () => {} },
    tasks: { onDidEndTaskProcess: event(), executeTask: async () => {} },
    debug: { startDebugging: async () => {} },
    extensions: { getExtension: () => undefined },
  };
}

// A text document with the parts of the vscode.TextDocument API the providers use.
function document(file, text) {
  const lines = text.split('\n');
  return {
    uri: uri(file), fileName: file, languageId: 'omnetpp-ini', isDirty: false, lineCount: lines.length,
    getText: (range) => (range ? lines[range.start.line].slice(range.start.character, range.end.character) : text),
    lineAt: (l) => ({ text: lines[typeof l === 'number' ? l : l.line] }),
    getWordRangeAtPosition: (pos, re) => {
      const r = new RegExp(re ? re.source : '[\\w-]+', 'g');
      let m;
      while ((m = r.exec(lines[pos.line]))) {
        if (m.index <= pos.character && pos.character <= m.index + m[0].length) {
          return { start: { line: pos.line, character: m.index }, end: { line: pos.line, character: m.index + m[0].length } };
        }
        if (!m[0].length) r.lastIndex++;
      }
      return undefined;
    },
  };
}

// Activates the extension on a project folder (once per process). Returns the
// extension module, its ini index, the registered providers and helpers.
let loaded;
async function loadExtension(projectDir) {
  if (loaded) return loaded;
  const src = path.join(__dirname, '..', 'src');
  const providers = {};
  const vscode = stub(projectDir, providers);
  const load = Module._load;
  Module._load = function (request, ...rest) {
    return request === 'vscode' ? vscode : load.call(this, request, ...rest);
  };
  // diagnose() needs the extension's IniIndex instance, which it does not export
  const indexModule = require(path.join(src, 'index.js'));
  const { IniIndex } = indexModule;
  let iniIndex;
  indexModule.IniIndex = class extends IniIndex { constructor(...a) { super(...a); iniIndex = this; } };
  const ext = require(path.join(src, 'extension.js'));
  const { diagnose } = require(path.join(src, 'diagnostics.js'));
  ext.activate({ subscriptions: [], globalStorageUri: uri(path.join(projectDir, 'no-storage')), workspaceState: { get() {}, update() {} }, globalState: { get() {}, update() {} } });
  await new Promise((r) => setTimeout(r, 100)); // the index is built asynchronously
  const diagnostics = (file) => [...diagnose(file, iniIndex), ...ext.nedDiagnostics(file, ext.docOf(file))];
  loaded = { ext, iniIndex, providers, vscode, diagnostics };
  return loaded;
}

module.exports = { test, run, walk, document, loadExtension };
