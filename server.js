const express = require('express');
const http = require('http');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);

// 통신 데이터 저장용
const commands = {};
const notifies = {};

// 기본 루트 확인용
app.get('/', (req, res) => {
    res.send('Relay Server is Running 24/7!');
});

// 명령 전송 (앱 -> 서버)
app.post('/send_command', (req, res) => {
    const { roomId, command, message } = req.body;
    const val = command || message || '1';
    if (roomId) {
        commands[roomId] = val;
        return res.status(200).send({ status: 'ok' });
    }
    res.status(400).send({ error: 'invalid data' });
});

// 명령 폴링 (C++ -> 서버)
app.get('/poll', (req, res) => {
    const roomId = req.query.roomId;
    if (roomId && commands[roomId]) {
        const cmd = commands[roomId];
        delete commands[roomId];
        return res.send(cmd);
    }
    res.send('');
});

// 알림 전송 (C++ -> 서버)
app.post('/send_notify', (req, res) => {
    const { roomId, message } = req.body;
    if (roomId && message) {
        notifies[roomId] = message;
        return res.status(200).send({ status: 'ok' });
    }
    res.status(400).send({ error: 'invalid data' });
});

// 알림 폴링 (앱 -> 서버)
app.get('/poll_notify', (req, res) => {
    const roomId = req.query.roomId;
    if (roomId && notifies[roomId]) {
        const msg = notifies[roomId];
        delete notifies[roomId];
        return res.send(msg);
    }
    res.send('');
});

// Railway가 자동으로 지정해 주는 PORT를 사용하도록 설정
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});