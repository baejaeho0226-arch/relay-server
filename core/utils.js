'use strict';

const crypto =
    require(
        'crypto'
    );

const fs =
    require(
        'fs'
    );

const config =
    require(
        '../config/config'
    );

const {
    DATA_DIR,
    BACKUP_DIR,
    AUDIT_DIR
} = config;

function Now() {
    return Date.now();
}

function RandomHex(bytes) {
    return crypto
        .randomBytes(bytes)
        .toString('hex')
        .toUpperCase();
}

function RandomID() {
    return RandomHex(8);
}

function RandomNonce() {
    return RandomHex(32);
}

function RandomLicenseKey() {
    return (
        'LICENSE-' +
        RandomHex(10)
    );
}

function RandomToken() {
    return RandomHex(24);
}

function EnsureDirs() {
    fs.mkdirSync(
        DATA_DIR,
        {
            recursive: true
        }
    );

    fs.mkdirSync(
        BACKUP_DIR,
        {
            recursive: true
        }
    );

    fs.mkdirSync(
        AUDIT_DIR,
        {
            recursive: true
        }
    );
}

function NormalizeID(id) {
    if (
        typeof id !==
        'string'
    ) {
        return '';
    }

    id =
        id
            .trim()
            .toUpperCase();

    if (
        id.startsWith(
            'SERVER-'
        )
    ) {
        id =
            id.substring(7);
    }

    if (
        id.startsWith(
            'CLIENT-'
        )
    ) {
        id =
            id.substring(7);
    }

    return /^[0-9A-F]{16}$/.test(id)
        ? id
        : '';
}

function NormalizeLicenseKey(key) {
    return (
        typeof key ===
        'string'
    )
        ? key
            .trim()
            .toUpperCase()
        : '';
}

function NormalizeVersion(value) {
    const s =
        String(
            value ||
            ''
        ).trim();

    return /^\d+(\.\d+){0,3}$/.test(s)
        ? s
        : '';
}

function CompareVersions(
    a,
    b
) {
    a =
        NormalizeVersion(a);

    b =
        NormalizeVersion(b);

    if (
        !a ||
        !b
    ) {
        return 0;
    }

    const aa =
        a
            .split('.')
            .map(Number);

    const bb =
        b
            .split('.')
            .map(Number);

    const count =
        Math.max(
            aa.length,
            bb.length
        );

    for (
        let i = 0;
        i < count;
        i++
    ) {
        const av =
            aa[i] ||
            0;

        const bv =
            bb[i] ||
            0;

        if (
            av < bv
        ) {
            return -1;
        }

        if (
            av > bv
        ) {
            return 1;
        }
    }

    return 0;
}

function IsVersionAtLeast(
    current,
    required
) {
    return (
        CompareVersions(
            current,
            required
        ) >= 0
    );
}

function SafeField(text) {
    return String(
        text ||
        ''
    )
        .replace(
            /[\r\n|]/g,
            ' '
        )
        .trim();
}

function SafeIP(socket) {
    return socket
        ? String(
            socket.remoteAddress ||
            ''
        )
        : '';
}

function SendLine(
    socket,
    text
) {
    if (
        !socket ||
        socket.destroyed
    ) {
        return false;
    }

    try {
        socket.write(
            String(text) +
            '\n'
        );

        return true;
    } catch (_) {
        return false;
    }
}

function ConstantTimeEqual(
    a,
    b
) {
    if (
        typeof a !==
        'string' ||
        typeof b !==
        'string'
    ) {
        return false;
    }

    const aa =
        Buffer.from(a);

    const bb =
        Buffer.from(b);

    return (
        aa.length ===
        bb.length &&
        crypto.timingSafeEqual(
            aa,
            bb
        )
    );
}

module.exports = {
    Now,

    RandomHex,
    RandomID,
    RandomNonce,
    RandomLicenseKey,
    RandomToken,

    EnsureDirs,

    NormalizeID,
    NormalizeLicenseKey,
    NormalizeVersion,

    CompareVersions,
    IsVersionAtLeast,

    SafeField,
    SafeIP,
    SendLine,

    ConstantTimeEqual
};
