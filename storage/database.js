'use strict';

const fs =
    require(
        'fs'
    );

const path =
    require(
        'path'
    );

const config =
    require(
        '../config/config'
    );

const state =
    require(
        '../core/state'
    );

const {
    DB_FILE,
    DB_BAK_FILE,
    BACKUP_DIR,
    CURRENT_PROTOCOL_VERSION
} = config;

const {
    serverIdentities,
    clientIdentities,
    licenses,

    disabledServers,
    drainingServers,
    disabledClients
} = state;

const {
    EnsureDirs,
    NormalizeID,
    NormalizeLicenseKey,
    NormalizeVersion,
    Now,
    SafeField
} = require(
    '../core/utils'
);

function LogEvent(
    ...args
) {
    return require(
        './audit'
    ).LogEvent(
        ...args
    );
}

function BuildDatabaseObject() {
    return {
        version:
            100,

        serviceEnabled:
            state.serviceEnabled,

        maintenanceMode:
            state.maintenanceMode,

        minProtocolVersion:
            state.minProtocolVersion,

        minServerVersion:
            state.minServerVersion,

        minClientVersion:
            state.minClientVersion,

        maintenanceSchedule:
            state.maintenanceSchedule,

        disabledServers:
            Array.from(
                disabledServers
            ),

        drainingServers:
            Array.from(
                drainingServers
            ),

        disabledClients:
            Array.from(
                disabledClients
            ),

        servers:
            Object.fromEntries(
                serverIdentities
            ),

        clients:
            Object.fromEntries(
                clientIdentities
            ),

        licenses:
            Object.fromEntries(
                licenses
            )
    };
}

function SaveDatabase() {
    const tmp =
        DB_FILE +
        '.tmp';

    try {
        const text =
            JSON.stringify(
                BuildDatabaseObject(),
                null,
                2
            );

        if (
            fs.existsSync(
                DB_FILE
            )
        ) {
            try {
                fs.copyFileSync(
                    DB_FILE,
                    DB_BAK_FILE
                );
            } catch (_) {}
        }

        fs.writeFileSync(
            tmp,
            text,
            'utf8'
        );

        fs.renameSync(
            tmp,
            DB_FILE
        );

        return true;
    } catch (
        error
    ) {
        console.error(
            'DATABASE SAVE ERROR:',
            error.message
        );

        try {
            if (
                fs.existsSync(
                    tmp
                )
            ) {
                fs.unlinkSync(
                    tmp
                );
            }
        } catch (_) {}

        return false;
    }
}

