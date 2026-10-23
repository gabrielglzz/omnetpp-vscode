// Configuration options, predefined variables and result recorders of OMNeT++.
//
// They are read at runtime from the user's own OMNeT++ installation
// (`opp_run -h configdetails`, `-h configvars`, `-h resultrecorders`) and cached
// per OMNeT++ version. Until then (or without OMNeT++) a built-in list with the
// option names, types and defaults is used (options-fallback.json), which
// contains no documentation text.
'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const state = {
  source: 'built-in list',
  options: [],
  exact: new Map(),
  patterns: [], // options like seed-%-mt or rng-%
  variables: new Map(),
  recorders: [],
};

function use(data, source) {
  state.source = source;
  state.options = data.options;
  state.exact = new Map();
  state.patterns = [];
  for (const o of data.options) {
    if (o.name.includes('%')) {
      const re = new RegExp('^' + o.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '\\d+') + '$');
      state.patterns.push({ re, option: o });
    } else {
      state.exact.set(o.name, o);
    }
  }
  state.variables = new Map((data.variables || []).map((v) => [v.name, v]));
  state.recorders = data.recorders || [];
}

use(require('./options-fallback.json'), 'built-in list');

// ------------------------------------------------------------ opp_run -h parsing

// Yields [head line, [indented description lines]] after the line starting with `header`.
function* blocks(lines, header) {
  const start = lines.findIndex((l) => l.startsWith(header));
  if (start < 0) return;
  let head = null;
  let body = [];
  for (const line of lines.slice(start + 1)) {
    if (line && !line.startsWith(' ')) {
      if (head) yield [head, body];
      head = line;
      body = [];
    } else if (head && line.trim()) {
      body.push(line.trim());
    }
  }
  if (head) yield [head, body];
}

// Joins wrapped lines into paragraphs, keeping "Usage:" / "Example" apart.
function join(lines) {
  let text = '';
  for (const line of lines) {
    if (text && /^(Usage|Example|Special values|Note)\b/.test(line)) text += `\n\n${line}`;
    else text += (text ? ' ' : '') + line;
  }
  return text;
}

function parseOptions(text) {
  const options = [];
  for (const [head, body] of blocks(text.split(/\r?\n/), 'Supported configuration options:')) {
    const m = /^(\*\*\.)?([^=]+)=<(\w+)>(.*)$/.exec(head);
    if (!m) continue;
    const [, perObject, name, type, rest] = m;
    const unit = /unit="([^"]*)"/.exec(rest);
    const def = /default:(.*)$/.exec(rest);
    const kind = body[0] || '';
    const isKind = /setting/.test(kind) && kind.endsWith('.');
    options.push({
      name,
      type,
      unit: unit ? unit[1] : null,
      default: def ? def[1].trim() : null,
      scope: perObject ? 'per-object' : kind.startsWith('Global') ? 'global' : 'per-run',
      kind: isKind ? kind.replace(/\.$/, '') : '',
      description: join(isKind ? body.slice(1) : body),
    });
  }
  return options;
}

function parseVariables(text) {
  return [...blocks(text.split(/\r?\n/), 'Predefined variables')]
    .filter(([head]) => head.startsWith('${'))
    .map(([head, body]) => ({ name: head.trim().slice(2, -1), description: join(body) }));
}

function parseRecorders(text) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => l.startsWith('Result recorders'));
  const out = [];
  let cur = null;
  for (const line of start < 0 ? [] : lines.slice(start + 1)) {
    const m = /^ {2}(\w+)\s*$/.exec(line);
    if (m) {
      cur = { name: m[1], body: [] };
      out.push(cur);
    } else if (cur && line.trim()) {
      cur.body.push(line.trim());
    }
  }
  return out.map((r) => ({ name: r.name, description: join(r.body) }));
}

function help(oppRun, topic, env) {
  return new Promise((resolve, reject) => {
    execFile(oppRun, ['-h', topic], { env, timeout: 20000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
      if (err && !stdout) reject(err);
      else resolve(stdout);
    });
  });
}

// Reads the options from `oppRun` (cached in `cacheDir` per OMNeT++ version).
// Resolves to a short description of the source, or rejects if opp_run fails.
async function load(oppRun, cacheDir, env = process.env) {
  const banner = await help(oppRun, 'config', env);
  const version = (/Version:\s*([^,\s]+)/.exec(banner) || [])[1];
  if (!version) throw new Error(`${oppRun} did not report its version`);
  const cache = cacheDir && path.join(cacheDir, `omnetpp-${version}-options.json`);
  let data;
  try {
    data = JSON.parse(fs.readFileSync(cache, 'utf8'));
  } catch {
    const [details, vars, recorders] = await Promise.all(
      ['configdetails', 'configvars', 'resultrecorders'].map((t) => help(oppRun, t, env)));
    data = { options: parseOptions(details), variables: parseVariables(vars), recorders: parseRecorders(recorders) };
    if (!data.options.length) throw new Error(`no options in the output of ${oppRun} -h configdetails`);
    if (cache) {
      fs.mkdirSync(cacheDir, { recursive: true });
      fs.writeFileSync(cache, JSON.stringify(data));
    }
  }
  use(data, `OMNeT++ ${version}`);
  return state.source;
}

function lookup(name) {
  if (state.exact.has(name)) return state.exact.get(name);
  const p = state.patterns.find((x) => x.re.test(name));
  return p ? p.option : undefined;
}

// Markdown documentation of an option.
function optionMarkdown(o) {
  const prefix = o.scope === 'per-object' ? '**.' : '';
  let head = `**${prefix}${o.name}** = \`<${o.type}>\``;
  if (o.unit) head += `, unit: \`${o.unit}\``;
  if (o.default !== null && o.default !== '') head += `, default: \`${o.default}\``;
  const kind = o.kind || `${o.scope} option`;
  return o.description ? `${head}\n\n*${kind}.*\n\n${o.description}` : `${head}\n\n*${kind}.*`;
}

module.exports = {
  load,
  lookup,
  optionMarkdown,
  get options() { return state.options; },
  get variables() { return state.variables; },
  get recorders() { return state.recorders; },
  get source() { return state.source; },
};
