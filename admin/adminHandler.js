'use strict';

const config = require('../config/config');
const state = require('../core/state');

const {
    ADMIN_SESSION_TIMEOUT_MS,
    SERVER_KICK_BLOCK_MS,
    CLIENT_KICK_BLOCK_MS,
    MAX_BULK_KEYS,
    MAX_SEARCH_RESULTS
} = config;

const {
    Now,
    NormalizeID,
    NormalizeLicenseKey,
    SafeField,
    SendLine
} = require('../core/utils');

const {
    SaveDatabase
} = require('../storage/database');

const {
    CreateBackup,
    RestoreBackup,
    ListBackups,
    DeleteBackup
} = require('../storage/backup');

const {
    LogEvent,
    AuditSearch
} = require('../storage/audit');

const {
    GetOnlineServer,
    GetOnlineClient,
    GetSavedClientByID,
    FindClientDeviceKey,
    FindServerDeviceKey,
    ServerExists,
    ClientExists,
    GetKickUntil,
    ClientMove
} = require('../identity/identityManager');

const {
    FindLicense,
    GetBoundLicenseEntry,
    GetLicenseStatus,
    CreateLicense,
    ExtendLicense,
    UnbindLicense,
    SuspendLicense,
    ResumeLicense,
    DeleteLicense,
    ReissueLicense,
    TransferLicense,
    SearchLicenses
} = require('../license/licenseManager');

const {
    NotifyServerUnauthorized,
    NoticeAll,
    NoticeClient
} = require('../relay/notifications');

const {
    ServerHealth,
    ClientHealth
} = require('../relay/heartbeat');

const {
    BuildDashboardLine,
    GetRecentDashboardEvents
} = require('../services/dashboard');

const {
    GetVersionPolicy,
    SetVersionPolicy,
    EnforceVersionPolicy
} = require('../services/versionPolicy');

const {
    ServiceStop,
    ServiceStart,
    MaintenanceOn,
    MaintenanceOff,
    SetMaintenanceSchedule,
    ClearMaintenanceSchedule,
    GetMaintenanceSchedule
} = require('../services/maintenance');

const {
    AdminAllowed,
    HandleAdminHello,
    HandleAdminAuth,
    IsDangerousCommand,
    PrepareConfirm,
    ConsumeConfirm
} = require('./auth');


function SendLicenseItem(socket, key, license) {
    SendLine(
        socket,
        [
            'LIC_ITEM',
            key,
            GetLicenseStatus(license),
            license.expiresAt,
            license.boundClient || '',
            SafeField(license.memo),
            license.createdAt,
            license.boundAt,
            license.lastAuthAt,
            license.lastSeenAt,
            license.lastIP,
            license.authCount,
            license.sendCount
        ].join('|')
    );
}


