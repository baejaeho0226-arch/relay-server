const express = require('express');
const http = require('http');
const cors = require('cors');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);

app.use(cors());
app.use(express.json());

const API_TOKEN = process.env.API_TOKEN || 'Relay_2026_X7pK29mQ8zL4';

const SERVER_TIMEOUT = 15000;

let activeServer = null;
const queues = {};
const clients = {};

function CheckToken(req, res, next) {
    const token = req.headers['x-api-token'];

    if (token !== API_TOKEN) {
        return res.status(401).send('INVALID_TOKEN');
    }

    next();
}

function GenerateServerID() {
    return 'SERVER-' +
        crypto.randomBytes(6).toString('hex').toUpperCase();
}

function GenerateClientID() {
    return 'CLIENT-' +
        crypto.randomBytes(8).toString('hex').toUpperCase();
}

app.get('/', (req, res) => {
    res.send('Relay Server is Running 24/7!');
});

app.post('/server/register', CheckToken, (req, res) => {
    const now = Date.now();

    if (
        activeServer &&
        now - activeServer.lastSeen < SERVER_TIMEOUT
    ) {
        return res.status(409).send('SERVER_ALREADY_RUNNING');
    }

    const serverId = GenerateServerID();

    activeServer = {
        id: serverId,
        lastSeen: now
    };

    queues[serverId] = [];

    res.type('text/plain');
    res.send(serverId);
});

app.post('/server/heartbeat', CheckToken, (req, res) => {
    const serverId = String(
        req.body.serverId || ''
    ).trim();

    if (
        !activeServer ||
        activeServer.id !== serverId
    ) {
        return res.status(404).send('SERVER_NOT_FOUND');
    }

    activeServer.lastSeen = Date.now();

    res.send('OK');
});

app.post('/connect', CheckToken, (req, res) => {
    const clientId = String(
        req.body.clientId || ''
    ).trim();

    if (clientId === '') {
        return res.status(400).send('INVALID_CLIENT');
    }

    if (
        !activeServer ||
        Date.now() - activeServer.lastSeen >= SERVER_TIMEOUT
    ) {
        activeServer = null;
        return res.status(503).send('SERVER_OFFLINE');
    }

    clients[clientId] = {
        serverId: activeServer.id,
        lastSeen: Date.now()
    };

    res.type('text/plain');
    res.send(activeServer.id);
});

app.post('/send_number', CheckToken, (req, res) => {
    const serverId = String(
        req.body.serverId || ''
    ).trim();

    const clientId = String(
        req.body.clientId || ''
    ).trim();

    const number = String(
        req.body.number || ''
    ).trim();

    if (
        serverId === '' ||
        clientId === '' ||
        number === ''
    ) {
        return res.status(400).send('INVALID_DATA');
    }

    if (
        !activeServer ||
        activeServer.id !== serverId ||
        Date.now() - activeServer.lastSeen >= SERVER_TIMEOUT
    ) {
        return res.status(503).send('SERVER_OFFLINE');
    }

    if (!clients[clientId]) {
        return res.status(403).send('CLIENT_NOT_CONNECTED');
    }

    if (clients[clientId].serverId !== serverId) {
        return res.status(403).send('CLIENT_SERVER_MISMATCH');
    }

    if (!/^-?\d+$/.test(number)) {
        return res.status(400).send('NUMBER_ONLY');
    }

    if (!queues[serverId]) {
        queues[serverId] = [];
    }

    queues[serverId].push({
        clientId: clientId,
        number: number,
        time: Date.now()
    });

    clients[clientId].lastSeen = Date.now();

    res.send('OK');
});

app.get('/poll_number', CheckToken, (req, res) => {
    const serverId = String(
        req.query.serverId || ''
    ).trim();

    if (
        !activeServer ||
        activeServer.id !== serverId ||
        Date.now() - activeServer.lastSeen >= SERVER_TIMEOUT
    ) {
        return res.status(503).send('');
    }

    if (
        !queues[serverId] ||
        queues[serverId].length === 0
    ) {
        return res.send('');
    }

    const item =
        queues[serverId].shift();

    res.type('text/plain');
    res.send(item.number);
});

const PORT =
    process.env.PORT || 3000;

server.listen(PORT, () => {
    console.log(
        'Relay Server started on port ' +
        PORT
    );
});
