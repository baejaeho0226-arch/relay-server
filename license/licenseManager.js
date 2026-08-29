'use strict';

const state =
    require(
        '../core/state'
    );

const {
    Now,
    RandomLicenseKey,
    NormalizeLicenseKey,
    NormalizeID,
    SafeField,
    SafeIP,
    SendLine
} = require(
    '../core/utils'
);

const {
    SaveDatabase
} = require(
    '../storage/database'
);

const {
    LogEvent
} = require(
    '../storage/audit'
);

const {
    GetOnlineClient,
    GetSavedClientByID
} = require(
    '../identity/identityManager'
);

const {
    NotifyServerAuthorized,
    NotifyServerUnauthorized
} = require(
    '../relay/notifications'
);


function FindLicense(
    key
) {
    key =
        NormalizeLicenseKey(
            key
        );

    if (!key) {
        return null;
    }

    return (
        state.licenses.get(
            key
        ) ||
        null
    );
}


function GetBoundLicenseEntry(
    clientId
) {
    clientId =
        NormalizeID(
            clientId
        );

    if (!clientId) {
        return null;
    }

    for (
        const [
            key,
            license
        ]
        of state.licenses
    ) {
        if (
            license.boundClient ===
            clientId
        ) {
            return {
                key,
                license
            };
        }
    }

    return null;
}


function GetLicenseStatus(
    license
) {
    if (!license) {
        return 'UNKNOWN';
    }

    if (
        license.suspended
    ) {
        return 'SUSPENDED';
    }

    if (
        Now() >=
        license.expiresAt
    ) {
        return 'EXPIRED';
    }

    if (
        license.boundClient
    ) {
        return 'BOUND';
    }

    return 'AVAILABLE';
}


function GetUsableLicenseForConnection(
    connection
) {
    if (
        !connection ||
        !connection.clientId ||
        !connection.licenseAuthorized ||
        !state.serviceEnabled
    ) {
        return null;
    }

    const key =
        NormalizeLicenseKey(
            connection.licenseKey
        );

    const license =
        FindLicense(
            key
        );

    if (!license) {
        return null;
    }

    if (
        license.boundClient !==
        connection.clientId
    ) {
        return null;
    }

    if (
        license.suspended
    ) {
        return null;
    }

    if (
        Now() >=
        license.expiresAt
    ) {
        return null;
    }

    return {
        key,
        license
    };
}


function CreateLicense(
    days,
    memo
) {
    days =
        Number(
            days
        );

    if (
        !Number.isInteger(
            days
        ) ||
        days <= 0
    ) {
        return null;
    }

    let key;

    do {
        key =
            RandomLicenseKey();
    } while (
        state.licenses.has(
            key
        )
    );

    const now =
        Now();

    const license = {
        createdAt:
            now,

        expiresAt:
            now +
            days *
            86400000,

        boundClient:
            '',

        boundAt:
            0,

        lastAuthAt:
            0,

        lastSeenAt:
            0,

        lastIP:
            '',

        authCount:
            0,

        sendCount:
            0,

        suspended:
            false,

        memo:
            SafeField(
                memo
            )
    };

    state.licenses.set(
        key,
        license
    );

    SaveDatabase();

    LogEvent(
        'LICENSE_CREATE',
        key
    );

    return {
        key,

        expiresAt:
            license.expiresAt
    };
}


function ExtendLicense(
    key,
    days
) {
    key =
        NormalizeLicenseKey(
            key
        );

    days =
        Number(
            days
        );

    if (
        !Number.isInteger(
            days
        ) ||
        days <= 0
    ) {
        return false;
    }

    const license =
        FindLicense(
            key
        );

    if (!license) {
        return false;
    }

    license.expiresAt =
        Math.max(
            Now(),
            license.expiresAt
        ) +
        days *
        86400000;

    if (
        license.boundClient
    ) {
        const client =
            GetOnlineClient(
                license.boundClient
            );

        if (
            client &&
            client.licenseAuthorized &&
            NormalizeLicenseKey(
                client.licenseKey
            ) === key
        ) {
            client.licenseExpiresAt =
                license.expiresAt;

            SendLine(
                client.socket,
                `LICENSE_UPDATED|${license.expiresAt}`
            );

            NotifyServerAuthorized(
                client.clientId,
                client.serverId,
                license.expiresAt
            );
        }
    }

    SaveDatabase();

    return true;
}