function ExecuteAdminCommand(
    connection,
    line,
    confirmed = false
) {
    if (
        IsDangerousCommand(line) &&
        !confirmed
    ) {
        SendLine(
            connection.socket,
            'ADMIN_ERROR|CONFIRM_REQUIRED'
        );

        return;
    }

    /*
        WHOAMI
    */
    if (line === 'WHOAMI') {
        SendLine(
            connection.socket,
            `ADMIN_ROLE|${connection.adminRole}`
        );

        return;
    }

    /*
        VERSION
    */
    if (line === 'VERSION_STATUS') {
        const p =
            GetVersionPolicy();

        SendLine(
            connection.socket,
            `VERSION_STATUS|${p.minProtocolVersion}|${p.minServerVersion}|${p.minClientVersion}`
        );

        return;
    }

    if (line.startsWith('VERSION_SET|')) {
        if (connection.adminRole !== 'admin') {
            SendLine(
                connection.socket,
                'ADMIN_ERROR|FORBIDDEN'
            );

            return;
        }

        const p =
            line.split('|');

        const result =
            SetVersionPolicy(
                p[1],
                p[2],
                p[3]
            );

        if (!result.ok) {
            SendLine(
                connection.socket,
                'VERSION_ERROR|INVALID'
            );

            return;
        }

        SendLine(
            connection.socket,
            `VERSION_SET_OK|${result.protocolVersion}|${result.serverVersion}|${result.clientVersion}`
        );

        setTimeout(
            () =>
                EnforceVersionPolicy(),
            250
        );

        return;
    }

    /*
        LICENSE CREATE
    */
    if (line.startsWith('LIC_CREATE|')) {
        if (connection.adminRole !== 'admin') {
            SendLine(
                connection.socket,
                'ADMIN_ERROR|FORBIDDEN'
            );

            return;
        }

        const p =
            line.split('|');

        const days =
            Number(p[1]);

        if (
            !Number.isInteger(days) ||
            days <= 0 ||
            days > 36500
        ) {
            SendLine(
                connection.socket,
                'LIC_ERROR|INVALID_DAYS'
            );

            return;
        }

        const created =
            CreateLicense(
                days,
                p.slice(2).join('|')
            );

        if (!created) {
            SendLine(
                connection.socket,
                'LIC_ERROR|CREATE_FAILED'
            );

            return;
        }

        SendLine(
            connection.socket,
            `LIC_OK|${created.key}|${created.expiresAt}`
        );

        return;
    }

    /*
        LICENSE LIST
    */
    if (line === 'LIC_LIST') {
        if (
            !AdminAllowed(
                connection.adminRole,
                'LIST'
            )
        ) {
            SendLine(
                connection.socket,
                'ADMIN_ERROR|FORBIDDEN'
            );

            return;
        }

        for (
            const [
                key,
                license
            ]
            of state.licenses
        ) {
            SendLicenseItem(
                connection.socket,
                key,
                license
            );
        }

        SendLine(
            connection.socket,
            'END_LIST'
        );

        return;
    }

    /*
        LICENSE SEARCH
    */
    if (line.startsWith('LIC_SEARCH|')) {
        if (
            !AdminAllowed(
                connection.adminRole,
                'SEARCH'
            )
        ) {
            SendLine(
                connection.socket,
                'ADMIN_ERROR|FORBIDDEN'
            );

            return;
        }

        const p =
            line.split('|');

        const result =
            SearchLicenses(
                p[1] || '',
                p[2] || 'ALL',
                MAX_SEARCH_RESULTS
            );

        for (
            const item
            of result
        ) {
            SendLicenseItem(
                connection.socket,
                item.key,
                item.license
            );
        }

        SendLine(
            connection.socket,
            'END_SEARCH'
        );

        return;
    }

    /*
        EXTEND
    */
    if (line.startsWith('LIC_EXTEND|')) {
        if (
            !AdminAllowed(
                connection.adminRole,
                'EXTEND'
            )
        ) {
            SendLine(
                connection.socket,
                'ADMIN_ERROR|FORBIDDEN'
            );

            return;
        }

        const p =
            line.split('|');

        const key =
            NormalizeLicenseKey(
                p[1]
            );

        const days =
            Number(
                p[2]
            );

        if (
            !Number.isInteger(days) ||
            days <= 0 ||
            days > 36500
        ) {
            SendLine(
                connection.socket,
                'LIC_ERROR|INVALID_DAYS'
            );

            return;
        }

        if (
            !ExtendLicense(
                key,
                days
            )
        ) {
            SendLine(
                connection.socket,
                'LIC_ERROR|NOT_FOUND'
            );

            return;
        }

        const license =
            FindLicense(
                key
            );

        SendLine(
            connection.socket,
            `LIC_EXTEND_OK|${key}|${license ? license.expiresAt : 0}`
        );

        LogEvent(
            'LICENSE_EXTEND',
            `${key} +${days}`
        );

        return;
    }

    /*
        UNBIND
    */
    if (line.startsWith('LIC_UNBIND|')) {
        if (
            !AdminAllowed(
                connection.adminRole,
                'UNBIND'
            )
        ) {
            SendLine(
                connection.socket,
                'ADMIN_ERROR|FORBIDDEN'
            );

            return;
        }

        const key =
            NormalizeLicenseKey(
                line.split('|')[1] ||
                ''
            );

        if (
            !UnbindLicense(
                key
            )
        ) {
            SendLine(
                connection.socket,
                'LIC_ERROR|NOT_FOUND'
            );

            return;
        }

        SendLine(
            connection.socket,
            `LIC_UNBIND_OK|${key}`
        );

        LogEvent(
            'LICENSE_UNBIND',
            key
        );

        return;
    }

    /*
        SUSPEND
    */
    if (line.startsWith('LIC_SUSPEND|')) {
        if (
            !AdminAllowed(
                connection.adminRole,
                'SUSPEND'
            )
        ) {
            SendLine(
                connection.socket,
                'ADMIN_ERROR|FORBIDDEN'
            );

            return;
        }

        const key =
            NormalizeLicenseKey(
                line.split('|')[1] ||
                ''
            );

        if (
            !SuspendLicense(
                key
            )
        ) {
            SendLine(
                connection.socket,
                'LIC_ERROR|NOT_FOUND'
            );

            return;
        }

        SendLine(
            connection.socket,
            `LIC_SUSPEND_OK|${key}`
        );

        LogEvent(
            'LICENSE_SUSPEND',
            key
        );

        return;
    }

    /*
        RESUME
    */
    if (line.startsWith('LIC_RESUME|')) {
        if (
            !AdminAllowed(
                connection.adminRole,
                'RESUME'
            )
        ) {
            SendLine(
                connection.socket,
                'ADMIN_ERROR|FORBIDDEN'
            );

            return;
        }

        const key =
            NormalizeLicenseKey(
                line.split('|')[1] ||
                ''
            );

        if (
            !ResumeLicense(
                key
            )
        ) {
            SendLine(
                connection.socket,
                'LIC_ERROR|NOT_FOUND_OR_EXPIRED'
            );

            return;
        }

        SendLine(
            connection.socket,
            `LIC_RESUME_OK|${key}`
        );

        LogEvent(
            'LICENSE_RESUME',
            key
        );

        return;
    }

    /*
        REISSUE
    */
    if (line.startsWith('LIC_REISSUE|')) {
        if (connection.adminRole !== 'admin') {
            SendLine(
                connection.socket,
                'ADMIN_ERROR|FORBIDDEN'
            );

            return;
        }

        const result =
            ReissueLicense(
                line.split('|')[1] ||
                ''
            );

        if (!result) {
            SendLine(
                connection.socket,
                'LIC_ERROR|REISSUE_FAILED'
            );

            return;
        }

        SendLine(
            connection.socket,
            `LIC_REISSUE_OK|${result.oldKey}|${result.newKey}|${result.expiresAt}`
        );

        return;
    }

    /*
        TRANSFER
    */
    if (line.startsWith('LIC_TRANSFER|')) {
        if (
            !AdminAllowed(
                connection.adminRole,
                'TRANSFER'
            )
        ) {
            SendLine(
                connection.socket,
                'ADMIN_ERROR|FORBIDDEN'
            );

            return;
        }

        const p =
            line.split('|');

        const result =
            TransferLicense(
                p[1] || '',
                p[2] || ''
            );

        if (!result.ok) {
            SendLine(
                connection.socket,
                `LIC_ERROR|${result.reason}`
            );

            return;
        }

        SendLine(
            connection.socket,
            `LIC_TRANSFER_OK|${NormalizeLicenseKey(p[1])}|${NormalizeID(p[2])}`
        );

        return;
    }

    /*
        BULK
    */
    const bulkDefs = [
        [
            'LIC_BULK_EXTEND|',
            'EXTEND'
        ],
        [
            'LIC_BULK_UNBIND|',
            'UNBIND'
        ],
        [
            'LIC_BULK_SUSPEND|',
            'SUSPEND'
        ],
        [
            'LIC_BULK_RESUME|',
            'RESUME'
        ],
        [
            'LIC_BULK_DELETE|',
            'DELETE'
        ]
    ];

    for (
        const [
            prefix,
            operation
        ]
        of bulkDefs
    ) {
        if (
            !line.startsWith(
                prefix
            )
        ) {
            continue;
        }

        if (
            operation === 'DELETE'
                ? connection.adminRole !== 'admin'
                : !AdminAllowed(
                    connection.adminRole,
                    operation
                )
        ) {
            SendLine(
                connection.socket,
                'ADMIN_ERROR|FORBIDDEN'
            );

            return;
        }

        const p =
            line.split('|');

        let days =
            0;

        let keys;

        if (operation === 'EXTEND') {
            days =
                Number(
                    p[1]
                );

            keys =
                p.slice(2);

            if (
                !Number.isInteger(days) ||
                days <= 0
            ) {
                SendLine(
                    connection.socket,
                    'LIC_ERROR|INVALID_DAYS'
                );

                return;
            }
        } else {
            keys =
                p.slice(1);
        }

        keys =
            keys
                .map(
                    NormalizeLicenseKey
                )
                .filter(
                    Boolean
                )
                .slice(
                    0,
                    MAX_BULK_KEYS
                );

        let success =
            0;

        for (
            const key
            of keys
        ) {
            if (
                operation === 'EXTEND' &&
                ExtendLicense(
                    key,
                    days
                )
            ) {
                success++;
            } else if (
                operation === 'UNBIND' &&
                UnbindLicense(
                    key
                )
            ) {
                success++;
            } else if (
                operation === 'SUSPEND' &&
                SuspendLicense(
                    key
                )
            ) {
                success++;
            } else if (
                operation === 'RESUME' &&
                ResumeLicense(
                    key
                )
            ) {
                success++;
            } else if (
                operation === 'DELETE' &&
                DeleteLicense(
                    key
                )
            ) {
                success++;
            }
        }

        SendLine(
            connection.socket,
            `${prefix.slice(0, -1)}_OK|${success}|${keys.length}`
        );

        return;
    }

    /*
        DASHBOARD
    */
    if (line === 'DASHBOARD') {
        if (
            !AdminAllowed(
                connection.adminRole,
                'DASHBOARD'
            )
        ) {
            SendLine(
                connection.socket,
                'ADMIN_ERROR|FORBIDDEN'
            );

            return;
        }

        SendLine(
            connection.socket,
            BuildDashboardLine()
        );

        for (
            const event
            of GetRecentDashboardEvents(
                20
            )
        ) {
            SendLine(
                connection.socket,
                `EVENT|${event.time}|${event.type}|${event.detail}`
            );
        }

        SendLine(
            connection.socket,
            'END_DASHBOARD'
        );

        return;
    }

    /*
        SERVER LIST
    */
    if (line === 'SERVER_LIST') {
        if (
            !AdminAllowed(
                connection.adminRole,
                'SERVER_LIST'
            )
        ) {
            SendLine(
                connection.socket,
                'ADMIN_ERROR|FORBIDDEN'
            );

            return;
        }

        for (
            const [
                deviceKey,
                serverId
            ]
            of state.serverIdentities
        ) {
            const live =
                GetOnlineServer(
                    serverId
                );

            const kickedUntil =
                GetKickUntil(
                    state.kickedServers,
                    serverId
                );

            let status =
                live
                    ? 'ONLINE'
                    : 'OFFLINE';

            if (
                state.disabledServers.has(
                    serverId
                )
            ) {
                status =
                    'DISABLED';
            } else if (
                state.drainingServers.has(
                    serverId
                )
            ) {
                status =
                    'DRAINING';
            } else if (
                kickedUntil >
                Now()
            ) {
                status =
                    'KICKED';
            }

            SendLine(
                connection.socket,
                [
                    'SERVER_ITEM',
                    serverId,
                    status,

                    live
                        ? live.clients.size
                        : 0,

                    deviceKey,

                    live
                        ? live.lastIP
                        : '',

                    live
                        ? live.lastSeen
                        : 0,

                    kickedUntil,

                    live
                        ? live.protocolVersion
                        : 0,

                    live
                        ? live.appVersion
                        : '',

                    live
                        ? live.rttMs
                        : -1,

                    live
                        ? ServerHealth(
                            live
                        )
                        : 'OFFLINE',

                    state
                        .runtimeStats
                        .serverReconnects
                        .get(
                            serverId
                        ) ||
                    0
                ].join('|')
            );
        }

        SendLine(
            connection.socket,
            'END_SERVER_LIST'
        );

        return;
    }

    /*
        CLIENT LIST
    */
    if (line === 'CLIENT_LIST') {
        if (
            !AdminAllowed(
                connection.adminRole,
                'CLIENT_LIST'
            )
        ) {
            SendLine(
                connection.socket,
                'ADMIN_ERROR|FORBIDDEN'
            );

            return;
        }

        for (
            const [
                deviceKey,
                saved
            ]
            of state.clientIdentities
        ) {
            const live =
                GetOnlineClient(
                    saved.id
                );

            const boundLic =
                GetBoundLicenseEntry(
                    saved.id
                );

            const kickedUntil =
                GetKickUntil(
                    state.kickedClients,
                    saved.id
                );

            let status =
                live
                    ? 'ONLINE'
                    : 'OFFLINE';

            if (
                state.disabledClients.has(
                    saved.id
                )
            ) {
                status =
                    'DISABLED';
            } else if (
                kickedUntil >
                Now()
            ) {
                status =
                    'KICKED';
            }

            SendLine(
                connection.socket,
                [
                    'CLIENT_ITEM',
                    saved.id,
                    deviceKey,
                    saved.serverId,
                    status,

                    boundLic
                        ? GetLicenseStatus(
                            boundLic.license
                        )
                        : 'NONE',

                    boundLic
                        ? boundLic.key
                        : '',

                    boundLic
                        ? boundLic
                            .license
                            .expiresAt
                        : 0,

                    saved.lastAuthAt,
                    saved.lastSeenAt,
                    saved.lastIP,
                    saved.authCount,
                    saved.sendCount,
                    saved.reconnectCount,

                    live
                        ? live.protocolVersion
                        : 0,

                    live
                        ? live.appVersion
                        : '',

                    live
                        ? live.rttMs
                        : -1,

                    live
                        ? ClientHealth(
                            live
                        )
                        : 'OFFLINE'
                ].join('|')
            );
        }

        SendLine(
            connection.socket,
            'END_CLIENT_LIST'
        );

        return;
    }

    /*
        CLIENT DETAIL
    */
    if (line.startsWith('CLIENT_DETAIL|')) {
        if (
            !AdminAllowed(
                connection.adminRole,
                'CLIENT_DETAIL'
            )
        ) {
            SendLine(
                connection.socket,
                'ADMIN_ERROR|FORBIDDEN'
            );

            return;
        }

        const clientId =
            NormalizeID(
                line.split('|')[1] ||
                ''
            );

        const saved =
            GetSavedClientByID(
                clientId
            );

        if (!saved) {
            SendLine(
                connection.socket,
                'CLIENT_ERROR|NOT_FOUND'
            );

            SendLine(
                connection.socket,
                'END_CLIENT_DETAIL'
            );

            return;
        }

        const live =
            GetOnlineClient(
                clientId
            );

        const license =
            GetBoundLicenseEntry(
                clientId
            );

        SendLine(
            connection.socket,
            [
                'CLIENT_DETAIL_ITEM',
                clientId,

                live
                    ? 'ONLINE'
                    : 'OFFLINE',

                FindClientDeviceKey(
                    clientId
                ),

                saved.serverId,

                license
                    ? license.key
                    : '',

                license
                    ? GetLicenseStatus(
                        license.license
                    )
                    : 'NONE',

                license
                    ? license
                        .license
                        .expiresAt
                    : 0,

                saved.lastAuthAt,
                saved.lastSeenAt,
                saved.lastIP,
                saved.authCount,
                saved.sendCount,
                saved.reconnectCount,

                live
                    ? live.protocolVersion
                    : 0,

                live
                    ? live.appVersion
                    : '',

                live
                    ? live.rttMs
                    : -1,

                live
                    ? ClientHealth(
                        live
                    )
                    : 'OFFLINE'
            ].join('|')
        );

        SendLine(
            connection.socket,
            'END_CLIENT_DETAIL'
        );

        return;
    }

    /*
        SERVER TREE
    */
    if (line.startsWith('SERVER_TREE|')) {
        if (
            !AdminAllowed(
                connection.adminRole,
                'SERVER_TREE'
            )
        ) {
            SendLine(
                connection.socket,
                'ADMIN_ERROR|FORBIDDEN'
            );

            return;
        }

        const serverId =
            NormalizeID(
                line.split('|')[1] ||
                ''
            );

        if (
            !ServerExists(
                serverId
            )
        ) {
            SendLine(
                connection.socket,
                'SERVER_TREE_ERROR|NOT_FOUND'
            );

            SendLine(
                connection.socket,
                'END_SERVER_TREE'
            );

            return;
        }

        const live =
            GetOnlineServer(
                serverId
            );

        SendLine(
            connection.socket,
            [
                'SERVER_TREE_SERVER',
                serverId,
                FindServerDeviceKey(
                    serverId
                ),

                live
                    ? 'ONLINE'
                    : 'OFFLINE',

                live
                    ? ServerHealth(
                        live
                    )
                    : 'OFFLINE'
            ].join('|')
        );

        for (
            const [
                deviceKey,
                saved
            ]
            of state.clientIdentities
        ) {
            if (
                saved.serverId !==
                serverId
            ) {
                continue;
            }

            const license =
                GetBoundLicenseEntry(
                    saved.id
                );

            SendLine(
                connection.socket,
                [
                    'SERVER_TREE_CLIENT',
                    saved.id,
                    deviceKey,

                    GetOnlineClient(
                        saved.id
                    )
                        ? 'ONLINE'
                        : 'OFFLINE',

                    license
                        ? GetLicenseStatus(
                            license.license
                        )
                        : 'NONE'
                ].join('|')
            );
        }

        SendLine(
            connection.socket,
            'END_SERVER_TREE'
        );

        return;
    }

    /*
        AUDIT
    */
    if (
        line === 'AUDIT_LIST' ||
        line.startsWith(
            'AUDIT_SEARCH|'
        )
    ) {
        if (
            !AdminAllowed(
                connection.adminRole,
                'AUDIT'
            )
        ) {
            SendLine(
                connection.socket,
                'ADMIN_ERROR|FORBIDDEN'
            );

            return;
        }

        let result =
            state.events;

        if (
            line.startsWith(
                'AUDIT_SEARCH|'
            )
        ) {
            const p =
                line.split('|');

            result =
                AuditSearch(
                    p[1] || '',
                    p[2] || 'ALL',
                    Number(p[3]) ||
                    0
                );
        }

        for (
            const event
            of result.slice(
                -MAX_SEARCH_RESULTS
            )
        ) {
            SendLine(
                connection.socket,
                `AUDIT|${event.time}|${event.type}|${event.detail}`
            );
        }

        SendLine(
            connection.socket,
            'END_AUDIT'
        );

        return;
    }

    /*
        BACKUP
    */
    if (line === 'BACKUP_CREATE') {
        if (connection.adminRole !== 'admin') {
            SendLine(
                connection.socket,
                'ADMIN_ERROR|FORBIDDEN'
            );

            return;
        }

        const file =
            CreateBackup(
                'manual'
            );

        SendLine(
            connection.socket,
            file
                ? `BACKUP_OK|${file}`
                : 'BACKUP_ERROR|CREATE_FAILED'
        );

        return;
    }

    if (line === 'BACKUP_LIST') {
        if (
            !AdminAllowed(
                connection.adminRole,
                'VIEW'
            )
        ) {
            SendLine(
                connection.socket,
                'ADMIN_ERROR|FORBIDDEN'
            );

            return;
        }

        for (
            const item
            of ListBackups()
        ) {
            SendLine(
                connection.socket,
                `BACKUP_ITEM|${item.file}|${item.size}|${item.mtimeMs}`
            );
        }

        SendLine(
            connection.socket,
            'END_BACKUP_LIST'
        );

        return;
    }

    if (
        line.startsWith(
            'BACKUP_RESTORE|'
        )
    ) {
        if (connection.adminRole !== 'admin') {
            SendLine(
                connection.socket,
                'ADMIN_ERROR|FORBIDDEN'
            );

            return;
        }

        const result =
            RestoreBackup(
                line.substring(
                    'BACKUP_RESTORE|'.length
                )
            );

        SendLine(
            connection.socket,
            result.ok
                ? `BACKUP_RESTORE_OK|${result.fileName}|${result.preRestore}`
                : `BACKUP_ERROR|${result.reason}`
        );

        return;
    }

    if (
        line.startsWith(
            'BACKUP_DELETE|'
        )
    ) {
        if (connection.adminRole !== 'admin') {
            SendLine(
                connection.socket,
                'ADMIN_ERROR|FORBIDDEN'
            );

            return;
        }

        const result =
            DeleteBackup(
                line.substring(
                    'BACKUP_DELETE|'.length
                )
            );

        SendLine(
            connection.socket,
            result.ok
                ? `BACKUP_DELETE_OK|${result.fileName}`
                : `BACKUP_ERROR|${result.reason}`
        );

        return;
    }

    /*
        SERVER KICK
    */
    if (line.startsWith('SERVER_KICK|')) {
        if (connection.adminRole !== 'admin') {
            SendLine(
                connection.socket,
                'ADMIN_ERROR|FORBIDDEN'
            );

            return;
        }

        const id =
            NormalizeID(
                line.split('|')[1] ||
                ''
            );

        if (
            !ServerExists(
                id
            )
        ) {
            SendLine(
                connection.socket,
                'ADMIN_ERROR|SERVER_NOT_FOUND'
            );

            return;
        }

        const until =
            Now() +
            SERVER_KICK_BLOCK_MS;

        state.kickedServers.set(
            id,
            until
        );

        const live =
            GetOnlineServer(
                id
            );

        if (live) {
            SendLine(
                live.socket,
                `ERROR|ADMIN_KICK|${until}`
            );

            try {
                live.socket.destroy();
            } catch (_) {}
        }

        SendLine(
            connection.socket,
            `SERVER_KICK_OK|${id}|${until}`
        );

        LogEvent(
            'SERVER_KICK',
            `${id} until ${until}`
        );

        return;
    }

    /*
        SERVER DISABLE / ENABLE / DRAIN
    */
    if (
        line.startsWith('SERVER_DISABLE|') ||
        line.startsWith('SERVER_ENABLE|') ||
        line.startsWith('SERVER_DRAIN_ON|') ||
        line.startsWith('SERVER_DRAIN_OFF|')
    ) {
        if (connection.adminRole !== 'admin') {
            SendLine(
                connection.socket,
                'ADMIN_ERROR|FORBIDDEN'
            );

            return;
        }

        const id =
            NormalizeID(
                line.split('|')[1] ||
                ''
            );

        if (
            !ServerExists(
                id
            )
        ) {
            SendLine(
                connection.socket,
                'ADMIN_ERROR|SERVER_NOT_FOUND'
            );

            return;
        }

        if (
            line.startsWith(
                'SERVER_DISABLE|'
            )
        ) {
            state.disabledServers.add(
                id
            );

            state.drainingServers.delete(
                id
            );

            state.kickedServers.delete(
                id
            );

            SaveDatabase();

            const live =
                GetOnlineServer(
                    id
                );

            if (live) {
                SendLine(
                    live.socket,
                    'ERROR|SERVER_DISABLED'
                );

                try {
                    live.socket.destroy();
                } catch (_) {}
            }

            SendLine(
                connection.socket,
                `SERVER_DISABLE_OK|${id}`
            );

            LogEvent(
                'SERVER_DISABLE',
                id
            );
        } else if (
            line.startsWith(
                'SERVER_ENABLE|'
            )
        ) {
            state.disabledServers.delete(
                id
            );

            state.kickedServers.delete(
                id
            );

            SaveDatabase();

            SendLine(
                connection.socket,
                `SERVER_ENABLE_OK|${id}`
            );

            LogEvent(
                'SERVER_ENABLE',
                id
            );
        } else if (
            line.startsWith(
                'SERVER_DRAIN_ON|'
            )
        ) {
            state.drainingServers.add(
                id
            );

            SaveDatabase();

            SendLine(
                connection.socket,
                `SERVER_DRAIN_ON_OK|${id}`
            );

            LogEvent(
                'SERVER_DRAIN_ON',
                id
            );
        } else {
            state.drainingServers.delete(
                id
            );

            SaveDatabase();

            SendLine(
                connection.socket,
                `SERVER_DRAIN_OFF_OK|${id}`
            );

            LogEvent(
                'SERVER_DRAIN_OFF',
                id
            );
        }

        return;
    }

    /*
        CLIENT KICK
    */
    if (line.startsWith('CLIENT_KICK|')) {
        if (connection.adminRole !== 'admin') {
            SendLine(
                connection.socket,
                'ADMIN_ERROR|FORBIDDEN'
            );

            return;
        }

        const id =
            NormalizeID(
                line.split('|')[1] ||
                ''
            );

        if (
            !ClientExists(
                id
            )
        ) {
            SendLine(
                connection.socket,
                'ADMIN_ERROR|CLIENT_NOT_FOUND'
            );

            return;
        }

        const until =
            Now() +
            CLIENT_KICK_BLOCK_MS;

        state.kickedClients.set(
            id,
            until
        );

        NotifyServerUnauthorized(
            id,
            'ADMIN_KICK'
        );

        const live =
            GetOnlineClient(
                id
            );

        if (live) {
            SendLine(
                live.socket,
                `ERROR|CLIENT_KICKED|${until}`
            );

            try {
                live.socket.destroy();
            } catch (_) {}
        }

        SendLine(
            connection.socket,
            `CLIENT_KICK_OK|${id}|${until}`
        );

        LogEvent(
            'CLIENT_KICK',
            `${id} until ${until}`
        );

        return;
    }

    /*
        CLIENT DISABLE / ENABLE
    */
    if (
        line.startsWith('CLIENT_DISABLE|') ||
        line.startsWith('CLIENT_ENABLE|')
    ) {
        if (connection.adminRole !== 'admin') {
            SendLine(
                connection.socket,
                'ADMIN_ERROR|FORBIDDEN'
            );

            return;
        }

        const id =
            NormalizeID(
                line.split('|')[1] ||
                ''
            );

        if (
            !ClientExists(
                id
            )
        ) {
            SendLine(
                connection.socket,
                'ADMIN_ERROR|CLIENT_NOT_FOUND'
            );

            return;
        }

        if (
            line.startsWith(
                'CLIENT_DISABLE|'
            )
        ) {
            state.disabledClients.add(
                id
            );

            state.kickedClients.delete(
                id
            );

            SaveDatabase();

            NotifyServerUnauthorized(
                id,
                'CLIENT_DISABLED'
            );

            const live =
                GetOnlineClient(
                    id
                );

            if (live) {
                SendLine(
                    live.socket,
                    'ERROR|CLIENT_DISABLED'
                );

                try {
                    live.socket.destroy();
                } catch (_) {}
            }

            SendLine(
                connection.socket,
                `CLIENT_DISABLE_OK|${id}`
            );

            LogEvent(
                'CLIENT_DISABLE',
                id
            );
        } else {
            state.disabledClients.delete(
                id
            );

            state.kickedClients.delete(
                id
            );

            SaveDatabase();

            SendLine(
                connection.socket,
                `CLIENT_ENABLE_OK|${id}`
            );

            LogEvent(
                'CLIENT_ENABLE',
                id
            );
        }

        return;
    }

    /*
        CLIENT MOVE
    */
    if (line.startsWith('CLIENT_MOVE|')) {
        if (connection.adminRole !== 'admin') {
            SendLine(
                connection.socket,
                'ADMIN_ERROR|FORBIDDEN'
            );

            return;
        }

        const p =
            line.split('|');

        const result =
            ClientMove(
                p[1] || '',
                p[2] || ''
            );

        SendLine(
            connection.socket,
            result.ok
                ? `CLIENT_MOVE_OK|${NormalizeID(p[1])}|${NormalizeID(p[2])}`
                : `CLIENT_MOVE_ERROR|${result.reason}`
        );

        return;
    }

    /*
        SERVICE
    */
    if (line === 'SERVICE_STOP') {
        if (connection.adminRole !== 'admin') {
            SendLine(
                connection.socket,
                'ADMIN_ERROR|FORBIDDEN'
            );

            return;
        }

        ServiceStop();

        SendLine(
            connection.socket,
            'SERVICE_STOP_OK'
        );

        return;
    }

    if (line === 'SERVICE_START') {
        if (connection.adminRole !== 'admin') {
            SendLine(
                connection.socket,
                'ADMIN_ERROR|FORBIDDEN'
            );

            return;
        }

        ServiceStart();

        SendLine(
            connection.socket,
            'SERVICE_START_OK'
        );

        return;
    }

    /*
        MAINTENANCE
    */
    if (line === 'MAINTENANCE_ON') {
        if (connection.adminRole !== 'admin') {
            SendLine(
                connection.socket,
                'ADMIN_ERROR|FORBIDDEN'
            );

            return;
        }

        const result =
            MaintenanceOn();

        if (!result.ok) {
            SendLine(
                connection.socket,
                'ADMIN_ERROR|SERVICE_DISABLED'
            );

            return;
        }

        SendLine(
            connection.socket,
            'MAINTENANCE_ON_OK'
        );

        return;
    }

    if (line === 'MAINTENANCE_OFF') {
        if (connection.adminRole !== 'admin') {
            SendLine(
                connection.socket,
                'ADMIN_ERROR|FORBIDDEN'
            );

            return;
        }

        MaintenanceOff();

        SendLine(
            connection.socket,
            'MAINTENANCE_OFF_OK'
        );

        return;
    }

    /*
        SCHEDULE
    */
    if (
        line.startsWith(
            'MAINT_SCHEDULE|'
        )
    ) {
        if (connection.adminRole !== 'admin') {
            SendLine(
                connection.socket,
                'ADMIN_ERROR|FORBIDDEN'
            );

            return;
        }

        const p =
            line.split('|');

        const result =
            SetMaintenanceSchedule(
                Number(p[1]),
                Number(p[2]),
                p
                    .slice(3)
                    .join('|') ||
                'Scheduled maintenance'
            );

        if (!result.ok) {
            SendLine(
                connection.socket,
                'MAINT_SCHEDULE_ERROR|INVALID_TIME'
            );

            return;
        }

        SendLine(
            connection.socket,
            `MAINT_SCHEDULE_OK|${result.startAt}|${result.endAt}|${result.message}`
        );

        return;
    }

    if (
        line ===
        'MAINT_SCHEDULE_CLEAR'
    ) {
        if (connection.adminRole !== 'admin') {
            SendLine(
                connection.socket,
                'ADMIN_ERROR|FORBIDDEN'
            );

            return;
        }

        ClearMaintenanceSchedule();

        SendLine(
            connection.socket,
            'MAINT_SCHEDULE_CLEAR_OK'
        );

        return;
    }

    if (
        line ===
        'MAINT_SCHEDULE_STATUS'
    ) {
        if (
            !AdminAllowed(
                connection.adminRole,
                'SCHEDULE_STATUS'
            )
        ) {
            SendLine(
                connection.socket,
                'ADMIN_ERROR|FORBIDDEN'
            );

            return;
        }

        const schedule =
            GetMaintenanceSchedule();

        if (schedule) {
            SendLine(
                connection.socket,
                `MAINT_SCHEDULE_STATUS|${schedule.startAt}|${schedule.endAt}|${schedule.message}`
            );
        } else {
            SendLine(
                connection.socket,
                'MAINT_SCHEDULE_STATUS|NONE'
            );
        }

        return;
    }

    /*
        NOTICE
    */
    if (
        line.startsWith(
            'NOTICE_ALL|'
        )
    ) {
        if (
            !AdminAllowed(
                connection.adminRole,
                'NOTICE'
            )
        ) {
            SendLine(
                connection.socket,
                'ADMIN_ERROR|FORBIDDEN'
            );

            return;
        }

        const count =
            NoticeAll(
                line.substring(
                    'NOTICE_ALL|'.length
                )
            );

        SendLine(
            connection.socket,
            `NOTICE_ALL_OK|${count}`
        );

        return;
    }

    if (
        line.startsWith(
            'NOTICE_CLIENT|'
        )
    ) {
        if (
            !AdminAllowed(
                connection.adminRole,
                'NOTICE'
            )
        ) {
            SendLine(
                connection.socket,
                'ADMIN_ERROR|FORBIDDEN'
            );

            return;
        }

        const p =
            line.split('|');

        const id =
            NormalizeID(
                p[1] ||
                ''
            );

        const ok =
            NoticeClient(
                id,
                p
                    .slice(2)
                    .join('|')
            );

        SendLine(
            connection.socket,
            ok
                ? `NOTICE_CLIENT_OK|${id}`
                : 'NOTICE_CLIENT_ERROR|OFFLINE'
        );

        return;
    }

    SendLine(
        connection.socket,
        'ADMIN_ERROR|UNKNOWN_COMMAND'
    );
}


