const express = require('express');
const http = require('http');
const cors = require('cors');

const app = express();

app.use(cors());
app.use(express.json());

const server = http.createServer(app);

const commands = {};
const notifies = {};

const API_TOKEN = process.env.API_TOKEN || 'CHANGE_THIS_TOKEN';

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

app.get('/', (req, res) => {
    res.send('Relay Server is Running 24/7!');
});

app.post('/send_command', (req, res) => {
    if (!CheckAuth(req, res))
        return;

    const { roomId, command, message } = req.body;

    const val = command || message;

    if (!roomId || !val) {
        res.status(400).send({
            error: 'invalid data'
        });

        return;
    }

    commands[roomId] = String(val);

    res.status(200).send({
        status: 'ok'
    });
});

app.get('/poll', (req, res) => {
    if (!CheckAuth(req, res))
        return;

    const roomId = req.query.roomId;

    if (roomId && commands[roomId]) {
        const cmd = commands[roomId];

        delete commands[roomId];

        res.send(cmd);

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
            error: 'invalid data'
        });

        return;
    }

    notifies[roomId] = String(message);

    res.status(200).send({
        status: 'ok'
    });
});

app.get('/poll_notify', (req, res) => {
    if (!CheckAuth(req, res))
        return;

    const roomId = req.query.roomId;

    if (roomId && notifies[roomId]) {
        const msg = notifies[roomId];

        delete notifies[roomId];

        res.send(msg);

        return;
    }

    res.send('');
});

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
