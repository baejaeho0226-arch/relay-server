'use strict';

function NormalizeAccessType(value) {
    const normalized = String(value || '').trim().toUpperCase();
    return ['TYPE1', 'TYPE2', 'TYPE3'].includes(normalized) ? normalized : 'TYPE1';
}

function DisplayName(value) {
    const type = NormalizeAccessType(value);
    if (type === 'TYPE2') return 'R2Beat';
    if (type === 'TYPE3') return 'Lostsaga';
    return 'TalesRunner';
}

module.exports = { NormalizeAccessType, DisplayName };
