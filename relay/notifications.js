'use strict';

const state =
    require(
        '../core/state'
    );

const {
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


function NotifyServerAuthorized(
    clientId,
    serverId,
    expiresAt
) {
    clientId =
        NormalizeID(
            clientId
        );

    serverId =
        NormalizeID(
            serverId
        );

    if (
        !clientId ||
        !serverId
    ) {
        return false;
    }

    const server =
        GetOnlineServer(
            serverId
        );

    if (!server) {
        return false;
    }

    const client =
        GetOnlineClient(
            clientId
        );

    const stateText =
        `AUTHORIZED|${expiresAt}`;

    /*
        같은 상태를 Server에 반복 전달하지 않는다.
    */
    if (
        client &&
        client.lastServerAuthState ===
        stateText
    ) {
        return true;
    }

    if (
        client
    ) {
        client.lastServerAuthState =
            stateText;
    }

    return SendLine(
        server.socket,
        `CLIENT_AUTHORIZED|${clientId}|${expiresAt}`
    );
}


function NotifyServerUnauthorized(
    clientId,
    reason
) {
    clientId =
        NormalizeID(
            clientId
        );

    if (!clientId) {
        return false;
    }

    const saved =
        GetSavedClientByID(
            clientId
        );

    if (!saved) {
        return false;
    }

    const server =
        GetOnlineServer(
            saved.serverId
        );

    if (!server) {
        return false;
    }

    const client =
        GetOnlineClient(
            clientId
        );

    const stateText =
        `UNAUTHORIZED|${reason}`;

    if (
        client &&
        client.lastServerAuthState ===
        stateText
    ) {
        return true;
    }

    if (
        client
    ) {
        client.lastServerAuthState =
            stateText;
    }

    return SendLine(
        server.socket,
        `CLIENT_UNAUTHORIZED|${clientId}|${SafeField(reason)}`
    );
}


function NoticeAll(
    text
) {
    const clean =
        SafeField(
            text
        );

    if (!clean) {
        return 0;
    }

    let count =
        0;

    for (
        const client
        of state.clients.values()
    ) {
        if (
            SendLine(
                client.socket,
                `NOTICE|${clean}`
            )
        ) {
            count++;
        }
    }

    state.runtimeStats.notices +=
        count;

    LogEvent(
        'NOTICE_ALL',
        `${count} / ${clean}`
    );

    return count;
}


function NoticeClient(
    clientId,
    text
) {
    clientId =
        NormalizeID(
            clientId
        );

    if (!clientId) {
        return false;
    }

    const client =
        GetOnlineClient(
            clientId
        );

    if (!client) {
        return false;
    }

    const clean =
        SafeField(
            text
        );

    if (!clean) {
        return false;
    }

    const ok =
        SendLine(
            client.socket,
            `NOTICE|${clean}`
        );

    if (
        ok
    ) {
        state.runtimeStats.notices++;

        LogEvent(
            'NOTICE_CLIENT',
            `${clientId} / ${clean}`
        );
    }

    return ok;
}


module.exports = {
    NotifyServerAuthorized,
    NotifyServerUnauthorized,

    NoticeAll,
    NoticeClient
};
