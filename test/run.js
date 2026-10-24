// Runs every test/*.test.js file.
//
//   ELECTRON_RUN_AS_NODE=1 "/Applications/Visual Studio Code.app/Contents/MacOS/Code" test/run.js
'use strict';

const fs = require('fs');
const path = require('path');
const { run } = require('./lib');

for (const f of fs.readdirSync(__dirname).filter((f) => f.endsWith('.test.js')).sort()) {
  require(path.join(__dirname, f));
}
run();