function HandleAdminLine(
    connection,
    line
) {
    line =
        String(
            line ||
            ''
        ).trim();

    if (!line) {
        return;
    }

    /*
        LOGIN
    */
    if (
        line ===
        'ADMIN_HELLO' ||
        line.startsWith(
            'ADMIN_HELLO|'
        )
    ) {
        HandleAdminHello(
            connection,
            line
        );

        return;
    }

    if (
        line.startsWith(
            'ADMIN_AUTH|'
        )
    ) {
        HandleAdminAuth(
            connection,
            line
        );

        return;
    }

    if (
        !connection.adminAuthenticated
    ) {
        SendLine(
            connection.socket,
            'ADMIN_ERROR|NOT_AUTHORIZED'
        );

        return;
    }

    /*
        Session Timeout
    */
    if (
        Now() -
        connection.adminAuthenticatedAt >
        ADMIN_SESSION_TIMEOUT_MS
    ) {
        connection.adminAuthenticated =
            false;

        connection.adminRole =
            '';

        SendLine(
            connection.socket,
            'ADMIN_ERROR|SESSION_EXPIRED'
        );

        return;
    }

    /*
        Dangerous command confirm 준비.
        AdminMain에서는 command를 Base64로 보내고
        서버가 일회용 token을 발급.
    */
    if (
        line.startsWith(
            'CONFIRM_PREPARE|'
        )
    ) {
        let command =
            '';

        try {
            command =
                Buffer
                    .from(
                        line.substring(
                            'CONFIRM_PREPARE|'.length
                        ),
                        'base64'
                    )
                    .toString(
                        'utf8'
                    );
        } catch (_) {}

        if (
            !command ||
            !IsDangerousCommand(
                command
            )
        ) {
            SendLine(
                connection.socket,
                'CONFIRM_ERROR|INVALID_COMMAND'
            );

            return;
        }

        PrepareConfirm(
            connection,
            command
        );

        return;
    }

    /*
        Confirm 실행.
    */
    if (
        line.startsWith(
            'CONFIRM_EXEC|'
        )
    ) {
        const command =
            ConsumeConfirm(
                connection,
                line.split('|')[1] ||
                ''
            );

        if (!command) {
            return;
        }

        ExecuteAdminCommand(
            connection,
            command,
            true
        );

        return;
    }

    ExecuteAdminCommand(
        connection,
        line,
        false
    );
}


module.exports = {
    SendLicenseItem,
    ExecuteAdminCommand,
    HandleAdminLine
};
