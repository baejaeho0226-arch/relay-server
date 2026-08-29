'use strict';

const config =
    require(
        '../config/config'
    );

const state =
    require(
        '../core/state'
    );

const {
    RATE_LIMIT_WINDOW_MS,
    AUTO_BACKUP_INTERVAL_MS
} = config;

const {
    Now,
    SafeField,
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
    CreateBackup
} = require(
    '../storage/backup'
);

const {
    LogEvent
} = require(
    '../storage/audit'
);

const {
    SendPing
} = require(
    '../relay/heartbeat'
);

const {
    NoticeAll,
    NotifyServerUnauthorized
} = require(
    '../relay/notifications'
);

const {
    ValidateClientLicense
} = require(
    '../license/licenseManager'
);

const {
    CleanupRequestHistory,
    ProcessPendingRequests
} = require(
    '../relay/ackManager'
);


let backgroundStarted =
    false;


function CleanupTransient() {
    const now =
        Now();

    /*
        오래된 Rate Limit 상태 정리.
    */
    for (
        const [
            key,
            rate
        ]
        of state.rateLimits
    ) {
        if (
            rate.startedAt <
            now -
            RATE_LIMIT_WINDOW_MS *
            5
        ) {
            state.rateLimits.delete(
                key
            );
        }
    }

    /*
        SERVER KICK 만료.
    */
    for (
        const [
            serverId,
            until
        ]
        of state.kickedServers
    ) {
        if (
            now >= until
        ) {
            state.kickedServers.delete(
                serverId
            );

            LogEvent(
                'SERVER_KICK_EXPIRED',
                serverId
            );
        }
    }

    /*
        CLIENT KICK 만료.
    */
    for (
        const [
            clientId,
            until
        ]
        of state.kickedClients
    ) {
        if (
            now >= until
        ) {
            state.kickedClients.delete(
                clientId
            );

            LogEvent(
                'CLIENT_KICK_EXPIRED',
                clientId
            );
        }
    }

    /*
        위험 명령 Confirm Token 만료.
    */
    for (
        const [
            token,
            item
        ]
        of state.confirmTokens
    ) {
        if (
            now >=
            item.expiresAt
        ) {
            state.confirmTokens.delete(
                token
            );
        }
    }
}


function ServiceStop() {
    state.serviceEnabled =
        false;

    /*
        SERVICE STOP과 MAINTENANCE가
        동시에 걸리지 않게 통일.
    */
    state.maintenanceMode =
        false;

    SaveDatabase();

    for (
        const client
        of state.clients.values()
    ) {
        client.licenseAuthorized =
            false;

        client.licenseExpiresAt =
            0;

        client.lastServerAuthState =
            '';

        SendLine(
            client.socket,
            'SERVICE_STATE|DISABLED'
        );

        NotifyServerUnauthorized(
            client.clientId,
            'SERVICE_DISABLED'
        );
    }

    LogEvent(
        'SERVICE_STOP',
        ''
    );

    return true;
}


function ServiceStart() {
    state.serviceEnabled =
        true;

    state.maintenanceMode =
        false;

    SaveDatabase();

    /*
        서비스가 다시 살아났다고
        서버측에서 Client를 자동 인증하지 않는다.

        APK에 ONLINE만 알리고
        APK가 가지고 있는 License Key로
        LICENSE_AUTH를 다시 보내게 한다.
    */
    for (
        const client
        of state.clients.values()
    ) {
        SendLine(
            client.socket,
            'SERVICE_STATE|ONLINE'
        );
    }

    LogEvent(
        'SERVICE_START',
        ''
    );

    return true;
}


function MaintenanceOn() {
    if (
        !state.serviceEnabled
    ) {
        return {
            ok: false,
            reason: 'SERVICE_DISABLED'
        };
    }

    state.maintenanceMode =
        true;

    SaveDatabase();

    /*
        이미 인증된 세션은 절대 revoke하지 않는다.

        미인증 세션에만 Maintenance 상태 전송.
    */
    for (
        const client
        of state.clients.values()
    ) {
        if (
            !client.licenseAuthorized
        ) {
            SendLine(
                client.socket,
                'SERVICE_STATE|MAINTENANCE'
            );
        }
    }

    LogEvent(
        'MAINTENANCE_ON',
        ''
    );

    return {
        ok: true
    };
}


function MaintenanceOff() {
    state.maintenanceMode =
        false;

    SaveDatabase();

    for (
        const client
        of state.clients.values()
    ) {
        SendLine(
            client.socket,
            'SERVICE_STATE|ONLINE'
        );
    }

    LogEvent(
        'MAINTENANCE_OFF',
        ''
    );

    return {
        ok: true
    };
}


function SetMaintenanceSchedule(
    startAt,
    endAt,
    message
) {
    startAt =
        Number(
            startAt
        );

    endAt =
        Number(
            endAt
        );

    if (
        !Number.isFinite(
            startAt
        ) ||
        !Number.isFinite(
            endAt
        ) ||
        startAt <=
        Now() ||
        endAt <=
        startAt
    ) {
        return {
            ok: false,
            reason: 'INVALID_TIME'
        };
    }

    state.maintenanceSchedule = {
        startAt,
        endAt,

        message:
            SafeField(
                message ||
                'Scheduled maintenance'
            )
    };

    SaveDatabase();

    LogEvent(
        'MAINT_SCHEDULE',
        `${startAt}-${endAt} ${state.maintenanceSchedule.message}`
    );

    return {
        ok: true,

        ...state.maintenanceSchedule
    };
}


