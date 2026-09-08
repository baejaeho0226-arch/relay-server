'use strict';

// Focused source guard for the standalone member client. This is not a Delphi
// compiler; it catches malformed fields and missing fields/methods in this unit.
const fs = require('node:fs');
const path = require('node:path');

function CodeOnly(source) {
    return source.replace(/\(\*[\s\S]*?\*\)|\{[\s\S]*?\}|\/\/[^\r\n]*|'(?:[^']|'')*'/g, ' ');
}

function TopLevelComma(type) {
    let angle = 0, brackets = 0, parentheses = 0;
    for (const ch of type) {
        if (ch === '<') angle++;
        else if (ch === '>') angle--;
        else if (ch === '[') brackets++;
        else if (ch === ']') brackets--;
        else if (ch === '(') parentheses++;
        else if (ch === ')') parentheses--;
        else if (ch === ',' && angle === 0 && brackets === 0 && parentheses === 0) return true;
    }
    return false;
}

function Check(source) {
    const code = CodeOnly(source);
    const match = /\bTApkMemberClient\s*=\s*class\b([\s\S]*?)^\s*end\s*;/mi.exec(code);
    if (!match) return ['TApkMemberClient declaration missing'];
    const issues = [], fields = new Set();
    for (const field of match[1].matchAll(/^\s*((?:F\w+\s*,\s*)*F\w+)\s*:\s*([^;]+);/gm)) {
        for (const name of field[1].split(',')) fields.add(name.trim().toUpperCase());
        if (TopLevelComma(field[2])) issues.push('Invalid field type list: ' + field[1].trim());
    }
    for (const name of new Set(code.match(/\bF[A-Z]\w*\b/g) || [])) {
        if (!fields.has(name.toUpperCase())) issues.push('Undeclared member field: ' + name);
    }
    const declared = [...match[1].matchAll(/\b(?:constructor|destructor|procedure|function)\s+(\w+)/gi)].map(m => m[1].toUpperCase());
    const implemented = [...code.matchAll(/\b(?:constructor|destructor|procedure|function)\s+TApkMemberClient\.(\w+)/gi)].map(m => m[1].toUpperCase());
    for (const name of declared) if (!implemented.includes(name)) issues.push('Missing implementation: ' + name);
    for (const name of implemented) if (!declared.includes(name)) issues.push('Missing method declaration: ' + name);
    return issues;
}

if (require.main === module) {
    const file = process.argv[2] || path.join(__dirname, 'ApkWinSock_Android64', 'ApkMemberClient.pas');
    const issues = Check(fs.readFileSync(file, 'utf8'));
    if (issues.length) {
        for (const issue of issues) console.error(issue);
        process.exitCode = 1;
    } else console.log('MEMBER DECLARATION CHECK PASS');
}

module.exports = { Check, TopLevelComma };
