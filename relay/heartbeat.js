'use strict';

const {
    Now,
    RandomHex,
    SendLine
} = require(
    '../core/utils'
);


function ServerHealth(
    connection
) {
    if (!connection) {
        return 'OFFLINE';
    }

    const age =
        Now() -
        connection.lastSeen;

    if (
        age >
        25000
    ) {
        return 'UNSTABLE';
    }

    if (
        connection.rttMs < 0
    ) {
        return 'CONNECTING';
    }

    if (
        connection.rttMs <= 300
    ) {
        return 'GOOD';
    }

    if (
        connection.rttMs <= 1000
    ) {
        return 'SLOW';
    }

    return 'UNSTABLE';
}


function ClientHealth(
    connection
) {
    return ServerHealth(
        connection
    );
}


function SendPing(
    connection
) {
    if (
        !connection ||
        !connection.socket ||
        connection.socket.destroyed
    ) {
        return false;
    }

    const token =
        RandomHex(6);

    const sentAt =
        Now();

    connection.pendingPingToken =
        token;

    connection.pendingPingAt =
        sentAt;

    return SendLine(
        connection.socket,
        `PING|${token}|${sentAt}`
    );
}


function HandlePong(
    connection,
    parts
) {
    if (!connection) {
        return;
    }

    connection.lastSeen =
        Now();

    const token =
        Array.isArray(
            parts
        )
            ? (
                parts[1] ||
                ''
            )
            : '';

    if (
        token &&
        token ===
        connection.pendingPingToken &&
        connection.pendingPingAt >
        0
    ) {
        connection.rttMs =
            Math.max(
                0,
                Now() -
                connection.pendingPingAt
            );

        connection.pendingPingToken =
            '';

        connection.pendingPingAt =
            0;
    }
}


module.exports = {
    ServerHealth,
    ClientHealth,

    SendPing,
    HandlePong
};
