'use strict';

// Storage facade introduced before the JSON -> SQLite switch.
// Existing runtime remains JSON-backed until an explicit future cutover.

function ProviderName() { return 'json'; }
function ReadSnapshot() { return require('./database').BuildDatabaseObject(); }
function Save() { return require('./database').SaveDatabase(); }
function Load() { return require('./database').LoadDatabase(); }

module.exports = { ProviderName, ReadSnapshot, Save, Load };
