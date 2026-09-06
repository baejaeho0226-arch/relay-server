'use strict';
const manager = require('./licenseManager');
const { NormalizeLicenseKey, NormalizeID } = require('../core/utils');
const { MAX_BULK_KEYS } = require('../config/config');
const { GetSavedClientByID } = require('../identity/identityManager');
const ACTIONS = Object.freeze({ extend: 'EXTEND', unbind: 'UNBIND', suspend: 'SUSPEND',
  resume: 'RESUME', tags: 'EXTEND', transfer: 'TRANSFER', reissue: 'ADMIN', delete: 'ADMIN' });
function Validate(body) {
  const action = String(body.action || '').toLowerCase();
  if (!Object.hasOwn(ACTIONS, action)) return { ok: false, reason: 'INVALID_ACTION' };
  const keys = [...new Set((Array.isArray(body.keys) ? body.keys : []).map(NormalizeLicenseKey).filter(Boolean))];
  if (!keys.length) return { ok: false, reason: 'NO_KEYS' };
  if (keys.length > MAX_BULK_KEYS) return { ok: false, reason: 'TOO_MANY_KEYS' };
  const days = Number(body.days);
  if (action === 'extend' && (!Number.isInteger(days) || days < 1 || days > 36500)) return { ok: false, reason: 'INVALID_DAYS' };
  const targets = new Map();
  if (action === 'transfer') {
    // Exactly one explicitly chosen destination per key; never send several
    // licenses to one device and silently fail the remaining assignments.
    const transfers = Array.isArray(body.transfers) ? body.transfers :
      keys.length === 1 ? [{ key: keys[0], clientId: body.clientId }] : [];
    const used = new Set();
    for (const item of transfers) {
      const key = NormalizeLicenseKey(item?.key), id = NormalizeID(item?.clientId);
      if (!keys.includes(key) || !id || targets.has(key) || used.has(id)) return { ok: false, reason: 'INVALID_TRANSFER_MAPPING' };
      if (!GetSavedClientByID(id)) return { ok: false, reason: 'CLIENT_NOT_FOUND' };
      const bound = manager.GetBoundLicenseEntry(id);
      if (bound && bound.key !== key) return { ok: false, reason: 'CLIENT_ALREADY_LICENSED' };
      targets.set(key, id); used.add(id);
    }
    if (targets.size !== keys.length) return { ok: false, reason: 'INVALID_TRANSFER_MAPPING' };
  }
  return { ok: true, action, keys, days, targets, tags: body.tags || [] };
}
function Execute(input) {
  const results = input.keys.map(key => {
    if (!manager.FindLicense(key)) return { key, ok: false, reason: 'LICENSE_NOT_FOUND' };
    let result;
    switch (input.action) {
      case 'extend': result = manager.ExtendLicense(key, input.days); break;
      case 'unbind': result = manager.UnbindLicense(key); break;
      case 'suspend': result = manager.SuspendLicense(key); break;
      case 'resume': result = manager.ResumeLicense(key); break;
      case 'delete': result = manager.DeleteLicense(key); break;
      case 'tags': result = manager.SetLicenseTags(key, input.tags); break;
      case 'reissue': result = manager.ReissueLicense(key); break;
      case 'transfer': result = manager.TransferLicense(key, input.targets.get(key)); break;
    }
    const ok = result !== false && result != null && result.ok !== false;
    return { key, ok, ...(ok ? (typeof result === 'object' && !Array.isArray(result) ? result : {}) :
      { reason: result?.reason || (input.action === 'resume' || input.action === 'reissue' ? 'NOT_FOUND_OR_EXPIRED' : 'ACTION_FAILED') }) };
  });
  const success = results.filter(x => x.ok).length;
  return { ok: true, action: input.action, total: results.length, success, failed: results.length - success, results };
}
module.exports = { ACTIONS, Validate, Execute };
