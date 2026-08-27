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

const SERVER_ID = process.env.SERVER_ID || 'SERVER-' + crypto.randomBytes(6).toString('hex').toUpperCase();

const clients = {};
const pendingValues = {};

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
        serverId: '',
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
    const ClientID = String(req.body.clientId || '');
    const RequestedServerID = String(req.body.serverId || '');

    if (ClientID === '' || RequestedServerID === '') {
        return res.status(400).json({
            error: 'INVALID_DATA'
        });
    }

    if (RequestedServerID !== SERVER_ID) {
        return res.status(404).json({
            error: 'SERVER_NOT_FOUND'
        });
    }

    if (!clients[ClientID]) {
        return res.status(404).json({
            error: 'CLIENT_NOT_FOUND'
        });
    }

    clients[ClientID].serverId = SERVER_ID;
    clients[ClientID].connected = true;
    clients[ClientID].lastSeen = Date.now();

    res.json({
        status: 'ok',
        connected: true,
        serverId: SERVER_ID,
        clientId: ClientID
    });
});

app.post('/send_number', CheckToken, (req, res) => {
    const ClientID = String(req.body.clientId || '');
    const ServerID = String(req.body.serverId || '');
    const NumberValue = String(req.body.number || '');

    if (ClientID === '' || ServerID === '' || NumberValue === '') {
        return res.status(400).json({
            error: 'INVALID_DATA'
        });
    }

    if (ServerID !== SERVER_ID) {
        return res.status(404).json({
            error: 'SERVER_NOT_FOUND'
        });
    }

    if (!clients[ClientID]) {
        return res.status(404).json({
            error: 'CLIENT_NOT_FOUND'
        });
    }

    if (
        !clients[ClientID].connected ||
        clients[ClientID].serverId !== SERVER_ID
    ) {
        return res.status(403).json({
            error: 'CLIENT_NOT_CONNECTED'
        });
    }

    if (!/^[0-9]+$/.test(NumberValue)) {
        return res.status(400).json({
            error: 'NUMBER_ONLY'
        });
    }

    clients[ClientID].lastSeen = Date.now();

    if (!pendingValues[SERVER_ID]) {
        pendingValues[SERVER_ID] = [];
    }

    pendingValues[SERVER_ID].push({
        clientId: ClientID,
        number: NumberValue,
        time: Date.now()
    });

    res.json({
        status: 'ok'
    });
});

app.get('/poll_number', CheckToken, (req, res) => {
    const ServerID = String(req.query.serverId || '');

    if (ServerID === '') {
        return res.status(400).send('');
    }

    if (ServerID !== SERVER_ID) {
        return res.status(404).send('');
    }

    if (
        !pendingValues[SERVER_ID] ||
        pendingValues[SERVER_ID].length === 0
    ) {
        return res.send('');
    }

    const Item = pendingValues[SERVER_ID].shift();

    res.send(Item.number);
});

app.post('/disconnect_client', CheckToken, (req, res) => {
    const ClientID = String(req.body.clientId || '');

    if (ClientID === '') {
        return res.status(400).json({
            error: 'INVALID_DATA'
        });
    }

    if (!clients[ClientID]) {
        return res.status(404).json({
            error: 'CLIENT_NOT_FOUND'
        });
    }

    clients[ClientID].connected = false;
    clients[ClientID].serverId = '';

    res.json({
        status: 'ok'
    });
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
