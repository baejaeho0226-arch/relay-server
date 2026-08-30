'use strict';

const { Now } = require('../core/utils');

const streams = new Set();
let timer = null;

function WriteEvent(res, event, data) {
    try {
        res.write(`event: ${event}\n`);
        res.write(`data: ${JSON.stringify(data)}\n\n`);
        return true;
    } catch (_) {
        return false;
    }
}

function EnsureTimer() {
    if (timer) return;
    timer = setInterval(() => {
        const now = Now();
        for (const item of Array.from(streams)) {
            if (!item.session || item.session.expiresAt <= now) {
                try { WriteEvent(item.res, 'session', { expired: true }); item.res.end(); } catch (_) {}
                streams.delete(item);
                continue;
            }
            if (!WriteEvent(item.res, 'tick', { time: now })) streams.delete(item);
        }
        if (streams.size === 0 && timer) {
            clearInterval(timer);
            timer = null;
        }
    }, 3000);
    timer.unref();
}

function BroadcastEvent(data) {
    for (const item of Array.from(streams)) {
        if (!item.session || item.session.expiresAt <= Now()) continue;
        if (!WriteEvent(item.res, 'relay-event', data)) streams.delete(item);
    }
}

function BroadcastNotification(data) {
    for (const item of Array.from(streams)) {
        if (!item.session || item.session.expiresAt <= Now()) continue;
        if (!WriteEvent(item.res, 'notification', data)) streams.delete(item);
    }
}

function OpenEventStream(req, res, session) {
    res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no'
    });
    res.write(': connected\n\n');
    WriteEvent(res, 'ready', { time: Now(), role: session.role });

    const item = { res, session };
    streams.add(item);
    EnsureTimer();

    req.on('close', () => streams.delete(item));
}

module.exports = {
    OpenEventStream,
    BroadcastEvent,
    BroadcastNotification
};
