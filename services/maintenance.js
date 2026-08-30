'use strict';

const state = require('../core/state');
const { Now, SafeField, SendLine, NormalizeID } = require('../core/utils');

function SaveDatabase() { return require('../storage/database').SaveDatabase(); }
function LogEvent(type, detail) { return require('../storage/audit').LogEvent(type, detail); }
function NoticeAll(message) { return require('../relay/notifications').NoticeAll(message); }
function AddNotification(item) { try { return require('./notificationCenter').AddNotification(item); } catch (_) { return null; } }
function StartDrain(id) { return require('./drainMonitor').StartDrain(id); }
function StopDrain(id) { return require('./drainMonitor').StopDrain(id); }

function NormalizeSchedule(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const startAt = Number(raw.startAt);
    const endAt = Number(raw.endAt);
    if (!(startAt > 0 && endAt > startAt)) return null;
    return {
        startAt,
        endAt,
        message: SafeField(raw.message || 'Scheduled maintenance'),
        autoDrain: Boolean(raw.autoDrain),
        drainLeadMinutes: Math.max(0, Math.min(1440, Number(raw.drainLeadMinutes) || 0)),
        forceStart: Boolean(raw.forceStart),
        autoDrainStarted: Boolean(raw.autoDrainStarted),
        autoDrainStartedAt: Math.max(0, Number(raw.autoDrainStartedAt) || 0),
        autoDrainedServers: Array.isArray(raw.autoDrainedServers) ? raw.autoDrainedServers.map(NormalizeID).filter(Boolean) : [],
        maintenanceStartedAt: Math.max(0, Number(raw.maintenanceStartedAt) || 0),
        waitingForDrain: Boolean(raw.waitingForDrain),
        waitingNotified: Boolean(raw.waitingNotified)
    };
}

function KnownServerIds() {
    return Array.from(new Set(Array.from(state.serverIdentities.values()).map(NormalizeID).filter(Boolean)));
}

function LiveClientCount() {
    return state.clients.size;
}

function BeginAutoDrain(schedule) {
    if (!schedule.autoDrain || schedule.autoDrainStarted) return false;
    const autoStarted = [];
    for (const serverId of KnownServerIds()) {
        if (state.drainingServers.has(serverId)) continue;
        const result = StartDrain(serverId);
        if (result && result.ok) autoStarted.push(serverId);
    }
    schedule.autoDrainStarted = true;
    schedule.autoDrainStartedAt = Now();
    schedule.autoDrainedServers = autoStarted;
    LogEvent('MAINT_AUTO_DRAIN_STARTED', `servers=${autoStarted.length} lead=${schedule.drainLeadMinutes}m start=${schedule.startAt}`);
    AddNotification({
        severity: 'INFO', type: 'MAINT_AUTO_DRAIN_STARTED', title: 'Maintenance auto-drain started',
        message: `${autoStarted.length} server(s) entered automatic drain. Maintenance starts at ${new Date(schedule.startAt).toISOString()}.`,
        dedupeKey: `MAINT_AUTO_DRAIN_STARTED|${schedule.startAt}`
    });
    return true;
}

function ReleaseAutoDrains(schedule, reason) {
    if (!schedule || !Array.isArray(schedule.autoDrainedServers)) return 0;
    let released = 0;
    for (const rawId of schedule.autoDrainedServers) {
        const id = NormalizeID(rawId);
        if (!id || !state.drainingServers.has(id)) continue;
        StopDrain(id);
        released++;
    }
    schedule.autoDrainedServers = [];
    if (released) LogEvent('MAINT_AUTO_DRAIN_RELEASED', `servers=${released} reason=${reason || 'END'}`);
    return released;
}

function EnterScheduledMaintenance(schedule, forced) {
    if (state.maintenanceMode) {
        if (!schedule.maintenanceStartedAt) schedule.maintenanceStartedAt = Now();
        return false;
    }
    state.maintenanceMode = true;
    schedule.maintenanceStartedAt = Now();
    schedule.waitingForDrain = false;
    for (const c of state.clients.values()) if (!c.licenseAuthorized) SendLine(c.socket, 'SERVICE_STATE|MAINTENANCE');
    NoticeAll(schedule.message);
    LogEvent('MAINT_SCHEDULE_STARTED', `${forced ? 'FORCED ' : ''}${schedule.message}`);
    AddNotification({
        severity: forced ? 'WARNING' : 'INFO', type: 'MAINT_SCHEDULE_STARTED', title: forced ? 'Scheduled maintenance force-started' : 'Scheduled maintenance started',
        message: schedule.message, dedupeKey: `MAINT_SCHEDULE_STARTED|${schedule.startAt}`
    });
    return true;
}

function ExitScheduledMaintenance(schedule, reason) {
    if (state.maintenanceMode && schedule && schedule.maintenanceStartedAt) {
        state.maintenanceMode = false;
        for (const c of state.clients.values()) SendLine(c.socket, 'SERVICE_STATE|ONLINE');
        LogEvent('MAINT_SCHEDULE_ENDED', `${reason || 'END'} ${schedule.message}`);
        AddNotification({ severity: 'INFO', type: 'MAINT_SCHEDULE_ENDED', title: 'Scheduled maintenance ended', message: schedule.message, dedupeKey: `MAINT_SCHEDULE_ENDED|${schedule.endAt}` });
    }
    return ReleaseAutoDrains(schedule, reason || 'END');
}

