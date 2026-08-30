'use strict';

// Runtime storage facade. SQLite is authoritative by default; JSON remains an
// explicit compatibility option and a recovery mirror.

function ProviderName() { return require('../config/config').STORAGE_ENGINE; }
function ReadSnapshot() { return require('./database').BuildDatabaseObject(); }
function Save() { return require('./database').SaveDatabase(); }
function Load() { return require('./database').LoadDatabase(); }

module.exports = { ProviderName, ReadSnapshot, Save, Load };
