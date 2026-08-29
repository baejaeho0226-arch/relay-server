'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const config = require('../config/config');
const state = require('../core/state');

const { HOST, PORT, HEALTH_PORT, DATA_DIR, DB_FILE, DB_BAK_FILE, BACKUP_DIR, AUDIT_DIR, CURRENT_PROTOCOL_VERSION, DEFAULT_MIN_PROTOCOL_VERSION, DEFAULT_MIN_SERVER_VERSION, DEFAULT_MIN_CLIENT_VERSION, ADMIN_CREDENTIALS, ADMIN_AUTH_WINDOW_SECONDS, ADMIN_SESSION_TIMEOUT_MS, CONFIRM_TOKEN_TTL_MS, SERVER_KICK_BLOCK_MS, CLIENT_KICK_BLOCK_MS, RATE_LIMIT_WINDOW_MS, RATE_LIMIT_MAX, MAX_CLIENTS_PER_SERVER, REQUEST_HISTORY_TIMEOUT_MS, ACK_RETRY_MS, ACK_TIMEOUT_MS, ACK_MAX_RETRIES, MAX_INPUT_BUFFER, MAX_BULK_KEYS, MAX_SEARCH_RESULTS, MAX_EVENT_MEMORY, AUTO_BACKUP_INTERVAL_MS, MAX_BACKUPS, DANGEROUS_PREFIXES } = config;
const { servers, clients, serverIdentities, clientIdentities, licenses, disabledServers, drainingServers, disabledClients, kickedServers, kickedClients, requestHistory, pendingRequests, rateLimits, events, confirmTokens, ipHistory, runtimeStats } = state;

function LogEvent(...args) { return require('../storage/audit').LogEvent(...args); }
function NoticeAll(...args) { return require('../relay/notifications').NoticeAll(...args); }
function Now(...args) { return require('../core/utils').Now(...args); }
function SaveDatabase(...args) { return require('../storage/database').SaveDatabase(...args); }
function SendLine(...args) { return require('../core/utils').SendLine(...args); }

function ApplyMaintenanceSchedule() {
    if(!state.maintenanceSchedule)return;
    const now=Now();
    if(now>=state.maintenanceSchedule.startAt&&now<state.maintenanceSchedule.endAt&&!state.maintenanceMode){
        state.maintenanceMode=true;SaveDatabase();NoticeAll(state.maintenanceSchedule.message);for(const c of clients.values())if(!c.licenseAuthorized)SendLine(c.socket,'SERVICE_STATE|MAINTENANCE');LogEvent('MAINT_SCHEDULE_STARTED',state.maintenanceSchedule.message);
    }
    if(now>=state.maintenanceSchedule.endAt){
        if(state.maintenanceMode){state.maintenanceMode=false;for(const c of clients.values())SendLine(c.socket,'SERVICE_STATE|ONLINE');LogEvent('MAINT_SCHEDULE_ENDED',state.maintenanceSchedule.message);}
        state.maintenanceSchedule=null;SaveDatabase();
    }
}

module.exports = {
    ApplyMaintenanceSchedule
};
