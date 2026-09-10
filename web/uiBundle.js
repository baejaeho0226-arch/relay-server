'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('../config/config');
const PUBLIC_DIR = path.resolve(__dirname, '..', 'public');
const FILES = [
  "index.html",
  "admin.css",
  "admin-theme.css",
  "admin-appearance.css",
  "admin-appearance.js",
  "admin-controls.css",
  "admin-controls.js",
  "admin-navigation.css",
  "admin-i18n.js",
  "admin.js",
  "admin-navigation.js",
  "admin-pages-monitoring.js",
  "admin-terminal.js",
  "admin-pages-traffic.js",
  "admin-pages-danger.js",
  "admin-pages-access.js",
  "admin-pages-sessions.js",
  "admin-pages-reports.js",
  "admin-pages-devices.js",
  "admin-pages-qr.js",
  "admin-pages-licenses.js",
  "admin-pages-deployment.js",
  "admin-pages-security.js",
  "admin-pages-operations.js",
  "admin-pages-support.js",
  "admin-actions-access.js",
  "admin-actions-operations.js",
  "admin-actions-traffic.js",
  "admin-actions-devices.js",
  "admin-actions-policy.js",
  "admin-actions-system.js",
  "admin-modal.js",
  "admin-device-actions.js",
  "admin-license-actions.js",
  "admin-actions.js",
  "admin-pages-member.js",
  "admin-member-actions.js",
  "admin-member.css",
  "admin-palette.js",
  "admin-pages-production.js",
  "service-worker.js",
  "ui-refresh.html",
  "ui-refresh.js"
];
const ManifestPath = path.join(__dirname, 'ui-bundle.json');
function Hash(name, directory = PUBLIC_DIR) {
  // Git on Windows may convert text line endings without changing the UI.
  const source = fs.readFileSync(path.join(directory, name), 'utf8').replace(/\r\n/g, '\n');
  return crypto.createHash('sha256').update(source).digest('hex');
}
function Generate(directory = PUBLIC_DIR) {
  return { webAdminVersion: config.WEB_ADMIN_VERSION, uiRevision: config.WEB_UI_REVISION,
    files: Object.fromEntries(FILES.map(name => [name, Hash(name, directory)])) };
}
function Check(directory = PUBLIC_DIR) {
  const issues = [];
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(ManifestPath, 'utf8'));
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest))
      throw new Error('INVALID_UI_MANIFEST');
  }
  catch (_) { issues.push('web/ui-bundle.json'); }
  if (manifest) {
    if (manifest.uiRevision !== config.WEB_UI_REVISION || manifest.webAdminVersion !== config.WEB_ADMIN_VERSION)
      issues.push('web/ui-bundle.json (version)');
    for (const name of FILES) {
      try { if (Hash(name, directory) !== (manifest.files || {})[name]) issues.push(`public/${name}`); }
      catch (_) { issues.push(`public/${name}`); }
    }
  }
  return { ready: issues.length === 0, webAdminVersion: config.WEB_ADMIN_VERSION,
    uiRevision: config.WEB_UI_REVISION, issues };
}
function Unavailable(res, isHead = false) {
  // This fallback is independent of public/index.html and its obsolete JS.
  const html = '<!doctype html><html lang="ko"><meta charset="utf-8"><title>웹 화면 업데이트 확인</title><h1>웹 화면 파일을 확인해주세요.</h1><p>서버와 웹 화면 파일의 버전이 일치하지 않습니다. 현재 배포본의 public 폴더 전체를 교체하고 재배포해주세요.</p><p>APK 및 기존 데이터는 교체할 필요가 없습니다.</p><a href="/ui-refresh">웹 화면 새로 불러오기</a></html>';
  res.writeHead(503, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Retry-After': '30' });
  res.end(isHead ? undefined : html);
}
module.exports = { Check, Generate, Unavailable, FILES, ManifestPath };
