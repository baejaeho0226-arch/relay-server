'use strict';
const fs = require('node:fs'), path = require('node:path');
const { spawnSync } = require('node:child_process');
const files = fs.readdirSync(__dirname).filter(name => /^test-.*\.js$/.test(name) &&
  (!process.argv.includes('--fix12') || name.startsWith('test-fix12-')) && (!process.argv.includes('--fix13') || name.startsWith('test-fix13-')) && (!process.argv.includes('--fix18') || name.startsWith('test-fix18-')) && (!process.argv.includes('--fix19') || name.startsWith('test-fix19-')) && (!process.argv.includes('--fix20') || name.startsWith('test-fix20-')) && (!process.argv.includes('--fix21') || name.startsWith('test-fix21-'))).sort();
let failed = 0;
for (const name of files) {
  const result = spawnSync(process.execPath, [path.join(__dirname,name)], {
    cwd: path.resolve(__dirname,'..'), encoding:'utf8', timeout:90000
  });
  const ok = result.status === 0;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
  if (!ok) { failed++; console.error(result.error || (result.stdout || '') + (result.stderr || '')); }
}
console.log(`${files.length - failed}/${files.length} passed`);
process.exitCode = failed ? 1 : 0;
