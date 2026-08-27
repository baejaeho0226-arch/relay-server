const express = require('express');
const http = require('http');
const cors = require('cors');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const API_TOKEN = process.env.API_TOKEN || '';

const SERVER_ID = 'SERVER-' + crypto.randomBytes(6).toString('hex').toUpperCase();

const clients = {};
const values = {};

function CheckToken(req, res, next) {
    if (API_TOKEN === '') {
        return res.status(500).json({
            error: 'API_TOKEN_NOT_CONFIGURED'
        });
    }

    const Token = req.headers['x-api-token'];

    if (Token !== API_TOKEN) {
        return res.status(401).json({
            error: 'UNAUTHORIZED'
        });
    }

    next();
}

function CreateClientID() {
    let ClientID;

    do {
        ClientID =
            'CLIENT-' +
            crypto.randomBytes(6).toString('hex').toUpperCase();
    } while (clients[ClientID]);

    return ClientID;
}

app.get('/', (req, res) => {
    res.send('Relay Server is Running 24/7!');
});

app.get('/server_info', CheckToken, (req, res) => {
    res.json({
        status: 'ok',
        serverId: SERVER_ID
    });
});

app.post('/register_client', CheckToken, (req, res) => {
    const ClientID = CreateClientID();

    clients[ClientID] = {
        connectedServer: '',
        connected: false,
        createdAt: Date.now(),
        lastSeen: Date.now()
    };

    res.json({
        status: 'ok',
        clientId: ClientID
    });
});

app.post('/connect_client', CheckToken, (req, res) => {
    const { clientId, serverId } = req.body;

    if (!clientId || !serverId) {
        return res.status(400).json({
            error: 'INVALID_DATA'
        });
    }

    if (serverId !== SERVER_ID) {
        return res.status(404).json({
            error: 'SERVER_NOT_FOUND'
        });
    }

    if (!clients[clientId]) {
        return res.status(404).json({
            error: 'CLIENT_NOT_FOUND'
        });
    }

    clients[clientId].connectedServer = serverId;
    clients[clientId].connected = true;
    clients[clientId].lastSeen = Date.now();

    res.json({
        status: 'ok',
        serverId: SERVER_ID,
        clientId: clientId,
        connected: true
    });
});

app.post('/send_command', CheckToken, (req, res) => {
    const { roomId, command, message, clientId } = req.body;

    const Value = command !== undefined
        ? String(command)
        : message !== undefined
            ? String(message)
            : '';

    if (!roomId || Value === '') {
        return res.status(400).json({
            error: 'INVALID_DATA'
        });
    }

    if (clientId) {
        if (!clients[clientId]) {
            return res.status(404).json({
                error: 'CLIENT_NOT_FOUND'
            });
        }

        if (
            clients[clientId].connectedServer !== roomId ||
            !clients[clientId].connected
        ) {
            return res.status(403).json({
                error: 'CLIENT_NOT_CONNECTED'
            });
        }

        clients[clientId].lastSeen = Date.now();

        if (!values[roomId]) {
            values[roomId] = {};
        }

        values[roomId][clientId] = Value;
    } else {
        if (!values[roomId]) {
            values[roomId] = {};
        }

        values[roomId].broadcast = Value;
    }

    res.json({
        status: 'ok'
    });
});

app.get('/poll', CheckToken, (req, res) => {
    const { roomId, clientId } = req.query;

    if (!roomId) {
        return res.status(400).send('');
    }

    if (clientId) {
        if (!clients[clientId]) {
            return res.status(404).send('');
        }

        if (
            clients[clientId].connectedServer !== roomId ||
            !clients[clientId].connected
        ) {
            return res.status(403).send('');
        }

        clients[clientId].lastSeen = Date.now();

        if (
            values[roomId] &&
            values[roomId][clientId] !== undefined
        ) {
            const Value = values[roomId][clientId];

            delete values[roomId][clientId];

            return res.send(Value);
        }

        return res.send('');
    }

    if (
        values[roomId] &&
        values[roomId].broadcast !== undefined
    ) {
        const Value = values[roomId].broadcast;

        delete values[roomId].broadcast;

        return res.send(Value);
    }

    res.send('');
});

app.post('/disconnect_client', CheckToken, (req, res) => {
    const { clientId } = req.body;

    if (!clientId) {
        return res.status(400).json({
            error: 'INVALID_DATA'
        });
    }

    if (!clients[clientId]) {
        return res.status(404).json({
            error: 'CLIENT_NOT_FOUND'
        });
    }

    clients[clientId].connected = false;
    clients[clientId].connectedServer = '';
    clients[clientId].lastSeen = Date.now();

    res.json({
        status: 'ok'
    });
});

app.post('/send_notify', CheckToken, (req, res) => {
    const { roomId, message } = req.body;

    if (!roomId || message === undefined) {
        return res.status(400).json({
            error: 'INVALID_DATA'
        });
    }

    if (!values[roomId]) {
        values[roomId] = {};
    }

    values[roomId].notify = String(message);

    res.json({
        status: 'ok'
    });
});

app.get('/poll_notify', CheckToken, (req, res) => {
    const { roomId } = req.query;

    if (!roomId) {
        return res.status(400).send('');
    }

    if (
        values[roomId] &&
        values[roomId].notify !== undefined
    ) {
        const Message = values[roomId].notify;

        delete values[roomId].notify;

        return res.send(Message);
    }

    res.send('');
});

setInterval(() => {
    const Now = Date.now();

    Object.keys(clients).forEach((ClientID) => {
        if (
            Now - clients[ClientID].lastSeen >
            5 * 60 * 1000
        ) {
            delete clients[ClientID];
        }
    });
}, 60000);

server.listen(PORT, () => {
    console.log('Relay Server is Running');
    console.log('PORT:', PORT);
    console.log('SERVER ID:', SERVER_ID);
});
