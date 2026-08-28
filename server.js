const net = require('net');

const PORT = Number(process.env.PORT || 3000);

const SERVER_ID =
    process.env.SERVER_ID || 'SERVER-D6EB849D4436';

const API_TOKEN =
    process.env.API_TOKEN || 'Relay_2026_X7pK29mQ8zL4';

const queues = [];

const clients = new Map();

function log(message) {
    console.log(new Date().toISOString() + ' ' + message);
}

function sendLine(socket, text) {
    if (!socket.destroyed) {
        socket.write(text + '\n');
    }
}

function processCommand(socket, line) {
    line = line.trim();

    if (!line) {
        return;
    }

    const parts = line.split('|');
    const command = parts[0];

    /*
        CONNECT|TOKEN|SERVER_ID|CLIENT_ID
    */
    if (command === 'CONNECT') {

        if (parts.length !== 4) {
            sendLine(socket, 'ERROR|INVALID_DATA');
            return;
        }

        const token = parts[1];
        const serverId = parts[2];
        const clientId = parts[3];

        if (token !== API_TOKEN) {
            sendLine(socket, 'ERROR|INVALID_TOKEN');
            log('CONNECT rejected: INVALID_TOKEN');
            return;
        }

        if (serverId !== SERVER_ID) {
            sendLine(socket, 'ERROR|SERVER_NOT_FOUND');
            log(
                'CONNECT rejected: invalid SERVER-ID=' +
                serverId
            );
            return;
        }

        if (!clientId) {
            sendLine(socket, 'ERROR|INVALID_CLIENT_ID');
            return;
        }

        clients.set(clientId, {
            socket: socket,
            serverId: serverId,
            connectedAt: Date.now()
        });

        sendLine(
            socket,
            'CONNECTED|' + SERVER_ID + '|' + clientId
        );

        log(
            'CLIENT CONNECTED: ' +
            clientId +
            ' SERVER=' +
            serverId
        );

        return;
    }

    /*
        SEND|TOKEN|SERVER_ID|CLIENT_ID|NUMBER
    */
    if (command === 'SEND') {

        if (parts.length !== 5) {
            sendLine(socket, 'ERROR|INVALID_DATA');
            return;
        }

        const token = parts[1];
        const serverId = parts[2];
        const clientId = parts[3];
        const number = parts[4];

        if (token !== API_TOKEN) {
            sendLine(socket, 'ERROR|INVALID_TOKEN');
            return;
        }

        if (serverId !== SERVER_ID) {
            sendLine(socket, 'ERROR|SERVER_NOT_FOUND');
            return;
        }

        const client = clients.get(clientId);

        if (!client) {
            sendLine(socket, 'ERROR|CLIENT_NOT_CONNECTED');
            return;
        }

        if (client.serverId !== SERVER_ID) {
            sendLine(socket, 'ERROR|SERVER_NOT_FOUND');
            return;
        }

        if (!/^-?\d+$/.test(number)) {
            sendLine(socket, 'ERROR|NUMBER_ONLY');
            return;
        }

        queues.push({
            serverId: serverId,
            clientId: clientId,
            number: number,
            time: Date.now()
        });

        sendLine(socket, 'SENT|OK');

        log(
            'NUMBER QUEUED: ' +
            number +
            ' CLIENT=' +
            clientId +
            ' SERVER=' +
            serverId
        );

        return;
    }

    /*
        POLL|TOKEN|SERVER_ID
    */
    if (command === 'POLL') {

        if (parts.length !== 3) {
            sendLine(socket, 'ERROR|INVALID_DATA');
            return;
        }

        const token = parts[1];
        const serverId = parts[2];

        if (token !== API_TOKEN) {
            sendLine(socket, 'ERROR|INVALID_TOKEN');
            return;
        }

        if (serverId !== SERVER_ID) {
            sendLine(socket, 'ERROR|SERVER_NOT_FOUND');
            return;
        }

        const index = queues.findIndex(
            item => item.serverId === serverId
        );

        if (index === -1) {
            sendLine(socket, 'EMPTY');
            return;
        }

        const item = queues.splice(index, 1)[0];

        sendLine(
            socket,
            'NUMBER|' + item.number
        );

        log(
            'NUMBER DELIVERED: ' +
            item.number +
            ' CLIENT=' +
            item.clientId
        );

        return;
    }

    sendLine(socket, 'ERROR|UNKNOWN_COMMAND');
}

const server = net.createServer(socket => {

    const remote =
        socket.remoteAddress +
        ':' +
        socket.remotePort;

    log('TCP CONNECT: ' + remote);

    let buffer = '';

    socket.setEncoding('utf8');

    socket.on('data', data => {

        buffer += data;

        while (true) {

            const newlineIndex = buffer.indexOf('\n');

            if (newlineIndex === -1) {
                break;
            }

            let line =
                buffer.substring(0, newlineIndex);

            buffer =
                buffer.substring(newlineIndex + 1);

            line = line.replace(/\r$/, '');

            processCommand(socket, line);
        }
    });

    socket.on('close', () => {

        for (const [clientId, client] of clients) {

            if (client.socket === socket) {
                clients.delete(clientId);

                log(
                    'CLIENT DISCONNECTED: ' +
                    clientId
                );
            }
        }

        log('TCP CLOSE: ' + remote);
    });

    socket.on('error', error => {

        log(
            'SOCKET ERROR ' +
            remote +
            ': ' +
            error.message
        );
    });
});

server.listen(PORT, '0.0.0.0', () => {

    console.log('================================');
    console.log(' RAW TCP RELAY SERVER');
    console.log('================================');

    console.log('SERVER-ID: ' + SERVER_ID);
    console.log('TCP PORT: ' + PORT);

    console.log('Protocol: RAW TCP');
    console.log('HTTP: DISABLED');
    console.log('HTTPS: DISABLED');
    console.log('WebSocket: DISABLED');
    console.log('FTP: DISABLED');

    console.log('================================');
});
