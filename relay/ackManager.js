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
    REQUEST_HISTORY_TIMEOUT_MS,
    ACK_RETRY_MS,
    ACK_TIMEOUT_MS,
    ACK_MAX_RETRIES
} = config;

const {
    Now,
    NormalizeID,
    SafeField,
    SendLine
} = require(
    '../core/utils'
);

const {
    GetOnlineServer,
    GetOnlineClient,
    GetSavedClientByID
} = require(
    '../identity/identityManager'
);

const {
    LogEvent
} = require(
    '../storage/audit'
);


function MakeRequestKey(
    clientId,
    requestId
) {
    return (
        `${NormalizeID(clientId)}|${
            String(
                requestId ||
                ''
            ).trim()
        }`
    );
}


function RegisterPendingRequest(
    clientId,
    serverId,
    requestId,
    payload
) {
    const key =
        MakeRequestKey(
            clientId,
            requestId
        );

    const now =
        Now();

    state.requestHistory.set(
        key,
        now
    );

    state.pendingRequests.set(
        key,
        {
            clientId:
                NormalizeID(
                    clientId
                ),

            serverId:
                NormalizeID(
                    serverId
                ),

            requestId:
                String(
                    requestId ||
                    ''
                ).trim(),

            payload:
                String(
                    payload ||
                    ''
                ),

            createdAt:
                now,

            lastSendAt:
                now,

            retries:
                0
        }
    );

    return key;
}


function IsDuplicateRequest(
    clientId,
    requestId
) {
    const key =
        MakeRequestKey(
            clientId,
            requestId
        );

    return state.requestHistory.has(
        key
    );
}


function HandleServerAck(
    connection,
    line
) {
    const parts =
        String(
            line ||
            ''
        ).split('|');

    /*
        ACK|RequestID|ClientID|OK

        ACK|RequestID|ClientID|ERROR|Reason
    */
    if (
        parts.length <
        4
    ) {
        SendLine(
            connection.socket,
            'ERROR|INVALID_ACK'
        );

        return;
    }

    const requestId =
        String(
            parts[1] ||
            ''
        ).trim();

    const clientId =
        NormalizeID(
            parts[2] ||
            ''
        );

    const result =
        String(
            parts[3] ||
            ''
        )
            .trim()
            .toUpperCase();

    const saved =
        GetSavedClientByID(
            clientId
        );

    /*
        이 Client가 실제로
        이 WinSockServer 소속인지 확인.
    */
    if (
        !requestId ||
        !clientId ||
        !saved ||
        saved.serverId !==
        connection.serverId
    ) {
        SendLine(
            connection.socket,
            'ERROR|ACK_NOT_OWNER'
        );

        return;
    }

    const key =
        MakeRequestKey(
            clientId,
            requestId
        );

    const pending =
        state.pendingRequests.get(
            key
        );

    /*
        이미 Timeout 되었거나
        처리된 ACK.
    */
    if (!pending) {
        SendLine(
            connection.socket,
            `ACK_RESULT|UNKNOWN|${requestId}`
        );

        return;
    }

    if (
        pending.serverId !==
        connection.serverId
    ) {
        SendLine(
            connection.socket,
            'ERROR|ACK_SERVER_MISMATCH'
        );

        return;
    }

    state.pendingRequests.delete(
        key
    );

    const client =
        GetOnlineClient(
            clientId
        );

    if (
        result ===
        'OK'
    ) {
        state.runtimeStats.ackOk++;

        if (
            client
        ) {
            SendLine(
                client.socket,
                `ACK|OK|${requestId}`
            );
        }

        SendLine(
            connection.socket,
            `ACK_RESULT|OK|${requestId}`
        );

        LogEvent(
            'ACK_OK',
            `${requestId} / ${clientId}`
        );

        return;
    }

    state.runtimeStats.ackError++;

    const reason =
        parts.length >= 5
            ? SafeField(
                parts
                    .slice(4)
                    .join(' ')
            )
            : 'PROCESS_FAILED';

    if (
        client
    ) {
        SendLine(
            client.socket,
            `ACK|ERROR|${requestId}|${reason}`
        );
    }

    SendLine(
        connection.socket,
        `ACK_RESULT|ERROR|${requestId}`
    );

    LogEvent(
        'ACK_ERROR',
        `${requestId} / ${clientId} / ${reason}`
    );
}


function CleanupRequestHistory() {
    const cutoff =
        Now() -
        REQUEST_HISTORY_TIMEOUT_MS;

    for (
        const [
            key,
            timestamp
        ]
        of state.requestHistory
    ) {
        if (
            !Number.isFinite(
                timestamp
            ) ||
            timestamp <
            cutoff
        ) {
            state.requestHistory.delete(
                key
            );
        }
    }
}


function ProcessPendingRequests() {
    const now =
        Now();

    for (
        const [
            key,
            pending
        ]
        of Array.from(
            state.pendingRequests.entries()
        )
    ) {
        /*
            전체 ACK 제한시간 초과.
        */
        if (
            now -
            pending.createdAt >=
            ACK_TIMEOUT_MS
        ) {
            state.pendingRequests.delete(
                key
            );

            state.runtimeStats.ackTimeout++;

            const client =
                GetOnlineClient(
                    pending.clientId
                );

            if (
                client
            ) {
                SendLine(
                    client.socket,
                    `ACK|TIMEOUT|${pending.requestId}`
                );
            }

            LogEvent(
                'ACK_TIMEOUT',
                `${pending.requestId} / ${pending.clientId}`
            );

            continue;
        }

        /*
            일정 시간 ACK가 없으면
            같은 Request-ID를 재전송.

            WinSockServer는 이미 처리한 ID면
            실제 숫자를 재처리하지 않고 ACK만 재전송한다.
        */
        if (
            now -
            pending.lastSendAt >=
            ACK_RETRY_MS &&
            pending.retries <
            ACK_MAX_RETRIES
        ) {
            const server =
                GetOnlineServer(
                    pending.serverId
                );

            if (!server) {
                continue;
            }

            if (
                SendLine(
                    server.socket,
                    pending.payload
                )
            ) {
                pending.retries++;

                pending.lastSendAt =
                    now;

                state.runtimeStats.ackRetries++;

                LogEvent(
                    'ACK_RETRY',
                    `${pending.requestId} / ${pending.clientId} #${pending.retries}`
                );
            }
        }
    }
}


function FailPendingRequestsForServer(
    serverId,
    reason
) {
    serverId =
        NormalizeID(
            serverId
        );

    if (!serverId) {
        return;
    }

    reason =
        SafeField(
            reason ||
            'SERVER_OFFLINE'
        );

    for (
        const [
            key,
            pending
        ]
        of Array.from(
            state.pendingRequests.entries()
        )
    ) {
        if (
            pending.serverId !==
            serverId
        ) {
            continue;
        }

        state.pendingRequests.delete(
            key
        );

        const client =
            GetOnlineClient(
                pending.clientId
            );

        if (
            client
        ) {
            SendLine(
                client.socket,
                `ACK|ERROR|${pending.requestId}|${reason}`
            );
        }

        state.runtimeStats.ackError++;

        LogEvent(
            'ACK_FAILED',
            `${pending.requestId} / ${pending.clientId} / ${reason}`
        );
    }
}


function ClearAllPendingRequests() {
    state.pendingRequests.clear();
}


module.exports = {
    MakeRequestKey,

    RegisterPendingRequest,
    IsDuplicateRequest,

    HandleServerAck,

    CleanupRequestHistory,
    ProcessPendingRequests,

    FailPendingRequestsForServer,
    ClearAllPendingRequests
};
