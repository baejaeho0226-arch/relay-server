'use strict';

// Source guard for standalone classes. This is not a Delphi compiler;
// it catches malformed fields and missing fields/methods in a unit.
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

function Check(source, className='TMoaPlayMemberClient') {
    if(!/^T\w+$/.test(className))throw Error('Invalid class name');
    const code = CodeOnly(source).replace(/\buses\b[\s\S]*?;/gi, ' ');
    const match = new RegExp('\\b'+className+'\\s*=\\s*class\\b([\\s\\S]*?)^\\s*end\\s*;','mi').exec(code);
    if (!match) return [className+' declaration missing'];
    const issues = [], fields = new Set();
    for (const field of match[1].matchAll(/^\s*((?:F\w+\s*,\s*)*F\w+)\s*:\s*([^;]+);/gm)) {
        for (const name of field[1].split(',')) {
            const key=name.trim().toUpperCase();
            if(fields.has(key))issues.push('Duplicate member field: '+key);
            fields.add(key);
        }
        if (TopLevelComma(field[2])) issues.push('Invalid field type list: ' + field[1].trim());
    }
    for (const name of new Set(code.match(/\bF[A-Z]\w*\b/g) || [])) {
        if (!fields.has(name.toUpperCase())) issues.push('Undeclared member field: ' + name);
    }
    const declared = [...match[1].matchAll(/\b(?:constructor|destructor|procedure|function)\s+(\w+)/gi)].map(m => m[1].toUpperCase());
    const implemented = [...code.matchAll(new RegExp('\\b(?:constructor|destructor|procedure|function)\\s+'+className+'\\.(\\w+)','gi'))].map(m => m[1].toUpperCase());
    for (const name of declared) if (!implemented.includes(name)) issues.push('Missing implementation: ' + name);
    for (const name of implemented) if (!declared.includes(name)) issues.push('Missing method declaration: ' + name);
    return issues;
}

if (require.main === module) {
    const file = process.argv[2] || path.join(__dirname, '../..', 'MoaPlayApp_Android64', 'MoaPlayMemberClient.pas');
    const issues = Check(fs.readFileSync(file, 'utf8'));
    if (issues.length) {
        for (const issue of issues) console.error(issue);
        process.exitCode = 1;
    } else console.log('MEMBER DECLARATION CHECK PASS');
}

module.exports = { Check, TopLevelComma };
