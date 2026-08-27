const express = require('express');
const http = require('http');
const cors = require('cors');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

const API_TOKEN =
    process.env.API_TOKEN ||
    'Relay_2026_X7pK29mQ8zL4';

const SERVER_TIMEOUT = 15000;

const servers = {};
const clients = {};

function createServerId() {
    return (
        'SERVER-' +
        crypto
            .randomBytes(6)
            .toString('hex')
            .toUpperCase()
    );
}

function checkToken(req, res, next) {
    const token =
        req.headers['x-api-token'];

    if (!token || token !== API_TOKEN) {
        return res.status(401).json({
            error: 'unauthorized'
        });
    }

    next();
}

function isServerAlive(serverInfo) {
    if (!serverInfo) {
        return false;
    }

    return (
        Date.now() -
        serverInfo.lastHeartbeat
    ) <= SERVER_TIMEOUT;
}

app.get('/', (req, res) => {
    res.send(
        'Relay Server is Running 24/7!'
    );
});

app.post(
    '/server/register',
    checkToken,
    (req, res) => {
        let serverId =
            createServerId();

        while (servers[serverId]) {
            serverId =
                createServerId();
        }

        servers[serverId] = {
            serverId: serverId,
            lastHeartbeat: Date.now(),
            value: null
        };

        console.log(
            '[SERVER REGISTER]',
            serverId
        );

        res.status(200).send(
            serverId
        );
    }
);

app.post(
    '/server/heartbeat',
    checkToken,
    (req, res) => {
        const serverId =
            String(
                req.body.serverId || ''
            ).trim();

        if (!serverId) {
            return res.status(400).json({
                error: 'missing serverId'
            });
        }

        const serverInfo =
            servers[serverId];

        if (!serverInfo) {
            return res.status(404).json({
                error: 'server not found'
            });
        }

        serverInfo.lastHeartbeat =
            Date.now();

        res.status(200).json({
            status: 'ok'
        });
    }
);

app.post(
    '/connect',
    checkToken,
    (req, res) => {
        const clientId =
            String(
                req.headers['x-client-id'] ||
                req.query.clientId ||
                (
                    req.body &&
                    req.body.clientId
                ) ||
                ''
            ).trim();

        console.log(
            '[CONNECT]',
            'clientId =',
            clientId
        );

        if (!clientId) {
            return res.status(400).json({
                error: 'missing clientId'
            });
        }

        let selectedServer = null;

        for (
            const serverId
            of Object.keys(servers)
        ) {
            const serverInfo =
                servers[serverId];

            if (
                isServerAlive(
                    serverInfo
                )
            ) {
                selectedServer =
                    serverInfo;

                break;
            }
        }

        if (!selectedServer) {
            return res.status(503).json({
                error: 'no server available'
            });
        }

        clients[clientId] = {
            clientId: clientId,
            serverId:
                selectedServer.serverId,
            lastSeen: Date.now()
        };

        console.log(
            '[CLIENT CONNECT]',
            clientId,
            '->',
            selectedServer.serverId
        );

        res.status(200).send(
            selectedServer.serverId
        );
    }
);

app.post(
    '/send_number',
    checkToken,
    (req, res) => {
        const serverId =
            String(
                req.body.serverId || ''
            ).trim();

        const clientId =
            String(
                req.body.clientId || ''
            ).trim();

        const number =
            req.body.number;

        if (!serverId) {
            return res.status(400).json({
                error: 'missing serverId'
            });
        }

        if (!clientId) {
            return res.status(400).json({
                error: 'missing clientId'
            });
        }

        if (
            number === undefined ||
            number === null
        ) {
            return res.status(400).json({
                error: 'missing number'
            });
        }

        const serverInfo =
            servers[serverId];

        if (!serverInfo) {
            return res.status(404).json({
                error: 'server not found'
            });
        }

        if (
            !isServerAlive(
                serverInfo
            )
        ) {
            return res.status(503).json({
                error: 'server offline'
            });
        }

        const clientInfo =
            clients[clientId];

        if (!clientInfo) {
            return res.status(403).json({
                error: 'client not connected'
            });
        }

        if (
            clientInfo.serverId !==
            serverId
        ) {
            return res.status(403).json({
                error:
                    'client/server mismatch'
            });
        }

        const numberText =
            String(number).trim();

        if (
            numberText === '' ||
            !/^-?\d+$/.test(
                numberText
            )
        ) {
            return res.status(400).json({
                error: 'number only'
            });
        }

        serverInfo.value =
            numberText;

        clientInfo.lastSeen =
            Date.now();

        console.log(
            '[NUMBER]',
            clientId,
            '->',
            serverId,
            ':',
            numberText
        );

        res.status(200).json({
            status: 'ok'
        });
    }
);

app.get(
    '/poll_number',
    checkToken,
    (req, res) => {
        const serverId =
            String(
                req.query.serverId || ''
            ).trim();

        if (!serverId) {
            return res.status(400).send('');
        }

        const serverInfo =
            servers[serverId];

        if (!serverInfo) {
            return res.send('');
        }

        serverInfo.lastHeartbeat =
            Date.now();

        if (
            serverInfo.value === null
        ) {
            return res.send('');
        }

        const value =
            serverInfo.value;

        serverInfo.value = null;

        res.send(value);
    }
);

setInterval(
    () => {
        const now =
            Date.now();

        for (
            const serverId
            of Object.keys(servers)
        ) {
            if (
                now -
                servers[serverId]
                    .lastHeartbeat >
                SERVER_TIMEOUT
            ) {
                console.log(
                    '[SERVER OFFLINE]',
                    serverId
                );

                delete servers[
                    serverId
                ];
            }
        }

        for (
            const clientId
            of Object.keys(clients)
        ) {
            if (
                now -
                clients[clientId]
                    .lastSeen >
                SERVER_TIMEOUT * 4
            ) {
                delete clients[
                    clientId
                ];
            }
        }
    },
    5000
);

server.listen(
    PORT,
    () => {
        console.log(
            'Relay Server running on port ' +
            PORT
        );
    }
);