function GetMaintenanceAutomationStatus() {
    const schedule = NormalizeSchedule(state.maintenanceSchedule);
    if (!schedule) return { active: false, phase: state.maintenanceMode ? 'MANUAL_MAINTENANCE' : 'IDLE', liveClients: LiveClientCount(), autoDrainedServers: 0 };
    const now = Now();
    const leadAt = schedule.startAt - schedule.drainLeadMinutes * 60000;
    let phase = 'SCHEDULED';
    if (now >= schedule.endAt) phase = 'ENDING';
    else if (state.maintenanceMode && schedule.maintenanceStartedAt) phase = 'MAINTENANCE';
    else if (schedule.waitingForDrain) phase = 'WAITING_FOR_DRAIN';
    else if (schedule.autoDrainStarted) phase = 'DRAINING';
    else if (now >= schedule.startAt) phase = 'START_PENDING';
    return {
        active: true,
        phase,
        now,
        leadAt,
        startAt: schedule.startAt,
        endAt: schedule.endAt,
        autoDrain: schedule.autoDrain,
        drainLeadMinutes: schedule.drainLeadMinutes,
        forceStart: schedule.forceStart,
        autoDrainStarted: schedule.autoDrainStarted,
        autoDrainStartedAt: schedule.autoDrainStartedAt,
        autoDrainedServers: schedule.autoDrainedServers.length,
        maintenanceStartedAt: schedule.maintenanceStartedAt,
        waitingForDrain: schedule.waitingForDrain,
        liveClients: LiveClientCount(),
        ready: LiveClientCount() === 0
    };
}

function ScheduleMaintenance(options) {
    const schedule = NormalizeSchedule(options);
    if (!schedule) return { ok: false, reason: 'INVALID_TIME' };
    if (!(schedule.startAt > Now())) return { ok: false, reason: 'INVALID_TIME' };
    // Replacing a schedule must only release drains that the previous schedule itself started.
    if (state.maintenanceSchedule) {
        const old = NormalizeSchedule(state.maintenanceSchedule);
        if (old) ReleaseAutoDrains(old, 'REPLACED');
    }
    state.maintenanceSchedule = schedule;
    SaveDatabase();
    LogEvent('MAINT_SCHEDULE', `${schedule.startAt}-${schedule.endAt} autoDrain=${schedule.autoDrain} lead=${schedule.drainLeadMinutes} force=${schedule.forceStart} ${schedule.message}`);
    return { ok: true, schedule, automation: GetMaintenanceAutomationStatus() };
}

function ClearMaintenanceSchedule(reason = 'WEB') {
    const schedule = NormalizeSchedule(state.maintenanceSchedule);
    if (schedule) ReleaseAutoDrains(schedule, 'CLEAR');
    state.maintenanceSchedule = null;
    SaveDatabase();
    LogEvent('MAINT_SCHEDULE_CLEAR', reason);
    return { ok: true };
}

function ApplyMaintenanceSchedule() {
    let schedule = NormalizeSchedule(state.maintenanceSchedule);
    if (!schedule) return;
    // Keep normalized runtime fields in state so mutations below are persisted.
    state.maintenanceSchedule = schedule;
    const now = Now();
    let changed = false;

    if (schedule.autoDrain && !schedule.autoDrainStarted && now >= schedule.startAt - schedule.drainLeadMinutes * 60000 && now < schedule.endAt) {
        changed = BeginAutoDrain(schedule) || changed;
    }

    if (now >= schedule.startAt && now < schedule.endAt && !schedule.maintenanceStartedAt) {
        const ready = LiveClientCount() === 0;
        if (ready || schedule.forceStart || !schedule.autoDrain) {
            changed = EnterScheduledMaintenance(schedule, !ready && schedule.forceStart) || changed;
        } else {
            if (!schedule.waitingForDrain) { schedule.waitingForDrain = true; changed = true; }
            if (!schedule.waitingNotified) {
                schedule.waitingNotified = true;
                changed = true;
                LogEvent('MAINT_WAITING_FOR_DRAIN', `clients=${LiveClientCount()} start=${schedule.startAt}`);
                AddNotification({ severity: 'WARNING', type: 'MAINT_WAITING_FOR_DRAIN', title: 'Maintenance waiting for drain', message: `${LiveClientCount()} client(s) are still connected. Maintenance will start when the drain reaches zero.`, dedupeKey: `MAINT_WAITING_FOR_DRAIN|${schedule.startAt}` });
            }
        }
    }

    if (now >= schedule.startAt && now < schedule.endAt && schedule.waitingForDrain && !schedule.maintenanceStartedAt && LiveClientCount() === 0) {
        changed = EnterScheduledMaintenance(schedule, false) || changed;
    }

    if (now >= schedule.endAt) {
        ExitScheduledMaintenance(schedule, schedule.maintenanceStartedAt ? 'END' : 'EXPIRED_BEFORE_READY');
        state.maintenanceSchedule = null;
        SaveDatabase();
        return;
    }

    if (changed) SaveDatabase();
}

module.exports = {
    NormalizeSchedule,
    ScheduleMaintenance,
    ClearMaintenanceSchedule,
    GetMaintenanceAutomationStatus,
    ApplyMaintenanceSchedule
};