function RevokeLiveLicense(
    clientId,
    reason
) {
    clientId =
        NormalizeID(
            clientId
        );

    if (!clientId) {
        return;
    }

    const client =
        GetOnlineClient(
            clientId
        );

    if (
        client
    ) {
        client.licenseAuthorized =
            false;

        client.licenseExpiresAt =
            0;

        client.lastServerAuthState =
            '';

        SendLine(
            client.socket,
            `LICENSE_ERROR|${reason}`
        );
    }

    NotifyServerUnauthorized(
        clientId,
        reason
    );
}


function UnbindLicense(
    key
) {
    key =
        NormalizeLicenseKey(
            key
        );

    const license =
        FindLicense(
            key
        );

    if (!license) {
        return false;
    }

    const oldClient =
        license.boundClient;

    license.boundClient =
        '';

    license.boundAt =
        0;

    license.lastAuthAt =
        0;

    license.lastSeenAt =
        0;

    license.lastIP =
        '';

    if (
        oldClient
    ) {
        RevokeLiveLicense(
            oldClient,
            'UNBOUND'
        );
    }

    SaveDatabase();

    return true;
}


function SuspendLicense(
    key
) {
    key =
        NormalizeLicenseKey(
            key
        );

    const license =
        FindLicense(
            key
        );

    if (!license) {
        return false;
    }

    license.suspended =
        true;

    if (
        license.boundClient
    ) {
        RevokeLiveLicense(
            license.boundClient,
            'SUSPENDED'
        );
    }

    SaveDatabase();

    return true;
}


function ResumeLicense(
    key
) {
    key =
        NormalizeLicenseKey(
            key
        );

    const license =
        FindLicense(
            key
        );

    if (!license) {
        return false;
    }

    if (
        Now() >=
        license.expiresAt
    ) {
        return false;
    }

    license.suspended =
        false;

    if (
        license.boundClient
    ) {
        const client =
            GetOnlineClient(
                license.boundClient
            );

        /*
            Resume했다고 자동 인증하지 않는다.
            APK가 LICENSE_AUTH를 다시 보내야 한다.
        */
        if (
            client
        ) {
            SendLine(
                client.socket,
                `LICENSE_STATE|RESUMED|${license.expiresAt}`
            );
        }
    }

    SaveDatabase();

    return true;
}


function DeleteLicense(
    key
) {
    key =
        NormalizeLicenseKey(
            key
        );

    const license =
        FindLicense(
            key
        );

    if (!license) {
        return false;
    }

    const clientId =
        license.boundClient;

    state.licenses.delete(
        key
    );

    if (
        clientId
    ) {
        RevokeLiveLicense(
            clientId,
            'REVOKED'
        );
    }

    SaveDatabase();

    return true;
}


function ReissueLicense(
    oldKey
) {
    oldKey =
        NormalizeLicenseKey(
            oldKey
        );

    const old =
        FindLicense(
            oldKey
        );

    if (
        !old ||
        old.expiresAt <=
        Now()
    ) {
        return null;
    }

    let newKey;

    do {
        newKey =
            RandomLicenseKey();
    } while (
        state.licenses.has(
            newKey
        )
    );

    const copy = {
        ...old,

        createdAt:
            Now(),

        lastAuthAt:
            0,

        lastSeenAt:
            0,

        lastIP:
            '',

        authCount:
            0,

        sendCount:
            0,

        suspended:
            false
    };

    const oldClient =
        old.boundClient;

    state.licenses.set(
        newKey,
        copy
    );

    state.licenses.delete(
        oldKey
    );

    if (
        oldClient
    ) {
        RevokeLiveLicense(
            oldClient,
            'REISSUED'
        );
    }

    SaveDatabase();

    LogEvent(
        'LICENSE_REISSUE',
        `${oldKey} -> ${newKey}`
    );

    return {
        oldKey,
        newKey,

        expiresAt:
            copy.expiresAt
    };
}


