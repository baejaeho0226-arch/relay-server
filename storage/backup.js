'use strict';

const fs = require('fs');
const path = require('path');

const config = require('../config/config');
const state = require('../core/state');

const {
    BACKUP_DIR,
    MAX_BACKUPS
} = config;

const {
    Now,
    SafeField,
    EnsureDirs
} = require('../core/utils');

const {
    BuildDatabaseObject,
    ImportDatabaseObject,
    SaveDatabase,
    TryLoadJson
} = require('./database');

const {
    LogEvent
} = require('./audit');


function CleanupBackups() {
    try {
        const files =
            fs
                .readdirSync(
                    BACKUP_DIR
                )
                .filter(
                    file =>
                        file.endsWith(
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
                    (a, b) =>
                        b.time -
                        a.time
                );

        for (
            let i = MAX_BACKUPS;
            i < files.length;
            i++
        ) {
            try {
                fs.unlinkSync(
                    path.join(
                        BACKUP_DIR,
                        files[i].file
                    )
                );
            } catch (_) {}
        }
    } catch (_) {}
}


function CreateBackup(reason) {
    EnsureDirs();

    const stamp =
        new Date()
            .toISOString()
            .replace(
                /[:.]/g,
                '-'
            );

    const safeReason =
        SafeField(
            reason ||
            'backup'
        )
            .replace(
                /[^A-Za-z0-9_-]/g,
                '_'
            );

    const file =
        `relay-${stamp}-${safeReason}.json`;

    const fullPath =
        path.join(
            BACKUP_DIR,
            file
        );

    try {
        fs.writeFileSync(
            fullPath,
            JSON.stringify(
                BuildDatabaseObject(),
                null,
                2
            ),
            'utf8'
        );

        CleanupBackups();

        LogEvent(
            'BACKUP_CREATE',
            file
        );

        return file;
    } catch (
        error
    ) {
        console.error(
            'BACKUP ERROR:',
            error.message
        );

        return '';
    }
}


function RestoreBackup(fileName) {
    const safe =
        path.basename(
            String(
                fileName ||
                ''
            )
        );

    const file =
        path.join(
            BACKUP_DIR,
            safe
        );

    if (
        !fs.existsSync(
            file
        )
    ) {
        return {
            ok: false,
            reason: 'NOT_FOUND'
        };
    }

    const data =
        TryLoadJson(
            file
        );

    if (!data) {
        return {
            ok: false,
            reason: 'INVALID_DATA'
        };
    }

    /*
        복원 직전 DB도 자동 백업.
        복원 실수 시 되돌릴 수 있게 한다.
    */
    const preRestore =
        CreateBackup(
            'pre_restore'
        );

    if (
        !ImportDatabaseObject(
            data
        )
    ) {
        return {
            ok: false,
            reason: 'INVALID_DATA'
        };
    }

    /*
        런타임 임시 상태는
        복원된 DB와 섞이지 않도록 초기화.
    */
    state.requestHistory.clear();
    state.pendingRequests.clear();
    state.rateLimits.clear();

    state.kickedServers.clear();
    state.kickedClients.clear();

    state.confirmTokens.clear();

    SaveDatabase();

    LogEvent(
        'BACKUP_RESTORE',
        safe
    );

    /*
        lifecycle과 순환 require가 생기지 않도록
        실행 시점에 불러온다.
    */
    setTimeout(
        () => {
            try {
                const {
                    ForceReconnectAll
                } = require(
                    '../core/lifecycle'
                );

                ForceReconnectAll(
                    'DATABASE_RESTORED'
                );
            } catch (
                error
            ) {
                console.error(
                    'RESTORE RECONNECT ERROR:',
                    error.message
                );
            }
        },
        250
    );

    return {
        ok: true,

        fileName:
            safe,

        preRestore
    };
}


function ListBackups() {
    EnsureDirs();

    try {
        return fs
            .readdirSync(
                BACKUP_DIR
            )
            .filter(
                file =>
                    file.endsWith(
                        '.json'
                    )
            )
            .map(
                file => {
                    const stat =
                        fs.statSync(
                            path.join(
                                BACKUP_DIR,
                                file
                            )
                        );

                    return {
                        file,
                        size:
                            stat.size,
                        mtimeMs:
                            stat.mtimeMs
                    };
                }
            )
            .sort(
                (a, b) =>
                    b.mtimeMs -
                    a.mtimeMs
            );
    } catch (_) {
        return [];
    }
}


function DeleteBackup(fileName) {
    const safe =
        path.basename(
            String(
                fileName ||
                ''
            )
        );

    if (!safe) {
        return {
            ok: false,
            reason: 'INVALID_NAME'
        };
    }

    const file =
        path.join(
            BACKUP_DIR,
            safe
        );

    if (
        !fs.existsSync(
            file
        )
    ) {
        return {
            ok: false,
            reason: 'NOT_FOUND'
        };
    }

    try {
        fs.unlinkSync(
            file
        );

        LogEvent(
            'BACKUP_DELETE',
            safe
        );

        return {
            ok: true,
            fileName:
                safe
        };
    } catch (_) {
        return {
            ok: false,
            reason: 'DELETE_FAILED'
        };
    }
}


module.exports = {
    CleanupBackups,
    CreateBackup,
    RestoreBackup,
    ListBackups,
    DeleteBackup
};
