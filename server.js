const express = require('express');
const http = require('http');
const cors = require('cors');
const crypto = require('crypto');

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);

const commands = {};
const notifies = {};

const servers = {};
const clients = {};

const API_TOKEN = process.env.API_TOKEN || 'CHANGE_THIS_TOKEN';

const SERVER_TIMEOUT = 30000;
const CLIENT_TIMEOUT = 30000;

function CheckAuth(req, res) {
    const token = req.headers['x-api-token'];

    if (!token || token !== API_TOKEN) {
        res.status(401).send({
            error: 'unauthorized'
        });

        return false;
    }

    return true;
}

function CreateID(prefix) {
    return prefix + '-' + crypto.randomBytes(6).toString('hex').toUpperCase();
}

function Cleanup() {
    const now = Date.now();

    for (const id in servers) {
        if (now - servers[id].lastSeen > SERVER_TIMEOUT) {
            delete servers[id];
        }
    }

    for (const id in clients) {
        if (now - clients[id].lastSeen > CLIENT_TIMEOUT) {
            delete clients[id];
        }
    }
}

setInterval(Cleanup, 10000);

app.get('/', (req, res) => {
    res.send('Relay Server is Running 24/7!');
});

app.post('/register_server', (req, res) => {
    if (!CheckAuth(req, res))
        return;

    const serverId = CreateID('SERVER');

    servers[serverId] = {
        lastSeen: Date.now()
    };

    res.send({
        status: 'ok',
        serverId: serverId
    });
});

app.post('/heartbeat_server', (req, res) => {
    if (!CheckAuth(req, res))
        return;

    const { serverId } = req.body;

    if (!serverId || !servers[serverId]) {
        res.status(404).send({
            error: 'server_not_found'
        });

        return;
    }

    servers[serverId].lastSeen = Date.now();

    res.send({
        status: 'ok'
    });
});

app.get('/servers', (req, res) => {
    if (!CheckAuth(req, res))
        return;

    Cleanup();

    const list = Object.keys(servers);

    res.send({
        servers: list
    });
});

app.post('/register_client', (req, res) => {
    if (!CheckAuth(req, res))
        return;

    const clientId = CreateID('CLIENT');

    clients[clientId] = {
        lastSeen: Date.now(),
        serverId: ''
    };

    res.send({
        status: 'ok',
        clientId: clientId
    });
});

app.post('/connect_client', (req, res) => {
    if (!CheckAuth(req, res))
        return;

    const { clientId, serverId } = req.body;

    if (!clientId || !clients[clientId]) {
        res.status(404).send({
            error: 'client_not_found'
        });

        return;
    }

    if (!serverId || !servers[serverId]) {
        res.status(404).send({
            error: 'server_not_found'
        });

        return;
    }

    clients[clientId].serverId = serverId;
    clients[clientId].lastSeen = Date.now();

    res.send({
        status: 'ok'
    });
});

app.post('/heartbeat_client', (req, res) => {
    if (!CheckAuth(req, res))
        return;

    const { clientId } = req.body;

    if (!clientId || !clients[clientId]) {
        res.status(404).send({
            error: 'client_not_found'
        });

        return;
    }

    clients[clientId].lastSeen = Date.now();

    res.send({
        status: 'ok'
    });
});

app.post('/send_command', (req, res) => {
    if (!CheckAuth(req, res))
        return;

    const { roomId, command, message } = req.body;

    const val = command || message;

    if (!roomId || !val) {
        res.status(400).send({
            error: 'invalid_data'
        });

        return;
    }

    commands[roomId] = String(val);

    res.send({
        status: 'ok'
    });
});

app.get('/poll', (req, res) => {
    if (!CheckAuth(req, res))
        return;

    const roomId = req.query.roomId;

    if (roomId && commands[roomId]) {
        const value = commands[roomId];

        delete commands[roomId];

        res.send(value);

        return;
    }

    res.send('');
});

app.post('/send_notify', (req, res) => {
    if (!CheckAuth(req, res))
        return;

    const { roomId, message } = req.body;

    if (!roomId || !message) {
        res.status(400).send({
            error: 'invalid_data'
        });

        return;
    }

    notifies[roomId] = String(message);

    res.send({
        status: 'ok'
    });
});

app.get('/poll_notify', (req, res) => {
    if (!CheckAuth(req, res))
        return;

    const roomId = req.query.roomId;

    if (roomId && notifies[roomId]) {
        const value = notifies[roomId];

        delete notifies[roomId];

        res.send(value);

        return;
    }

    res.send('');
});

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