function ImportDatabaseObject(data) {
    if (
        !data ||
        typeof data !==
        'object'
    ) {
        return false;
    }

    const newServers =
        new Map();

    const newClients =
        new Map();

    const newLicenses =
        new Map();

    const used =
        new Set();

    if (
        data.servers &&
        typeof data.servers ===
        'object'
    ) {
        for (
            const [
                deviceKey,
                rawId
            ]
            of Object.entries(
                data.servers
            )
        ) {
            const key =
                String(
                    deviceKey ||
                    ''
                ).trim();

            const id =
                NormalizeID(
                    rawId
                );

            if (
                !key ||
                !id ||
                used.has(id)
            ) {
                continue;
            }

            newServers.set(
                key,
                id
            );

            used.add(
                id
            );
        }
    }

    if (
        data.clients &&
        typeof data.clients ===
        'object'
    ) {
        for (
            const [
                deviceKey,
                value
            ]
            of Object.entries(
                data.clients
            )
        ) {
            if (
                !value ||
                typeof value !==
                'object'
            ) {
                continue;
            }

            const key =
                String(
                    deviceKey ||
                    ''
                ).trim();

            const id =
                NormalizeID(
                    value.id ||
                    value.clientId
                );

            const serverId =
                NormalizeID(
                    value.serverId
                );

            if (
                !key ||
                !id ||
                !serverId ||
                used.has(id)
            ) {
                continue;
            }

            newClients.set(
                key,
                {
                    id,
                    serverId,

                    createdAt:
                        Number(
                            value.createdAt
                        ) ||
                        Now(),

                    lastSeenAt:
                        Number(
                            value.lastSeenAt
                        ) ||
                        0,

                    lastAuthAt:
                        Number(
                            value.lastAuthAt
                        ) ||
                        0,

                    lastIP:
                        String(
                            value.lastIP ||
                            ''
                        ),

                    authCount:
                        Number(
                            value.authCount
                        ) ||
                        0,

                    sendCount:
                        Number(
                            value.sendCount
                        ) ||
                        0,

                    reconnectCount:
                        Number(
                            value.reconnectCount
                        ) ||
                        0
                }
            );

            used.add(
                id
            );
        }
    }

    if (
        data.licenses &&
        typeof data.licenses ===
        'object'
    ) {
        for (
            const [
                rawKey,
                value
            ]
            of Object.entries(
                data.licenses
            )
        ) {
            if (
                !value ||
                typeof value !==
                'object'
            ) {
                continue;
            }

            const key =
                NormalizeLicenseKey(
                    rawKey
                );

            const expiresAt =
                Number(
                    value.expiresAt
                );

            if (
                !key ||
                !Number.isFinite(
                    expiresAt
                ) ||
                expiresAt <= 0
            ) {
                continue;
            }

            newLicenses.set(
                key,
                {
                    createdAt:
                        Number(
                            value.createdAt
                        ) ||
                        Now(),

                    expiresAt,

                    boundClient:
                        NormalizeID(
                            value.boundClient ||
                            ''
                        ),

                    boundAt:
                        Number(
                            value.boundAt
                        ) ||
                        0,

                    lastAuthAt:
                        Number(
                            value.lastAuthAt
                        ) ||
                        0,

                    lastSeenAt:
                        Number(
                            value.lastSeenAt
                        ) ||
                        0,

                    lastIP:
                        String(
                            value.lastIP ||
                            ''
                        ),

                    authCount:
                        Number(
                            value.authCount
                        ) ||
                        0,

                    sendCount:
                        Number(
                            value.sendCount
                        ) ||
                        0,

                    suspended:
                        Boolean(
                            value.suspended
                        ),

                    memo:
                        SafeField(
                            value.memo ||
                            ''
                        )
                }
            );
        }
    }

    serverIdentities.clear();
    clientIdentities.clear();
    licenses.clear();

    disabledServers.clear();
    drainingServers.clear();
    disabledClients.clear();

    for (
        const [
            key,
            value
        ]
        of newServers
    ) {
        serverIdentities.set(
            key,
            value
        );
    }

    for (
        const [
            key,
            value
        ]
        of newClients
    ) {
        clientIdentities.set(
            key,
            value
        );
    }

    for (
        const [
            key,
            value
        ]
        of newLicenses
    ) {
        licenses.set(
            key,
            value
        );
    }

    for (
        const id
        of Array.isArray(
            data.disabledServers
        )
            ? data.disabledServers
            : []
    ) {
        const normalized =
            NormalizeID(id);

        if (
            normalized
        ) {
            disabledServers.add(
                normalized
            );
        }
    }

    for (
        const id
        of Array.isArray(
            data.drainingServers
        )
            ? data.drainingServers
            : []
    ) {
        const normalized =
            NormalizeID(id);

        if (
            normalized
        ) {
            drainingServers.add(
                normalized
            );
        }
    }

    for (
        const id
        of Array.isArray(
            data.disabledClients
        )
            ? data.disabledClients
            : []
    ) {
        const normalized =
            NormalizeID(id);

        if (
            normalized
        ) {
            disabledClients.add(
                normalized
            );
        }
    }

    if (
        typeof data.serviceEnabled ===
        'boolean'
    ) {
        state.serviceEnabled =
            data.serviceEnabled;
    }

    if (
        typeof data.maintenanceMode ===
        'boolean'
    ) {
        state.maintenanceMode =
            data.maintenanceMode;
    }

    const protocol =
        Number(
            data.minProtocolVersion
        );

    if (
        Number.isInteger(
            protocol
        ) &&
        protocol >= 1 &&
        protocol <=
        CURRENT_PROTOCOL_VERSION
    ) {
        state.minProtocolVersion =
            protocol;
    }

    const serverVersion =
        NormalizeVersion(
            data.minServerVersion
        );

    const clientVersion =
        NormalizeVersion(
            data.minClientVersion
        );

    if (
        serverVersion
    ) {
        state.minServerVersion =
            serverVersion;
    }

    if (
        clientVersion
    ) {
        state.minClientVersion =
            clientVersion;
    }

    if (
        data.maintenanceSchedule &&
        typeof data.maintenanceSchedule ===
        'object'
    ) {
        const startAt =
            Number(
                data
                    .maintenanceSchedule
                    .startAt
            );

        const endAt =
            Number(
                data
                    .maintenanceSchedule
                    .endAt
            );

        if (
            startAt > 0 &&
            endAt >
            startAt
        ) {
            state.maintenanceSchedule = {
                startAt,
                endAt,

                message:
                    SafeField(
                        data
                            .maintenanceSchedule
                            .message ||
                        'Scheduled maintenance'
                    )
            };
        }
    } else {
        state.maintenanceSchedule =
            null;
    }

    return true;
}

function LatestBackupFile() {
    try {
        const files =
            fs
                .readdirSync(
                    BACKUP_DIR
                )
                .filter(
                    x =>
                        x.endsWith(
                            '.json'
                        )
                )
                .map(
                    file => ({
                        file,

                        time:
                            fs
                                .statSync(
                                    path.join(
                                        BACKUP_DIR,
                                        file
                                    )
                                )
                                .mtimeMs
                    })
                )
                .sort(
                    (
                        a,
                        b
                    ) =>
                        b.time -
                        a.time
                );

        return files.length
            ? path.join(
                BACKUP_DIR,
                files[0].file
            )
            : '';
    } catch (_) {
        return '';
    }
}

function TryLoadJson(file) {
    try {
        return JSON.parse(
            fs.readFileSync(
                file,
                'utf8'
            )
        );
    } catch (_) {
        return null;
    }
}

function LoadDatabase() {
    EnsureDirs();

    const candidates = [
        DB_FILE,
        DB_BAK_FILE,
        LatestBackupFile()
    ].filter(
        Boolean
    );

    for (
        const file
        of candidates
    ) {
        if (
            !fs.existsSync(
                file
            )
        ) {
            continue;
        }

        const data =
            TryLoadJson(
                file
            );

        if (
            data &&
            ImportDatabaseObject(
                data
            )
        ) {
            if (
                file !==
                DB_FILE
            ) {
                LogEvent(
                    'DATABASE_AUTO_RECOVER',
                    path.basename(
                        file
                    )
                );
            }

            SaveDatabase();

            return;
        }
    }

    SaveDatabase();
}

module.exports = {
    BuildDatabaseObject,
    SaveDatabase,

    ImportDatabaseObject,

    LatestBackupFile,
    TryLoadJson,
    LoadDatabase
};
