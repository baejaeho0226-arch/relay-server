'use strict';
const fs = require('fs');
const bundle = require('../web/uiBundle');
if (process.argv.includes('--write')) {
  fs.writeFileSync(bundle.ManifestPath, JSON.stringify(bundle.Generate(), null, 2) + '\n');
  console.log('WEB UI MANIFEST WRITTEN');
}
const check = bundle.Check();
if (!check.ready) { console.error('WEB UI FILES MISMATCH: ' + check.issues.join(', ')); process.exitCode = 1; }
else console.log(`WEB UI BUNDLE PASS: WEB v${check.webAdminVersion} / UI ${check.uiRevision} / ${bundle.FILES.length} files`);
