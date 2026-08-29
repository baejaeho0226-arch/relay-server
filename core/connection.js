'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const config = require('../config/config');
const state = require('../core/state');

const { HOST, PORT, HEALTH_PORT, DATA_DIR, DB_FILE, DB_BAK_FILE, BACKUP_DIR, AUDIT_DIR, CURRENT_PROTOCOL_VERSION, DEFAULT_MIN_PROTOCOL_VERSION, DEFAULT_MIN_SERVER_VERSION, DEFAULT_MIN_CLIENT_VERSION, ADMIN_CREDENTIALS, ADMIN_AUTH_WINDOW_SECONDS, ADMIN_SESSION_TIMEOUT_MS, CONFIRM_TOKEN_TTL_MS, SERVER_KICK_BLOCK_MS, CLIENT_KICK_BLOCK_MS, RATE_LIMIT_WINDOW_MS, RATE_LIMIT_MAX, MAX_CLIENTS_PER_SERVER, REQUEST_HISTORY_TIMEOUT_MS, ACK_RETRY_MS, ACK_TIMEOUT_MS, ACK_MAX_RETRIES, MAX_INPUT_BUFFER, MAX_BULK_KEYS, MAX_SEARCH_RESULTS, MAX_EVENT_MEMORY, AUTO_BACKUP_INTERVAL_MS, MAX_BACKUPS, DANGEROUS_PREFIXES } = config;
const { servers, clients, serverIdentities, clientIdentities, licenses, disabledServers, drainingServers, disabledClients, kickedServers, kickedClients, requestHistory, pendingRequests, rateLimits, events, confirmTokens, ipHistory, runtimeStats } = state;

function DisconnectConnection(...args) { return require('./lifecycle').DisconnectConnection(...args); }
function HandleAdminLine(...args) { return require('../admin/adminHandler').HandleAdminLine(...args); }
function HandleClientLine(...args) { return require('../relay/clientHandler').HandleClientLine(...args); }
function HandleServerLine(...args) { return require('../relay/serverHandler').HandleServerLine(...args); }
function Now(...args) { return require('./utils').Now(...args); }
function SafeIP(...args) { return require('./utils').SafeIP(...args); }
function SendLine(...args) { return require('./utils').SendLine(...args); }

function CreateConnection(socket) {
    runtimeStats.totalConnections++;
    const connection={
        socket,type:null,registered:false,connected:false,identityKey:'',serverId:'',clientId:'',
        protocolVersion:0,appVersion:'',licenseAuthorized:false,licenseKey:'',licenseExpiresAt:0,lastExpiryWarningDay:null,
        lastServerAuthState:'',adminAuthenticated:false,adminAuthenticatedAt:0,adminNonce:'',adminNonceCreatedAt:0,
        adminRole:'',pendingAdminRole:'',lastSeen:Now(),lastIP:SafeIP(socket),clients:new Set(),buffer:'',
        pendingPingToken:'',pendingPingAt:0,rttMs:-1,reconnectCount:0,disconnected:false
    };
    socket.setNoDelay(true);socket.setKeepAlive(true,10000);
    socket.on('data',data=>{
        connection.buffer+=data.toString('utf8');
        if(connection.buffer.length>MAX_INPUT_BUFFER){SendLine(socket,'ERROR|BUFFER_OVERFLOW');socket.destroy();return;}
        while(true){
            const pos=connection.buffer.indexOf('\n');if(pos<0)break;
            let line=connection.buffer.substring(0,pos).replace(/\r$/,'');connection.buffer=connection.buffer.substring(pos+1);
            if(!connection.type){
                if(line==='REGISTER'||line.startsWith('REGISTER|'))connection.type='server';
                else if(line==='CONNECT'||line.startsWith('CONNECT|')||line.startsWith('LICENSE_AUTH|')||line.startsWith('SEND|'))connection.type='client';
                else if(line==='ADMIN_HELLO'||line.startsWith('ADMIN_HELLO|')||line.startsWith('ADMIN_AUTH|'))connection.type='admin';
                else{SendLine(socket,'ERROR|UNKNOWN_COMMAND');continue;}
            }
            if(connection.type==='server')HandleServerLine(connection,line);else if(connection.type==='client')HandleClientLine(connection,line);else HandleAdminLine(connection,line);
        }
    });
    socket.on('close',()=>DisconnectConnection(connection));
    socket.on('error',error=>console.error('[SOCKET ERROR]',error.message));
}

module.exports = {
    CreateConnection
};