function ClearMaintenanceSchedule() {
    state.maintenanceSchedule =
        null;

    SaveDatabase();

    LogEvent(
        'MAINT_SCHEDULE_CLEAR',
        ''
    );

    return true;
}


function GetMaintenanceSchedule() {
    if (
        !state.maintenanceSchedule
    ) {
        return null;
    }

    return {
        ...state.maintenanceSchedule
    };
}


function ApplyMaintenanceSchedule() {
    const schedule =
        state.maintenanceSchedule;

    if (
        !schedule
    ) {
        return;
    }

    const now =
        Now();

    /*
        예약 시작.
    */
    if (
        now >=
        schedule.startAt &&
        now <
        schedule.endAt &&
        !state.maintenanceMode
    ) {
        if (
            !state.serviceEnabled
        ) {
            return;
        }

        state.maintenanceMode =
            true;

        SaveDatabase();

        /*
            공지는 모든 온라인 Client에게.
        */
        NoticeAll(
            schedule.message
        );

        /*
            Maintenance 상태 메시지는
            미인증 Client에게만 전달.
            기존 인증 세션은 SEND 계속 가능.
        */
        for (
            const client
            of state.clients.values()
        ) {
            if (
                !client.licenseAuthorized
            ) {
                SendLine(
                    client.socket,
                    'SERVICE_STATE|MAINTENANCE'
                );
            }
        }

        LogEvent(
            'MAINT_SCHEDULE_STARTED',
            schedule.message
        );
    }

    /*
        예약 종료.
    */
    if (
        now >=
        schedule.endAt
    ) {
        if (
            state.maintenanceMode
        ) {
            state.maintenanceMode =
                false;

            for (
                const client
                of state.clients.values()
            ) {
                SendLine(
                    client.socket,
                    'SERVICE_STATE|ONLINE'
                );
            }

            LogEvent(
                'MAINT_SCHEDULE_ENDED',
                schedule.message
            );
        }

        state.maintenanceSchedule =
            null;

        SaveDatabase();
    }
}


function HeartbeatTick() {
    const now =
        Now();

    /*
        WinSockServer Heartbeat.
    */
    for (
        const server
        of Array.from(
            state.servers.values()
        )
    ) {
        if (
            !server.socket ||
            server.socket.destroyed
        ) {
            continue;
        }

        if (
            now -
            server.lastSeen >
            30000
        ) {
            try {
                server.socket.destroy();
            } catch (_) {}

            continue;
        }

        SendPing(
            server
        );
    }

    /*
        Android Client Heartbeat + License 검사.
    */
    for (
        const client
        of Array.from(
            state.clients.values()
        )
    ) {
        if (
            !client.socket ||
            client.socket.destroyed
        ) {
            continue;
        }

        if (
            now -
            client.lastSeen >
            30000
        ) {
            try {
                client.socket.destroy();
            } catch (_) {}

            continue;
        }

        ValidateClientLicense(
            client
        );

        SendPing(
            client
        );
    }
}


function StartBackgroundServices() {
    /*
        server.js가 실수로 두 번 호출해도
        Interval 중복 생성 방지.
    */
    if (
        backgroundStarted
    ) {
        return;
    }

    backgroundStarted =
        true;

    /*
        빠른 주기:
        ACK / KICK / Rate Limit / 예약 Maintenance.
    */
    setInterval(
        () => {
            try {
                CleanupRequestHistory();
                CleanupTransient();
                ProcessPendingRequests();
                ApplyMaintenanceSchedule();
            } catch (
                error
            ) {
                console.error(
                    'BACKGROUND 1S ERROR:',
                    error.message
                );
            }
        },
        1000
    );

    /*
        Heartbeat + License 상태 확인.
    */
    setInterval(
        () => {
            try {
                HeartbeatTick();
            } catch (
                error
            ) {
                console.error(
                    'HEARTBEAT ERROR:',
                    error.message
                );
            }
        },
        10000
    );

    /*
        DB 주기 저장.
    */
    setInterval(
        () => {
            try {
                SaveDatabase();
            } catch (
                error
            ) {
                console.error(
                    'PERIODIC DB SAVE ERROR:',
                    error.message
                );
            }
        },
        30000
    );

    /*
        자동 Backup.
    */
    setInterval(
        () => {
            try {
                CreateBackup(
                    'auto'
                );
            } catch (
                error
            ) {
                console.error(
                    'AUTO BACKUP ERROR:',
                    error.message
                );
            }
        },
        AUTO_BACKUP_INTERVAL_MS
    );
}


module.exports = {
    CleanupTransient,

    ServiceStop,
    ServiceStart,

    MaintenanceOn,
    MaintenanceOff,

    SetMaintenanceSchedule,
    ClearMaintenanceSchedule,
    GetMaintenanceSchedule,

    ApplyMaintenanceSchedule,

    HeartbeatTick,
    StartBackgroundServices
};
