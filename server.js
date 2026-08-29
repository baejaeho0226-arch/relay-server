'use strict';

process.on('uncaughtException', error => {
    console.error('================================');
    console.error('UNCAUGHT EXCEPTION');
    console.error('================================');
    console.error(error);
    console.error(error && error.stack ? error.stack : '');
    console.error('================================');
});

process.on('unhandledRejection', reason => {
    console.error('================================');
    console.error('UNHANDLED REJECTION');
    console.error('================================');
    console.error(reason);
    console.error('================================');
});

const net =
    require(
        'net'
    );

const http =
    require(
        'http'
    );

const config =
    require(
        './config/config'
    );

const state =
    require(
        './core/state'
    );

const {
    HOST,
    PORT,
    HEALTH_PORT,

    DATA_DIR,

    CURRENT_PROTOCOL_VERSION,

    MAX_CLIENTS_PER_SERVER,

    ACK_RETRY_MS,
    ACK_TIMEOUT_MS
} = config;

const {
    EnsureDirs
} = require(
    './core/utils'
);

const {
    LoadRecentAudit,
    LogEvent
} = require(
    './storage/audit'
);

const {
    LoadDatabase,
    SaveDatabase
} = require(
    './storage/database'
);

const {
    CreateBackup
} = require(
    './storage/backup'
);

const {
    CreateConnection
} = require(
    './core/connection'
);

const {
    StartBackgroundServices
} = require(
    './services/maintenance'
);

const {
    HealthSnapshot
} = require(
    './services/dashboard'
);


/*
    ========================================
    INITIALIZE
    ========================================
*/

EnsureDirs();

LoadRecentAudit();

LoadDatabase();


/*
    ========================================
    PURE TCP RELAY
    ========================================
*/

const relayServer =
    net.createServer(
        CreateConnection
    );


relayServer.on(
    'error',
    error => {
        console.error(
            'SERVER ERROR:',
            error.message
        );
    }
);


relayServer.listen(
    PORT,
    HOST,
    () => {
        console.log(
            '================================'
        );

        console.log(
            '       PURE TCP RELAY vNext'
        );

        console.log(
            '================================'
        );

        console.log(
            'TCP Port:',
            PORT
        );

        console.log(
            'DATA_DIR:',
            DATA_DIR
        );

        console.log(
            'Protocol current/min:',
            CURRENT_PROTOCOL_VERSION,
            '/',
            state.minProtocolVersion
        );

        console.log(
            'Min Server:',
            state.minServerVersion,
            'Min Client:',
            state.minClientVersion
        );

        console.log(
            'Max clients/server:',
            MAX_CLIENTS_PER_SERVER
        );

        console.log(
            'ACK retry/timeout:',
            ACK_RETRY_MS,
            '/',
            ACK_TIMEOUT_MS
        );

        console.log(
            'Service:',
            state.serviceEnabled
                ? 'ONLINE'
                : 'OFFLINE',

            'Maintenance:',
            state.maintenanceMode
                ? 'ON'
                : 'OFF'
        );

        console.log(
            '================================'
        );
    }
);


/*
    ========================================
    OPTIONAL HTTP HEALTH
    ========================================

    HEALTH_PORT가 0이면 실행 안 됨.
*/

let healthServer =
    null;


if (
    HEALTH_PORT >
    0
) {
    healthServer =
        http.createServer(
            (
                req,
                res
            ) => {
                if (
                    req.url !==
                    '/health' &&
                    req.url !==
                    '/healthz'
                ) {
                    res.writeHead(
                        404,
                        {
                            'Content-Type':
                                'application/json'
                        }
                    );

                    res.end(
                        JSON.stringify({
                            error:
                                'not_found'
                        })
                    );

                    return;
                }

                const body =
                    HealthSnapshot();

                res.writeHead(
                    body.ok
                        ? 200
                        : 503,
                    {
                        'Content-Type':
                            'application/json',

                        'Cache-Control':
                            'no-store'
                    }
                );

                res.end(
                    JSON.stringify(
                        body
                    )
                );
            }
        );


    healthServer.on(
        'error',
        error => {
            console.error(
                'HEALTH SERVER ERROR:',
                error.message
            );
        }
    );


    healthServer.listen(
        HEALTH_PORT,
        HOST,
        () => {
            console.log(
                'Health HTTP Port:',
                HEALTH_PORT
            );
        }
    );
}


/*
    ========================================
    BACKGROUND SERVICES
    ========================================

    내부에서:

    1초:
      ACK
      Retry
      Timeout
      Kick 만료
      RateLimit cleanup
      Maintenance schedule

    10초:
      Heartbeat
      RTT
      License validate

    30초:
      DB Save

    6시간:
      Auto Backup
*/

StartBackgroundServices();


/*
    ========================================
    SHUTDOWN
    ========================================
*/

let shuttingDown =
    false;


function Shutdown(
    signal
) {
    if (
        shuttingDown
    ) {
        return;
    }

    shuttingDown =
        true;

    try {
        LogEvent(
            'SHUTDOWN',
            signal ||
            'UNKNOWN'
        );

        /*
            종료 직전 Backup.
        */
        CreateBackup(
            'shutdown'
        );

        SaveDatabase();
    } catch (
        error
    ) {
        console.error(
            'SHUTDOWN SAVE ERROR:',
            error.message
        );
    }

    try {
        relayServer.close();
    } catch (_) {}

    if (
        healthServer
    ) {
        try {
            healthServer.close();
        } catch (_) {}
    }

    /*
        모든 저장은 위에서 동기식으로 완료됨.
    */
    setTimeout(
        () => {
            process.exit(
                0
            );
        },
        250
    ).unref();
}


process.on(
    'SIGINT',
    () => {
        Shutdown(
            'SIGINT'
        );
    }
);


process.on(
    'SIGTERM',
    () => {
        Shutdown(
            'SIGTERM'
        );
    }
);
