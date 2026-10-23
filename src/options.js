// Configuration options and predefined variables (data/options.json, generated
// by gen-options.py from `opp_run -h configdetails` / `-h configvars`).
'use strict';

const data = require('../data/options.json');

const exact = new Map();
const patterns = []; // options like seed-%-mt or rng-%
for (const o of data.options) {
  if (o.name.includes('%')) {
    const re = new RegExp('^' + o.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '\\d+') + '$');
    patterns.push({ re, option: o });
  } else {
    exact.set(o.name, o);
  }
}

function lookup(name) {
  if (exact.has(name)) return exact.get(name);
  const p = patterns.find((x) => x.re.test(name));
  return p ? p.option : undefined;
}

const variables = new Map(data.variables.map((v) => [v.name, v]));
const recorders = data.recorders || [];

// Markdown documentation of an option.
function optionMarkdown(o) {
  const prefix = o.scope === 'per-object' ? '**.' : '';
  let head = `**${prefix}${o.name}** = \`<${o.type}>\``;
  if (o.unit) head += `, unit: \`${o.unit}\``;
  if (o.default !== null && o.default !== '') head += `, default: \`${o.default}\``;
  return `${head}\n\n*${o.kind}.*\n\n${o.description}`;
}

module.exports = {
  options: data.options,
  generatedFrom: data.generatedFrom,
  lookup,
  variables,
  recorders,
  optionMarkdown,
};
