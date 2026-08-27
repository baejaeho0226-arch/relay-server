const express = require('express');
const http = require('http');
const cors = require('cors');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);

app.use(cors());
app.use(express.json());

const API_TOKEN = process.env.API_TOKEN || 'Relay_2026_X7pK29mQ8zL4';
const SERVER_ID = process.env.SERVER_ID || 'SERVER-D6EB849D4436';

const clients = {};
const queues = {};

function CheckToken(req, res, next) {
    const token = req.headers['x-api-token'];

    if (token !== API_TOKEN) {
        return res.status(401).json({
            error: 'INVALID_TOKEN'
        });
    }

    next();
}

app.get('/', (req, res) => {
    res.send('Relay Server is Running 24/7!');
});

app.get('/server_info', CheckToken, (req, res) => {
    res.json({
        serverId: SERVER_ID
    });
});

app.post('/connect', CheckToken, (req, res) => {
    const serverId = req.body.serverId;
    const clientId = req.body.clientId;

    if (!serverId || !clientId) {
        return res.status(400).json({
            error: 'INVALID_DATA'
        });
    }

    if (serverId !== SERVER_ID) {
        return res.status(404).json({
            error: 'SERVER_NOT_FOUND'
        });
    }

    clients[clientId] = {
        serverId: serverId,
        connectedAt: Date.now()
    };

    if (!queues[serverId]) {
        queues[serverId] = [];
    }

    res.json({
        status: 'connected',
        serverId: SERVER_ID,
        clientId: clientId
    });
});

app.post('/send_number', CheckToken, (req, res) => {
    const serverId = req.body.serverId;
    const clientId = req.body.clientId;
    const number = String(req.body.number || '').trim();

    if (!serverId || !clientId || !number) {
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
        return res.status(403).json({
            error: 'CLIENT_NOT_CONNECTED'
        });
    }

    if (!/^-?\d+$/.test(number)) {
        return res.status(400).json({
            error: 'NUMBER_ONLY'
        });
    }

    if (!queues[serverId]) {
        queues[serverId] = [];
    }

    queues[serverId].push({
        clientId: clientId,
        number: number,
        time: Date.now()
    });

    res.json({
        status: 'ok'
    });
});

app.get('/poll_number', CheckToken, (req, res) => {
    const serverId = req.query.serverId;

    if (!serverId) {
        return res.status(400).send('');
    }

    if (serverId !== SERVER_ID) {
        return res.status(404).send('');
    }

    if (!queues[serverId] || queues[serverId].length === 0) {
        return res.send('');
    }

    const item = queues[serverId].shift();

    res.type('text/plain');
    res.send(item.number);
});

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
    console.log('Relay Server started');
    console.log('SERVER-ID: ' + SERVER_ID);
    console.log('PORT: ' + PORT);
});
