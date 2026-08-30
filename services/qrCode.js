'use strict';

const { NormalizeLicenseKey } = require('../core/utils');

let qrModule = null;
let qrLoadError = null;

function GetQrModule() {
    if (qrModule) return qrModule;
    if (qrLoadError) throw qrLoadError;
    try {
        qrModule = require('qrcode');
        return qrModule;
    } catch (error) {
        qrLoadError = new Error('QR_MODULE_NOT_AVAILABLE');
        qrLoadError.cause = error;
        throw qrLoadError;
    }
}

async function LicenseQr(key) {
    key = NormalizeLicenseKey(key);
    if (!key) throw new Error('INVALID_LICENSE');
    const payload = `relaylicense://auth?key=${encodeURIComponent(key)}`;
    const QRCode = GetQrModule();
    const svg = await QRCode.toString(payload, {
        type: 'svg',
        errorCorrectionLevel: 'M',
        margin: 2,
        width: 320
    });
    return { key, payload, svg };
}

module.exports = { LicenseQr };
