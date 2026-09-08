'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = __dirname;
const sourceDirs = [
    path.join(root, 'ApkWinSock_Android64'),
    path.join(root, 'WinSockServer_Win64')
];

function delphiFiles(dir) {
    return fs.readdirSync(dir)
        .filter(name => /\.(pas|dpr|inc)$/i.test(name))
        .map(name => path.join(dir, name));
}

const files = sourceDirs.flatMap(delphiFiles);
const decoder = new TextDecoder('utf-8', { fatal: true });
for (const file of files) {
    const bytes = fs.readFileSync(file);
    assert.ok(bytes.length >= 3, `${path.basename(file)}: empty source`);
    assert.deepStrictEqual(
        Array.from(bytes.subarray(0, 3)), [0xEF, 0xBB, 0xBF],
        `${path.basename(file)}: UTF-8 BOM missing`
    );
    const text = decoder.decode(bytes);
    assert.ok(!text.includes('\uFFFD'), `${path.basename(file)}: invalid UTF-8`);
    assert.ok(!text.includes('{$CODEPAGE'), `${path.basename(file)}: version-dependent CODEPAGE directive found`);
}

const apkText = delphiFiles(sourceDirs[0]).map(file => fs.readFileSync(file, 'utf8')).join('\n');
const serverText = delphiFiles(sourceDirs[1]).map(file => fs.readFileSync(file, 'utf8')).join('\n');
const consoleText = fs.readFileSync(path.join(sourceDirs[1], 'ConsoleLog.pas'), 'utf8');

assert.ok(/[가-힣]/.test(apkText), 'APK Korean UI strings missing');
assert.ok(!/[가-힣]/.test(serverText), 'WinSockServer source must remain console-codepage-safe ASCII');
assert.ok(consoleText.includes("PrintStatus('BUILD AUTHORIZED - SERVICE READY')"));
assert.ok(consoleText.includes("PrintStatus('WAITING FOR APK AUTHORIZATION')"));

console.log('DELPHI SOURCE ENCODING PASS');
console.log(`- UTF-8 BOM and strict UTF-8 decode: ${files.length} files`);
console.log('- APK Korean Unicode literals: PASS');
console.log('- WinSockServer console ASCII policy: PASS');
console.log('- No Win32 console code-page API required: PASS');
