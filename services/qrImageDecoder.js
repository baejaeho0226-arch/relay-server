'use strict';

const jsQR = require('jsqr');
const { PNG } = require('pngjs');
const jpeg = require('jpeg-js');
const { QR_AUTH_MAX_IMAGE_BYTES } = require('../config/config');

const MAX_IMAGE_PIXELS = 40 * 1000 * 1000;

function ValidateDimensions(width, height) {
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) throw new Error('QR_IMAGE_DIMENSIONS_INVALID');
    if (width > 10000 || height > 10000 || width * height > MAX_IMAGE_PIXELS) throw new Error('QR_IMAGE_DIMENSIONS_INVALID');
}

function ParseImageData(imageData) {
    const match = /^data:image\/(png|jpeg|jpg);base64,([A-Za-z0-9+/=\r\n]+)$/i.exec(String(imageData || ''));
    if (!match) throw new Error('QR_IMAGE_FORMAT_UNSUPPORTED');
    let buffer;
    try { buffer = Buffer.from(match[2].replace(/[\r\n]/g, ''), 'base64'); }
    catch (_) { throw new Error('QR_IMAGE_INVALID_BASE64'); }
    if (!buffer.length) throw new Error('QR_IMAGE_EMPTY');
    if (buffer.length > QR_AUTH_MAX_IMAGE_BYTES) throw new Error('QR_IMAGE_TOO_LARGE');

    try {
        if (match[1].toLowerCase() === 'png') {
            if (buffer.length < 24 || buffer.toString('hex', 0, 8) !== '89504e470d0a1a0a') throw new Error('QR_IMAGE_DECODE_FAILED');
            ValidateDimensions(buffer.readUInt32BE(16), buffer.readUInt32BE(20));
            const decoded = PNG.sync.read(buffer, { checkCRC: true });
            ValidateDimensions(decoded.width, decoded.height);
            return { width: decoded.width, height: decoded.height, data: new Uint8ClampedArray(decoded.data) };
        }
        const decoded = jpeg.decode(buffer, { useTArray: true, formatAsRGBA: true, maxResolutionInMP: 40 });
        ValidateDimensions(decoded.width, decoded.height);
        return { width: decoded.width, height: decoded.height, data: new Uint8ClampedArray(decoded.data) };
    } catch (error) {
        if (String(error && error.message || '').startsWith('QR_')) throw error;
        throw new Error('QR_IMAGE_DECODE_FAILED');
    }
}

function ResizeForScan(image, maxSide = 1800) {
    const longest = Math.max(image.width, image.height);
    if (longest <= maxSide) return image;
    const scale = maxSide / longest;
    const width = Math.max(1, Math.round(image.width * scale));
    const height = Math.max(1, Math.round(image.height * scale));
    const data = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) {
        const sourceY = Math.min(image.height - 1, Math.floor(y / scale));
        for (let x = 0; x < width; x++) {
            const sourceX = Math.min(image.width - 1, Math.floor(x / scale));
            const sourceOffset = (sourceY * image.width + sourceX) * 4;
            const targetOffset = (y * width + x) * 4;
            data[targetOffset] = image.data[sourceOffset];
            data[targetOffset + 1] = image.data[sourceOffset + 1];
            data[targetOffset + 2] = image.data[sourceOffset + 2];
            data[targetOffset + 3] = image.data[sourceOffset + 3];
        }
    }
    return { width, height, data };
}

function DecodeQrImage(imageData) {
    const image = ResizeForScan(ParseImageData(imageData));
    if (image.width < 80 || image.height < 80) throw new Error('QR_IMAGE_TOO_SMALL');
    if (image.width * image.height > 1800 * 1800) throw new Error('QR_IMAGE_DIMENSIONS_INVALID');
    const result = jsQR(image.data, image.width, image.height, { inversionAttempts: 'attemptBoth' });
    if (!result || !result.data) throw new Error('QR_NOT_FOUND');
    if (result.data.length > 2048) throw new Error('QR_PAYLOAD_TOO_LARGE');
    return result.data;
}

module.exports = { DecodeQrImage, ParseImageData, ResizeForScan, ValidateDimensions };