function TransferLicense(
    key,
    newClientId
) {
    key =
        NormalizeLicenseKey(
            key
        );

    newClientId =
        NormalizeID(
            newClientId
        );

    const license =
        FindLicense(
            key
        );

    if (!license) {
        return {
            ok: false,
            reason: 'NOT_FOUND'
        };
    }

    if (
        !GetSavedClientByID(
            newClientId
        )
    ) {
        return {
            ok: false,
            reason: 'CLIENT_NOT_FOUND'
        };
    }

    /*
        Client 하나에는 License 하나만.
    */
    const existing =
        GetBoundLicenseEntry(
            newClientId
        );

    if (
        existing &&
        existing.key !==
        key
    ) {
        return {
            ok: false,
            reason: 'CLIENT_ALREADY_LICENSED'
        };
    }

    const oldClient =
        license.boundClient;

    license.boundClient =
        newClientId;

    license.boundAt =
        Now();

    license.lastAuthAt =
        0;

    license.lastSeenAt =
        0;

    license.lastIP =
        '';

    if (
        oldClient &&
        oldClient !==
        newClientId
    ) {
        RevokeLiveLicense(
            oldClient,
            'TRANSFERRED'
        );
    }

    /*
        대상 Client에 이전됐다고 해서
        서버가 자동 인증하면 안 된다.
    */
    const target =
        GetOnlineClient(
            newClientId
        );

    if (
        target
    ) {
        target.licenseAuthorized =
            false;

        target.licenseExpiresAt =
            0;

        target.lastServerAuthState =
            '';

        NotifyServerUnauthorized(
            newClientId,
            'LICENSE_REQUIRED'
        );
    }

    SaveDatabase();

    LogEvent(
        'LICENSE_TRANSFER',
        `${key} -> ${newClientId}`
    );

    return {
        ok: true
    };
}


function AuthorizeClient(
    connection,
    licenseKey
) {
    if (
        !state.serviceEnabled
    ) {
        SendLine(
            connection.socket,
            'SERVICE_STATE|DISABLED'
        );

        return false;
    }

    /*
        Maintenance:
        기존 인증 세션은 유지.
        신규 LICENSE_AUTH만 차단.
    */
    if (
        state.maintenanceMode &&
        !connection.licenseAuthorized
    ) {
        SendLine(
            connection.socket,
            'SERVICE_STATE|MAINTENANCE'
        );

        return false;
    }

    if (
        !connection.connected ||
        !connection.clientId
    ) {
        SendLine(
            connection.socket,
            'LICENSE_ERROR|CLIENT_NOT_CONNECTED'
        );

        return false;
    }

    licenseKey =
        NormalizeLicenseKey(
            licenseKey
        );

    const license =
        FindLicense(
            licenseKey
        );

    if (
        !licenseKey ||
        !license
    ) {
        SendLine(
            connection.socket,
            'LICENSE_ERROR|INVALID_KEY'
        );

        return false;
    }

    if (
        license.suspended
    ) {
        SendLine(
            connection.socket,
            'LICENSE_ERROR|SUSPENDED'
        );

        NotifyServerUnauthorized(
            connection.clientId,
            'SUSPENDED'
        );

        return false;
    }

    if (
        Now() >=
        license.expiresAt
    ) {
        SendLine(
            connection.socket,
            'LICENSE_ERROR|EXPIRED'
        );

        NotifyServerUnauthorized(
            connection.clientId,
            'EXPIRED'
        );

        return false;
    }

    if (
        license.boundClient &&
        license.boundClient !==
        connection.clientId
    ) {
        SendLine(
            connection.socket,
            'LICENSE_ERROR|BOUND_OTHER'
        );

        return false;
    }

    /*
        같은 Client가 다른 License를
        이미 소유하고 있는지 검사.
    */
    const already =
        GetBoundLicenseEntry(
            connection.clientId
        );

    if (
        already &&
        already.key !==
        licenseKey
    ) {
        SendLine(
            connection.socket,
            'LICENSE_ERROR|CLIENT_ALREADY_LICENSED'
        );

        return false;
    }

    if (
        !license.boundClient
    ) {
        license.boundClient =
            connection.clientId;

        license.boundAt =
            Now();

        LogEvent(
            'LICENSE_BOUND',
            `${licenseKey} -> ${connection.clientId}`
        );
    }

    license.lastAuthAt =
        Now();

    license.lastSeenAt =
        Now();

    license.lastIP =
        SafeIP(
            connection.socket
        );

    license.authCount =
        Number(
            license.authCount ||
            0
        ) + 1;

    const saved =
        GetSavedClientByID(
            connection.clientId
        );

    if (
        saved
    ) {
        saved.lastAuthAt =
            Now();

        saved.lastSeenAt =
            Now();

        saved.lastIP =
            license.lastIP;

        saved.authCount =
            Number(
                saved.authCount ||
                0
            ) + 1;
    }

    connection.licenseAuthorized =
        true;

    connection.licenseKey =
        licenseKey;

    connection.licenseExpiresAt =
        license.expiresAt;

    connection.lastServerAuthState =
        '';

    SaveDatabase();

    SendLine(
        connection.socket,
        `LICENSE_OK|${licenseKey}|${license.expiresAt}`
    );

    NotifyServerAuthorized(
        connection.clientId,
        connection.serverId,
        license.expiresAt
    );

    const remainingDays =
        Math.ceil(
            (
                license.expiresAt -
                Now()
            ) /
            86400000
        );

    if (
        remainingDays <= 7
    ) {
        SendLine(
            connection.socket,
            `LICENSE_WARNING|${remainingDays}|${license.expiresAt}`
        );

        connection.lastExpiryWarningDay =
            remainingDays;
    }

    LogEvent(
        'LICENSE_AUTH',
        `${licenseKey} -> ${connection.clientId}`
    );

    return true;
}


