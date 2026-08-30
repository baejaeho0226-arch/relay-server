'use strict';

const state = require('../core/state');
const { Now } = require('../core/utils');
const { GetLicenseStatus } = require('../license/licenseManager');
const { AddNotification } = require('./notificationCenter');

const DAY = 86400000;
const alerted = new Map();

function GetExpiryBucket(license, now = Now()) {
    if (!license) return 'NONE';
    const status = GetLicenseStatus(license);
    if (status === 'EXPIRED') return 'EXPIRED';
    const remain = Number(license.expiresAt || 0) - now;
    if (remain <= DAY) return '1D';
    if (remain <= 3 * DAY) return '3D';
    if (remain <= 7 * DAY) return '7D';
    if (remain <= 30 * DAY) return '30D';
    return 'LATER';
}

function GetExpirySummary() {
    const summary = { expired: 0, within1d: 0, within3d: 0, within7d: 0, within30d: 0 };
    const now = Now();
    for (const license of state.licenses.values()) {
        const status = GetLicenseStatus(license);
        if (status === 'EXPIRED') { summary.expired++; continue; }
        const remain = Number(license.expiresAt || 0) - now;
        if (remain <= DAY) summary.within1d++;
        if (remain <= 3 * DAY) summary.within3d++;
        if (remain <= 7 * DAY) summary.within7d++;
        if (remain <= 30 * DAY) summary.within30d++;
    }
    return summary;
}

function MatchesExpiryFilter(license, filter) {
    filter = String(filter || 'ALL').toUpperCase();
    if (!filter || filter === 'ALL') return true;
    const status = GetLicenseStatus(license);
    if (filter === 'EXPIRED') return status === 'EXPIRED';
    if (status === 'EXPIRED') return false;
    const remain = Number(license.expiresAt || 0) - Now();
    if (filter === '1D') return remain <= DAY;
    if (filter === '3D') return remain <= 3 * DAY;
    if (filter === '7D') return remain <= 7 * DAY;
    if (filter === '30D') return remain <= 30 * DAY;
    return true;
}

function ScanLicenseExpiryAlerts() {
    const now = Now();
    for (const [key, license] of state.licenses) {
        const bucket = GetExpiryBucket(license, now);
        if (!['EXPIRED', '1D', '3D', '7D'].includes(bucket)) continue;
        const signature = `${bucket}:${Math.floor(now / DAY)}`;
        if (alerted.get(key) === signature) continue;
        alerted.set(key, signature);
        const title = bucket === 'EXPIRED' ? 'License expired' : `License expires within ${bucket === '1D' ? '24h' : bucket.toLowerCase()}`;
        AddNotification({
            severity: bucket === 'EXPIRED' || bucket === '1D' ? 'CRITICAL' : 'WARNING',
            type: 'LICENSE_EXPIRY',
            title,
            message: `${key} / ${new Date(license.expiresAt).toISOString()}`,
            entityType: 'LICENSE',
            entityId: key,
            dedupeKey: `LICENSE_EXPIRY|${key}|${bucket}|${Math.floor(now / DAY)}`
        });
    }
}

module.exports = { GetExpiryBucket, GetExpirySummary, MatchesExpiryFilter, ScanLicenseExpiryAlerts };
