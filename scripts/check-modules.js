'use strict';

const fs = require('fs');
const path = require('path');
const childProcess = require('child_process');

const ROOT = path.resolve(__dirname, '..');

function collectJs(dir) {
    const result = [];

    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);

        if (entry.isDirectory()) {
            if (entry.name === 'node_modules') {
                continue;
            }

            result.push(...collectJs(full));
            continue;
        }

        if (entry.isFile() && entry.name.endsWith('.js')) {
            result.push(full);
        }
    }

    return result;
}

function resolveLocalModule(fromFile, request) {
    const base = path.resolve(path.dirname(fromFile), request);
    const candidates = [base, base + '.js', path.join(base, 'index.js')];

    for (const candidate of candidates) {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
            return candidate;
        }
    }

    return '';
}

const files = collectJs(ROOT);
let errors = 0;

for (const file of files) {
    try {
        childProcess.execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
    } catch (error) {
        console.error('[SYNTAX ERROR]', path.relative(ROOT, file));
        console.error(String(error.stderr || error.message));
        errors++;
    }
}

const localRequirePattern = /require\(['"](\.{1,2}\/[^'"]+)['"]\)/g;
const lazyExportPattern = /require\(['"](\.{1,2}\/[^'"]+)['"]\)\.(\w+)/g;

for (const file of files) {
    if (path.relative(ROOT, file) === 'server.js') {
        continue;
    }

    const text = fs.readFileSync(file, 'utf8');
    let match;

    while ((match = localRequirePattern.exec(text)) !== null) {
        const request = match[1];
        const resolved = resolveLocalModule(file, request);

        if (!resolved) {
            console.error('[MISSING MODULE]', path.relative(ROOT, file), '->', request);
            errors++;
        }
    }

    while ((match = lazyExportPattern.exec(text)) !== null) {
        const request = match[1];
        const exportName = match[2];
        const resolved = resolveLocalModule(file, request);

        if (!resolved) {
            continue;
        }

        try {
            const mod = require(resolved);

            if (!(exportName in mod)) {
                console.error('[MISSING EXPORT]', path.relative(ROOT, file), '->', request + '.' + exportName);
                errors++;
            }
        } catch (error) {
            console.error('[LOAD ERROR]', path.relative(ROOT, file), '->', request);
            console.error(error && error.stack ? error.stack : error);
            errors++;
        }
    }
}

if (errors > 0) {
    console.error(`MODULE CHECK FAILED: ${errors} error(s)`);
    process.exit(1);
}

console.log(`MODULE CHECK OK: ${files.length} JavaScript files`);