function ValidateClientLicense(
    connection
) {
    if (
        !connection ||
        !connection.connected ||
        !connection.clientId ||
        !connection.licenseAuthorized
    ) {
        return;
    }

    /*
        SERVICE STOP은 이미 세션을 revoke한다.
        Stop 상태에서 반복 검증 불필요.
    */
    if (
        !state.serviceEnabled
    ) {
        return;
    }

    /*
        Maintenance는 기존 인증을 무효화하지 않는다.
    */
    const active =
        GetUsableLicenseForConnection(
            connection
        );

    if (
        active
    ) {
        if (
            connection.licenseExpiresAt !==
            active.license.expiresAt
        ) {
            connection.licenseExpiresAt =
                active.license.expiresAt;

            SendLine(
                connection.socket,
                `LICENSE_UPDATED|${active.license.expiresAt}`
            );
        }

        const remainingDays =
            Math.ceil(
                (
                    active.license.expiresAt -
                    Now()
                ) /
                86400000
            );

        if (
            remainingDays <= 7 &&
            connection.lastExpiryWarningDay !==
            remainingDays
        ) {
            connection.lastExpiryWarningDay =
                remainingDays;

            SendLine(
                connection.socket,
                `LICENSE_WARNING|${remainingDays}|${active.license.expiresAt}`
            );
        }

        return;
    }

    const bound =
        GetBoundLicenseEntry(
            connection.clientId
        );

    connection.licenseAuthorized =
        false;

    connection.licenseExpiresAt =
        0;

    connection.lastServerAuthState =
        '';

    if (
        bound &&
        bound.license.suspended
    ) {
        SendLine(
            connection.socket,
            'LICENSE_ERROR|SUSPENDED'
        );

        NotifyServerUnauthorized(
            connection.clientId,
            'SUSPENDED'
        );

        return;
    }

    if (
        bound &&
        Now() >=
        bound.license.expiresAt
    ) {
        SendLine(
            connection.socket,
            'LICENSE_ERROR|EXPIRED'
        );

        NotifyServerUnauthorized(
            connection.clientId,
            'EXPIRED'
        );

        return;
    }

    SendLine(
        connection.socket,
        'LICENSE_ERROR|LICENSE_REQUIRED'
    );

    NotifyServerUnauthorized(
        connection.clientId,
        'LICENSE_REQUIRED'
    );
}


function SearchLicenses(
    query,
    status,
    maxResults
) {
    query =
        String(
            query ||
            ''
        )
            .trim()
            .toUpperCase();

    status =
        String(
            status ||
            'ALL'
        )
            .trim()
            .toUpperCase();

    maxResults =
        Number(
            maxResults
        ) ||
        500;

    const result =
        [];

    for (
        const [
            key,
            license
        ]
        of state.licenses
    ) {
        const currentStatus =
            GetLicenseStatus(
                license
            );

        if (
            status !== 'ALL' &&
            currentStatus !==
            status
        ) {
            continue;
        }

        if (
            query &&
            !(
                `${key}|${license.boundClient}|${license.memo}`
            )
                .toUpperCase()
                .includes(
                    query
                )
        ) {
            continue;
        }

        result.push({
            key,
            license
        });

        if (
            result.length >=
            maxResults
        ) {
            break;
        }
    }

    return result;
}


module.exports = {
    FindLicense,
    GetBoundLicenseEntry,
    GetLicenseStatus,
    GetUsableLicenseForConnection,

    CreateLicense,
    ExtendLicense,

    RevokeLiveLicense,

    UnbindLicense,
    SuspendLicense,
    ResumeLicense,
    DeleteLicense,

    ReissueLicense,
    TransferLicense,

    AuthorizeClient,
    ValidateClientLicense,

    SearchLicenses
};
