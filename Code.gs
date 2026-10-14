/**
 * HỒ SƠ LÝ LỊCH KHOA HỌC & KẾT NỐI NGUỒN LỰC — Google Apps Script
 * Triển khai: Web app, Execute as = "Me" (người triển khai).
 *  - Cách 1 (khuyến nghị, KHÔNG cần Google Cloud/OAuth): Who has access = "Anyone" + "cổng đăng nhập" là một dự án Apps Script nhỏ (thư mục gateway/) -> mọi tài khoản Google đều đăng nhập được.
 *  - Cách 2: đăng nhập OAuth tự cấu hình (OAUTH_CLIENT_ID/SECRET) - cần Google Cloud.
 *  - Cách 3: Who has access = "Anyone within <tên miền>" -> dùng tài khoản của tổ chức.
 * Dữ liệu lưu trong một Google Sheet (tự tạo lần đầu chạy).
 */

var APP_NAME = 'Hồ sơ Lý lịch khoa học';
var SHEET_DEFS = {
  Profiles:    ['email', 'org', 'createdAt', 'updatedAt', 'consent', 'chunks'],            // + cột chunk dữ liệu từ cột 7
  Exports:     ['id', 'email', 'name', 'createdAt', 'template', 'format', 'config', 'chunks'], // + chunk từ cột 9
  Audit:       ['ts', 'actor', 'action', 'target', 'detail'],
  Admins:      ['email', 'role', 'orgs', 'addedBy', 'addedAt'],
  Catalogs:    ['name', 'json'],
  Config:      ['key', 'json'],
  Invites:     ['id', 'from', 'to', 'subject', 'kind', 'createdAt'],
  EmailVerify: ['email', 'contact', 'code', 'token', 'createdAt', 'used']
};
var PROFILE_CHUNK_COL = 7, EXPORT_CHUNK_COL = 9, CHUNK_SIZE = 45000;
var LIMITS = { degrees: 20, titles: 6, languages: 10, work: 80, projects: 300, pubs: 1500, awards: 300, courses: 60, directions: 60, authors: 80 };

/* ===================== WEB APP ===================== */
function doGet(e) {
  if (e && e.parameter && e.parameter.verify) return verifyLinkPage_(e.parameter.verify);
  // Bản triển khai chạy với tư cách NGƯỜI TRUY CẬP (không phải chủ) thì không được mở CSDL: chỉ làm cổng xác nhận email, dù có ?gate=1 hay không.
  if ((e && e.parameter && e.parameter.gate) || runsAsVisitor_()) return gatePage_(e && e.parameter && e.parameter.role);
  var t = HtmlService.createTemplateFromFile('Index');
  t.appName = APP_NAME;
  t.bootJson = jsonForHtml_(e && e.parameter && e.parameter.ticket ? ticketLogin_(e.parameter.ticket) : (e && e.parameter && e.parameter.code ? oauthCallback_(e.parameter) : {}));
  return t.evaluate().setTitle(APP_NAME)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}
function include(name) { return HtmlService.createHtmlOutputFromFile(name).getContent(); }

function runsAsVisitor_() {
  var owner = String(PropertiesService.getScriptProperties().getProperty('OWNER_EMAIL') || '').toLowerCase();
  var me = String(Session.getEffectiveUser().getEmail() || '').toLowerCase();
  return !!owner && !!me && me !== owner;
}
/** "Cổng đăng nhập" nằm ngay trong dự án này: chạy ở bản triển khai "Người dùng truy cập ứng dụng web", chỉ đọc email rồi chuyển về bản triển khai chính kèm phiếu ký. */
function gatePage_(role) {
  var P = PropertiesService.getScriptProperties(), app = P.getProperty('APP_URL'), sec = P.getProperty('GATE_SECRET');
  var email = String(Session.getActiveUser().getEmail() || '').toLowerCase(), url = '', title, msg;
  if (!app || !sec) { title = 'Cổng chưa cấu hình'; msg = 'Thiếu APP_URL hoặc GATE_SECRET trong Script properties (chạy setup() và thêm APP_URL).'; }
  else if (!email) { title = 'Không đọc được email'; msg = 'Hãy đăng nhập Google, cho phép quyền xem địa chỉ email rồi tải lại trang.'; }
  else {
    var body = b64u_(JSON.stringify({ k: 'tkt', e: email, r: role === 'admin' ? 'admin' : 'user', n: Utilities.getUuid(), x: Date.now() + 120000 }));
    url = app + (app.indexOf('?') < 0 ? '?' : '&') + 'ticket=' + body + '.' + b64u_(Utilities.computeHmacSha256Signature('tkt:' + body, sec));
    title = 'Đã xác nhận ' + email; msg = 'Bấm nút để vào ứng dụng.';
  }
  var h = function (x) { return String(x).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); };
  var html = '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<body style="font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:90vh;margin:0;color:#1c2330;background:#fff"><div style="max-width:380px;text-align:center;padding:24px">' +
    '<h2 style="font-size:18px">' + h(title) + '</h2><p style="color:#5b6577">' + h(msg) + '</p>' +
    (url ? '<a target="_top" href="' + h(url) + '" style="display:inline-block;background:#1763d1;color:#fff;text-decoration:none;padding:11px 22px;border-radius:10px;font-weight:600">Vào ứng dụng</a>' : '') + '</div></body>';
  return HtmlService.createHtmlOutput(html).setTitle('Đăng nhập').setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/* Nạp Model.html dùng chung (cùng mã với phía trình duyệt) */
var CV_ = null;
function CVm_() {
  if (!CV_) {
    var src = HtmlService.createHtmlOutputFromFile('Model').getContent().replace(/<\/?script>/g, '');
    (0, eval)(src);
    CV_ = globalThis.CV;
  }
  return CV_;
}

/* ===================== TIỆN ÍCH CHUNG ===================== */
var DEV_EMAIL_ = null;
function devAs(email) { DEV_EMAIL_ = String(email || '').toLowerCase(); } // chỉ dùng khi chạy thử trong trình soạn thảo

function userError_(msg, code) { var e = new Error(msg); e.isUser = true; e.code = code || 'ERR'; return e; }
function run_(fn) {
  try { return { ok: true, data: fn() }; }
  catch (err) {
    if (err && err.isUser) return { ok: false, error: err.message, code: err.code };
    console.error((err && err.stack) || err);
    return { ok: false, error: 'Lỗi hệ thống: ' + ((err && err.message) || err) };
  }
}
function lock_(fn) {
  var l = LockService.getScriptLock(); l.waitLock(30000);
  try { return fn(); } finally { l.releaseLock(); }
}
function nowIso_() { return new Date().toISOString(); }
function safeCell_(v) { v = (v == null) ? '' : String(v); return /^[=+\-@]/.test(v) ? "'" + v : v; }
function str_(v, max) { v = (v == null) ? '' : String(v).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim(); return v.length > (max || 500) ? v.slice(0, max || 500) : v; }
function yr_(v) { v = String(v == null ? '' : v).trim(); return /^\d{4}$/.test(v) ? v : ''; }
function arr_(v, max) { return Array.isArray(v) ? v.slice(0, max) : []; }
function id_(v) { v = str_(v, 40); return v || ('i' + Utilities.getUuid().replace(/-/g, '').slice(0, 10)); }

/* ===================== CƠ SỞ DỮ LIỆU (Google Sheets) ===================== */
var SS_ = null;
function getSS_() {
  if (SS_) return SS_;
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty('DB_ID');
  if (id) { try { SS_ = SpreadsheetApp.openById(id); return SS_; } catch (e) { console.error('openById(' + id + ') lỗi: ' + e); throw userError_('Không mở được cơ sở dữ liệu (Google Sheet). Hãy chạy hàm setup() lại hoặc kiểm tra thuộc tính DB_ID. Chi tiết: ' + ((e && e.message) || e)); } }
  return lock_(function () {
    id = props.getProperty('DB_ID');
    if (id) { SS_ = SpreadsheetApp.openById(id); return SS_; }
    var ss = SpreadsheetApp.create('LyLichKhoaHoc_DB (không chỉnh sửa tay)');
    props.setProperty('DB_ID', ss.getId());
    if (!props.getProperty('ENC_KEY')) props.setProperty('ENC_KEY', Utilities.getUuid() + Utilities.getUuid());
    initSheets_(ss);
    SS_ = ss; return ss;
  });
}
function initSheets_(ss) {
  var first = ss.getSheets()[0];
  Object.keys(SHEET_DEFS).forEach(function (n, i) {
    var sh = ss.getSheetByName(n) || (i === 0 && first.getName().indexOf('Sheet') === 0 ? first.setName(n) : ss.insertSheet(n));
    if (sh.getLastRow() === 0) { sh.getRange(1, 1, 1, SHEET_DEFS[n].length).setValues([SHEET_DEFS[n]]).setFontWeight('bold'); sh.setFrozenRows(1); }
  });
  seedCatalogs_(ss);
}
/** Chạy một lần trong trình soạn thảo để tạo CSDL và cấp quyền. */
function setup() {
  var P = PropertiesService.getScriptProperties(), ss;
  try { ss = getSS_(); }
  catch (e) {
    var msg = String((e && e.message) || e);
    // Lỗi QUYỀN (chưa cấp quyền / thiếu oauthScopes trong appsscript.json) thì tuyệt đối không bỏ DB_ID: Sheet vẫn còn, chỉ cần cấp quyền.
    if (/permission|not sufficient|authoriz|quy[eề]n|forbidden|access denied/i.test(msg)) throw new Error('Thiếu quyền Google, KHÔNG đổi DB_ID. Hãy kiểm tra appsscript.json có đủ oauthScopes (spreadsheets, drive, userinfo.email, script.external_request, script.send_mail) rồi chạy lại setup() và bấm Cho phép. Chi tiết: ' + msg);
    // DB_ID trỏ tới Sheet không còn tồn tại: bỏ tham chiếu cũ (file cũ nếu còn vẫn nằm trong Drive) và tạo CSDL mới
    Logger.log('Bỏ DB_ID cũ ' + P.getProperty('DB_ID') + ' vì không mở được: ' + msg);
    P.deleteProperty('DB_ID'); SS_ = null; ss = getSS_();
  }
  initSheets_(ss);
  var props = PropertiesService.getScriptProperties();
  if (!props.getProperty('ENC_KEY')) props.setProperty('ENC_KEY', Utilities.getUuid() + Utilities.getUuid());
  props.setProperty('OWNER_EMAIL', ownerEmail_());   // để bản triển khai chạy bằng người truy cập tự nhận ra mình chỉ là cổng
  if (!props.getProperty('GATE_SECRET')) props.setProperty('GATE_SECRET', Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, ''));
  Logger.log('CSDL: ' + ss.getUrl());
  Logger.log('GATE_SECRET (dán y hệt vào dự án cổng đăng nhập): ' + props.getProperty('GATE_SECRET'));
  return ss.getUrl();
}
function sheet_(name) {
  var sh = getSS_().getSheetByName(name);
  if (!sh) { initSheets_(getSS_()); sh = getSS_().getSheetByName(name); }
  return sh;
}
function readAll_(name) { // trả về mảng object theo tiêu đề, kèm _row
  var sh = sheet_(name), n = sh.getLastRow();
  if (n < 2) return [];
  var cols = SHEET_DEFS[name].length;
  var vals = sh.getRange(2, 1, n - 1, Math.max(cols, sh.getLastColumn())).getValues();
  return vals.map(function (r, i) {
    var o = { _row: i + 2, _raw: r };
    SHEET_DEFS[name].forEach(function (k, j) { o[k] = r[j]; });
    return o;
  });
}
function appendRow_(name, arr) { sheet_(name).appendRow(arr.map(function (v) { return typeof v === 'string' ? safeCell_(v) : v; })); }

/* Nén + chia khúc để vượt giới hạn 50.000 ký tự/ô */
function pack_(obj) {
  var json = JSON.stringify(obj);
  var b64 = Utilities.base64Encode(Utilities.gzip(Utilities.newBlob(json, 'application/json', 'd.json')).getBytes());
  var out = []; for (var i = 0; i < b64.length; i += CHUNK_SIZE) out.push(b64.slice(i, i + CHUNK_SIZE));
  return out.length ? out : [''];
}
function unpack_(chunks) {
  var b64 = chunks.join('');
  if (!b64) return null;
  var bytes = Utilities.base64Decode(b64);
  return JSON.parse(Utilities.ungzip(Utilities.newBlob(bytes, 'application/x-gzip', 'd.gz')).getDataAsString());
}
function writeRowWithChunks_(sh, rowNum, fixed, chunks) {
  var need = fixed.length + chunks.length;
  if (sh.getMaxColumns() < need) sh.insertColumnsAfter(sh.getMaxColumns(), need - sh.getMaxColumns());
  var oldLast = Math.max(sh.getLastColumn(), need);
  var row = fixed.concat(chunks); while (row.length < oldLast) row.push('');
  if (!rowNum) { rowNum = sh.getLastRow() + 1; }
  sh.getRange(rowNum, 1, 1, row.length).setValues([row]);
  return rowNum;
}
function chunksOf_(raw, start, count) { return raw.slice(start, start + Math.max(1, Number(count) || 1)).map(String); }

/* ===================== MÃ HOÁ SỐ GIẤY TỜ ===================== */
function encKey_() {
  var k = PropertiesService.getScriptProperties().getProperty('ENC_KEY');
  if (!k) { k = Utilities.getUuid() + Utilities.getUuid(); PropertiesService.getScriptProperties().setProperty('ENC_KEY', k); }
  return k;
}
function keystream_(nonceB64, len) {
  var out = [], ctr = 0;
  while (out.length < len) {
    var h = Utilities.computeHmacSha256Signature(nonceB64 + ':' + ctr, encKey_());
    for (var i = 0; i < h.length; i++) out.push(h[i] & 255);
    ctr++;
  }
  return out.slice(0, len);
}
function encrypt_(plain) {
  plain = String(plain || ''); if (!plain) return '';
  var nonce = Utilities.base64Encode(Utilities.newBlob(Utilities.getUuid()).getBytes()).slice(0, 16);
  var pb = Utilities.newBlob(plain).getBytes(), ks = keystream_(nonce, pb.length), ct = [];
  for (var i = 0; i < pb.length; i++) ct.push(((pb[i] & 255) ^ ks[i]) & 255);
  var ctB64 = Utilities.base64Encode(ct.map(function (b) { return b > 127 ? b - 256 : b; }));
  var mac = Utilities.base64Encode(Utilities.computeHmacSha256Signature('mac:' + nonce + ':' + ctB64, encKey_())).slice(0, 22);
  return 'v1:' + nonce + ':' + ctB64 + ':' + mac;
}
function decrypt_(enc) {
  if (!enc) return '';
  var p = String(enc).split(':'); if (p[0] !== 'v1' || p.length !== 4) return '';
  var mac = Utilities.base64Encode(Utilities.computeHmacSha256Signature('mac:' + p[1] + ':' + p[2], encKey_())).slice(0, 22);
  if (mac !== p[3]) return '';
  var ct = Utilities.base64Decode(p[2]), ks = keystream_(p[1], ct.length), pt = [];
  for (var i = 0; i < ct.length; i++) pt.push((((ct[i] & 255) ^ ks[i]) & 255));
  return Utilities.newBlob(pt.map(function (b) { return b > 127 ? b - 256 : b; })).getDataAsString();
}

/* ===================== XÁC THỰC & PHÂN QUYỀN ===================== */
var SESSION_TTL_MS = 12 * 3600 * 1000;
var CUR_TOKEN_ = null;      // phiên của lần gọi hiện tại (do apiCall đặt)
var PUBLIC_DOMAINS_ = ['gmail.com', 'googlemail.com', 'yahoo.com', 'outlook.com', 'hotmail.com', 'live.com', 'icloud.com', 'proton.me', 'protonmail.com'];
/** Tổ chức của tài khoản: theo tên miền; tài khoản dùng email công cộng (gmail...) tự thành một "tổ chức" riêng nên không bị quản trị nào xem chung. */
function orgOf_(email) { var d = String(email).split('@')[1] || ''; return PUBLIC_DOMAINS_.indexOf(d) >= 0 ? email : d; }

function b64u_(bytesOrStr) { return Utilities.base64Encode(bytesOrStr).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function unb64u_(s) { s = String(s).replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '='; return Utilities.newBlob(Utilities.base64Decode(s)).getDataAsString(); }
function signTok_(kind, payload) {
  payload.k = kind; var body = b64u_(JSON.stringify(payload));
  return body + '.' + b64u_(Utilities.computeHmacSha256Signature(kind + ':' + body, encKey_()));
}
function verifyTok_(kind, tok) {
  var p = String(tok || '').split('.'); if (p.length !== 2) return null;
  if (b64u_(Utilities.computeHmacSha256Signature(kind + ':' + p[0], encKey_())) !== p[1]) return null;
  var o = safeJson_(unb64u_(p[0]), null);
  return o && o.k === kind && o.x > Date.now() ? o : null;
}
function ownerEmail_() { return String(Session.getEffectiveUser().getEmail() || '').toLowerCase(); }
/** Tư cách quản trị của một email (không phụ thuộc vai trò đang chọn). */
function rolesOf_(email) {
  var isSys = email === ownerEmail_(), orgs = [];
  readAll_('Admins').forEach(function (a) {
    if (String(a.email).toLowerCase() !== email) return;
    if (a.role === 'sysadmin') isSys = true;
    String(a.orgs || '').split(',').forEach(function (o) { o = o.trim().toLowerCase(); if (o) orgs.push(o); });
  });
  var canAdmin = orgs.length > 0 || isSys;
  if (canAdmin && !orgs.length) orgs = [orgOf_(email)];
  return { canAdmin: canAdmin, canSys: isSys, orgs: orgs };
}
function sessionEmail_() { var e = String(Session.getActiveUser().getEmail() || '').toLowerCase(); return e || DEV_EMAIL_ || ''; }
/** Danh tính của lệnh gọi hiện tại; tài khoản đã bị chặn thì mọi lệnh gọi đều bị từ chối (hiệu lực ngay, kể cả phiên đang mở). */
function identity_() {
  var id = identityRaw_();
  if (isBlocked_(id.email)) throw userError_(BLOCKED_MSG_, 'BLOCKED');
  return id;
}
function identityRaw_() {
  if (CUR_TOKEN_) {
    var t = verifyTok_('sess', CUR_TOKEN_);
    if (!t) throw userError_('Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.', 'NOAUTH');
    return { email: t.e, role: t.r };
  }
  var email = sessionEmail_();
  if (!email) throw userError_('Bạn chưa đăng nhập. Vui lòng đăng nhập bằng tài khoản Google.', 'NOAUTH');
  return { email: email, role: '' };   // gọi trực tiếp (chỉ có khi tên miền xác thực sẵn): không giới hạn vai trò
}
function ctx_() {
  var id = identity_(), email = id.email, r = rolesOf_(email);
  var isAdmin = r.canAdmin && id.role !== 'user', isSys = r.canSys && id.role !== 'user';
  return { email: email, org: orgOf_(email), isSys: isSys, isAdmin: isAdmin, adminOrgs: r.orgs, owner: ownerEmail_(), role: id.role || (isAdmin ? 'admin' : 'user'), canAdmin: r.canAdmin };
}
function needAdmin_() { var c = ctx_(); if (!c.isAdmin) throw userError_('Bạn không có quyền quản trị (hoặc đang ở vai trò Nhà khoa học).', 'FORBIDDEN'); return c; }
function needSys_() { var c = ctx_(); if (!c.isSys) throw userError_('Chỉ Quản trị hệ thống mới được thực hiện thao tác này.', 'FORBIDDEN'); return c; }

function newSession_(email, role) { return signTok_('sess', { e: email, r: role === 'admin' ? 'admin' : 'user', x: Date.now() + SESSION_TTL_MS }); }
function userView_(email, role) { var r = rolesOf_(email); return { email: email, role: role, canAdmin: r.canAdmin, isAdmin: r.canAdmin && role === 'admin', isSys: r.canSys && role === 'admin', org: orgOf_(email) }; }

function oauthCfg_() {
  var P = PropertiesService.getScriptProperties();
  return { id: P.getProperty('OAUTH_CLIENT_ID') || '', secret: P.getProperty('OAUTH_CLIENT_SECRET') || '', redirect: P.getProperty('OAUTH_REDIRECT') || ScriptApp.getService().getUrl(), gate: P.getProperty('GATE_URL') || '' };
}
/** Trang đăng nhập hỏi: đăng nhập bằng cách nào? */
function apiAuthInfo() {
  return run_(function () {
    var email = sessionEmail_(), cfg = oauthCfg_();
    if (email) return { mode: 'session', email: email };
    return { mode: (cfg.gate || (cfg.id && cfg.secret)) ? 'oauth' : 'unconfigured' };
  });
}
/** Cách B: tên miền đã xác thực tài khoản Google; chỉ cần chọn vai trò. */
function apiLogin(role) {
  return run_(function () {
    var email = sessionEmail_(); if (!email) throw userError_('Không xác định được tài khoản Google.', 'NOAUTH');
    if (isBlocked_(email)) throw userError_(BLOCKED_MSG_, 'BLOCKED');
    role = role === 'admin' ? 'admin' : 'user';
    if (role === 'admin' && !rolesOf_(email).canAdmin) throw userError_('Tài khoản ' + email + ' chưa được cấp quyền quản trị. Hãy chọn "Nhà khoa học" hoặc liên hệ quản trị hệ thống.', 'FORBIDDEN');
    audit_(email, 'login', role, 'session');
    return { token: newSession_(email, role) };
  });
}
/** Cách A: tạo địa chỉ đăng nhập Google (OAuth 2.0, luồng mã uỷ quyền). */
function apiAuthUrl(role, hint) {
  return run_(function () {
    var cfg = oauthCfg_(), rl = role === 'admin' ? 'admin' : 'user';
    if (cfg.gate) return { url: cfg.gate + (cfg.gate.indexOf('?') < 0 ? '?' : '&') + 'gate=1&role=' + rl };   // cổng đăng nhập (không cần OAuth)
    if (!cfg.id || !cfg.secret) throw userError_('Chưa cấu hình đăng nhập Google (GATE_URL hoặc OAUTH_CLIENT_ID / OAUTH_CLIENT_SECRET). Xem README.', 'CONFIG');
    var state = signTok_('state', { n: Utilities.getUuid(), r: role === 'admin' ? 'admin' : 'user', x: Date.now() + 10 * 60000 });
    var q = { client_id: cfg.id, redirect_uri: cfg.redirect, response_type: 'code', scope: 'openid email', state: state, prompt: 'select_account' };
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(hint || ''))) q.login_hint = String(hint).slice(0, 200);
    return { url: 'https://accounts.google.com/o/oauth2/v2/auth?' + Object.keys(q).map(function (k) { return k + '=' + encodeURIComponent(q[k]); }).join('&') };
  });
}
/** Google chuyển hướng về /exec?code=...&state=...: đổi mã lấy danh tính rồi cấp phiên. */
function oauthCallback_(prm) {
  try {
    if (prm.error) return { error: 'Đăng nhập bị huỷ hoặc bị từ chối (' + prm.error + ').' };
    var st = verifyTok_('state', prm.state); if (!st) return { error: 'Yêu cầu đăng nhập không hợp lệ hoặc đã quá hạn. Hãy thử lại.' };
    var cfg = oauthCfg_();
    var res = UrlFetchApp.fetch('https://oauth2.googleapis.com/token', { method: 'post', muteHttpExceptions: true,
      payload: { code: prm.code, client_id: cfg.id, client_secret: cfg.secret, redirect_uri: cfg.redirect, grant_type: 'authorization_code' } });
    var body = safeJson_(res.getContentText(), {});
    if (res.getResponseCode() !== 200 || !body.id_token) return { error: 'Google từ chối mã đăng nhập (' + (body.error_description || body.error || res.getResponseCode()) + ').' };
    var cl = safeJson_(unb64u_(String(body.id_token).split('.')[1]), {});   // id_token nhận trực tiếp từ Google qua TLS
    if (cl.aud !== cfg.id || ['accounts.google.com', 'https://accounts.google.com'].indexOf(cl.iss) < 0 || !(cl.exp * 1000 > Date.now())) return { error: 'Thông tin đăng nhập không hợp lệ.' };
    if (!cl.email || cl.email_verified === false || cl.email_verified === 'false') return { error: 'Tài khoản Google chưa xác minh email.' };
    return finishLogin_(String(cl.email).toLowerCase(), st.r, 'oauth');
  } catch (err) { console.error(err); return { error: 'Không hoàn tất được đăng nhập: ' + ((err && err.message) || err) }; }
}
function finishLogin_(email, role, via) {
  if (isBlocked_(email)) { audit_(email, 'login.blocked', '', via); return { error: BLOCKED_MSG_ }; }
  var note = ''; role = role === 'admin' ? 'admin' : 'user';
  if (role === 'admin' && !rolesOf_(email).canAdmin) { role = 'user'; note = 'Tài khoản ' + email + ' chưa được cấp quyền quản trị nên bạn đang vào với vai trò Nhà khoa học.'; }
  audit_(email, 'login', role, via);
  return { token: newSession_(email, role), note: note };
}
/** Cổng đăng nhập (gateway/Code.gs) chạy với tư cách người truy cập, xác nhận email rồi chuyển về đây kèm "phiếu" ký bằng GATE_SECRET. */
function ticketLogin_(tk) {
  try {
    var sec = PropertiesService.getScriptProperties().getProperty('GATE_SECRET') || '';
    if (!sec) return { error: 'Chưa cấu hình GATE_SECRET. Xem README.' };
    var p = String(tk).split('.');
    if (p.length !== 2 || b64u_(Utilities.computeHmacSha256Signature('tkt:' + p[0], sec)) !== p[1]) return { error: 'Phiếu đăng nhập không hợp lệ. Kiểm tra GATE_SECRET ở hai dự án phải giống nhau.' };
    var o = safeJson_(unb64u_(p[0]), null);
    if (!o || o.k !== 'tkt' || !(o.x > Date.now())) return { error: 'Phiếu đăng nhập đã hết hạn. Hãy đăng nhập lại.' };
    var cache = CacheService.getScriptCache();
    if (cache.get('tkt' + o.n)) return { error: 'Phiếu đăng nhập đã được dùng. Hãy đăng nhập lại.' };
    cache.put('tkt' + o.n, '1', 600);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(o.e || ''))) return { error: 'Không xác định được email Google.' };
    return finishLogin_(String(o.e).toLowerCase(), o.r, 'gate');
  } catch (err) { console.error(err); return { error: 'Không hoàn tất được đăng nhập: ' + ((err && err.message) || err) }; }
}
function apiSwitchRole(role) {
  return run_(function () {
    var id = identity_(); role = role === 'admin' ? 'admin' : 'user';
    if (role === 'admin' && !rolesOf_(id.email).canAdmin) throw userError_('Tài khoản này chưa được cấp quyền quản trị.', 'FORBIDDEN');
    return { token: newSession_(id.email, role) };
  });
}
/** Điểm vào duy nhất cho trình duyệt: gắn phiên đăng nhập rồi gọi hàm api* tương ứng. */
function apiCall(token, fn, args) {
  fn = String(fn);
  if (!/^api[A-Z]\w*$/.test(fn) || fn === 'apiCall' || typeof globalThis[fn] !== 'function') return { ok: false, error: 'Hàm không hợp lệ.' };
  CUR_TOKEN_ = token || null;
  try { return globalThis[fn].apply(null, Array.isArray(args) ? args : []); } finally { CUR_TOKEN_ = null; }
}
function jsonForHtml_(o) { return JSON.stringify(o).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029'); }

function audit_(actor, action, target, detail) {
  try { appendRow_('Audit', [nowIso_(), actor, action, target || '', typeof detail === 'string' ? detail : JSON.stringify(detail || '')]); } catch (e) { console.error(e); }
}

/* ===================== HỒ SƠ ===================== */
function findProfileRow_(email) {
  var sh = sheet_('Profiles'), n = sh.getLastRow(); if (n < 2) return null;
  var col = sh.getRange(2, 1, n - 1, 1).getValues();
  for (var i = 0; i < col.length; i++) if (String(col[i][0]).toLowerCase() === email) {
    var row = i + 2, raw = sh.getRange(row, 1, 1, sh.getLastColumn()).getValues()[0];
    var chunks = chunksOf_(raw, PROFILE_CHUNK_COL - 1, raw[5]);
    return { row: row, email: raw[0], org: raw[1], createdAt: raw[2], updatedAt: String(raw[3]), consent: safeJson_(raw[4], {}), profile: unpack_(chunks) };
  }
  return null;
}
function safeJson_(s, def) { try { return s ? JSON.parse(s) : def; } catch (e) { return def; } }

function allProfiles_(orgs) { // dùng cho admin; chỉ các tổ chức cho phép
  var sh = sheet_('Profiles'), n = sh.getLastRow(); if (n < 2) return [];
  var vals = sh.getRange(2, 1, n - 1, sh.getLastColumn()).getValues(), out = [];
  vals.forEach(function (raw) {
    var org = String(raw[1]).toLowerCase();
    if (orgs.indexOf(org) < 0 && orgs.indexOf('*') < 0) return;
    try { out.push({ email: raw[0], org: raw[1], updatedAt: String(raw[3]), consent: safeJson_(raw[4], {}), profile: unpack_(chunksOf_(raw, PROFILE_CHUNK_COL - 1, raw[5])) }); } catch (e) { console.error(e); }
  });
  return out.filter(function (r) { return r.profile; });
}

/** Chuẩn hoá & giới hạn dữ liệu do client gửi lên (danh sách trắng). */
function cleanProfile_(raw, prev) {
  var CV = CVm_(), E = CV.emptyProfile(); raw = raw || {};
  var b = raw.basic || {}, o = E;
  ['fullName', 'gender', 'dob', 'pob', 'hometown', 'ethnicity', 'position', 'workplace', 'address', 'phoneCQ', 'phoneNR', 'phoneDD', 'fax', 'contactEmail'].forEach(function (k) { o.basic[k] = str_(b[k], k === 'address' ? 300 : 200); });
  o.basic.hvDegree = str_(b.hvDegree, 60); o.basic.hvCountry = str_(b.hvCountry, 80); o.basic.hvTitle = str_(b.hvTitle, 60); o.basic.hvYear = yr_(b.hvYear); o.basic.hvTitleYear = yr_(b.hvTitleYear);
  o.basic.contactEmailVerified = !!(prev && prev.basic && prev.basic.contactEmail === o.basic.contactEmail && prev.basic.contactEmailVerified);
  var d = raw.idDoc || {};
  o.idDoc.type = ['CMND', 'CCCD', 'The can cuoc'].indexOf(d.type) >= 0 ? d.type : 'CCCD';
  o.idDoc.issueDate = str_(d.issueDate, 20); o.idDoc.issuePlace = str_(d.issuePlace, 200);
  var num = str_(d.number, 30);
  o.idDoc.numberEnc = encrypt_(num); delete o.idDoc.number;
  o.degrees = arr_(raw.degrees, LIMITS.degrees).map(function (x) {
    return { id: id_(x.id), level: x.level === 'Sau đại học' ? 'Sau đại học' : 'Đại học', degree: str_(x.degree, 40), major: str_(x.major, 200), institution: str_(x.institution, 250), country: str_(x.country, 80),
      year: yr_(x.year), system: str_(x.system, 60), thesis: str_(x.thesis, 500), second: !!x.second };
  });
  o.titles = arr_(raw.titles, LIMITS.titles).map(function (x) { return { id: id_(x.id), title: x.title === 'GS' ? 'GS' : 'PGS', major: str_(x.major, 200), year: yr_(x.year) }; });
  o.languages = arr_(raw.languages, LIMITS.languages).map(function (x) { return { id: id_(x.id), language: str_(x.language, 80), level: str_(x.level, 80), certificate: str_(x.certificate, 120) }; });
  o.work = arr_(raw.work, LIMITS.work).map(function (x) { return { id: id_(x.id), from: str_(x.from, 10), to: str_(x.to, 10), current: !!x.current, org: str_(x.org, 300), position: str_(x.position, 200), duties: str_(x.duties, 1000) }; });
  o.projects = arr_(raw.projects, LIMITS.projects).map(function (x) {
    return { id: id_(x.id), name: str_(x.name, 600), startYear: yr_(x.startYear), endYear: yr_(x.endYear), ongoing: !!x.ongoing,
      level: CV.LEVELS.indexOf(x.level) >= 0 ? x.level : '', role: CV.ROLES.indexOf(x.role) >= 0 ? x.role : '', code: str_(x.code, 80), result: str_(x.result, 200), funding: str_(x.funding, 80) };
  });
  o.pubs = arr_(raw.pubs, LIMITS.pubs).map(function (x) {
    return { id: id_(x.id), type: ['article', 'conference', 'book'].indexOf(x.type) >= 0 ? x.type : 'article', title: str_(x.title, 800),
      authors: arr_(x.authors, LIMITS.authors).map(function (a) { return { name: str_(a.name, 120), me: !!a.me, main: !!a.main, corr: !!a.corr }; }),
      venue: str_(x.venue, 400), volume: str_(x.volume, 40), issue: str_(x.issue, 40), pages: str_(x.pages, 40), year: yr_(x.year), doi: str_(x.doi, 200), issn: str_(x.issn, 30), isbn: str_(x.isbn, 40),
      publisher: str_(x.publisher, 200), bookRole: str_(x.bookRole, 80), registrationNo: str_(x.registrationNo, 80),
      indexClass: CV.INDEX_CLASS[x.indexClass] ? x.indexClass : '', keywords: arr_(x.keywords, 20).map(function (k) { return str_(k, 60); }).filter(String),
      verified: !!x.verified, source: ['manual', 'crossref', 'openalex'].indexOf(x.source) >= 0 ? x.source : 'manual' };
  });
  o.awards = arr_(raw.awards, LIMITS.awards).map(function (x) { return { id: id_(x.id), kind: CV.AWARD_KIND[x.kind] ? x.kind : 'giai_thuong', name: str_(x.name, 400), issuer: str_(x.issuer, 250), year: yr_(x.year), content: str_(x.content, 800) }; });
  var ex = raw.extra || {}, asp = ex.aspirations || {};
  o.extra.aspirations = { giangDay: !!asp.giangDay, hoiDong: !!asp.hoiDong, nghienCuu: !!asp.nghienCuu, huongDan: !!asp.huongDan, tuVan: !!asp.tuVan };
  o.extra.courses = arr_(ex.courses, LIMITS.courses).map(function (x) { return { id: id_(x.id), major: str_(x.major, 200), name: str_(x.name, 200), desc: str_(x.desc, 800) }; });
  o.extra.directions = arr_(ex.directions, LIMITS.directions).map(function (x) { return { id: id_(x.id), name: str_(x.name, 300), keywords: str_(x.keywords, 400) }; });
  o.extra.orcid = str_(ex.orcid, 60); o.extra.scopusId = str_(ex.scopusId, 60); o.extra.scholar = str_(ex.scholar, 300);
  return o;
}
function decryptProfile_(stored) {
  var p = JSON.parse(JSON.stringify(stored));
  p.idDoc = p.idDoc || {}; p.idDoc.number = decrypt_(p.idDoc.numberEnc); delete p.idDoc.numberEnc;
  return p;
}

function apiBootstrap() {
  return run_(function () {
    var c = ctx_(), rec = findProfileRow_(c.email), CV = CVm_();
    var profile = rec ? decryptProfile_(rec.profile) : CV.emptyProfile();
    return {
      user: userView_(c.email, c.role),
      profile: profile, updatedAt: rec ? rec.updatedAt : '', consent: rec ? rec.consent : {}, firstRun: !rec,
      catalogs: getCatalogs_(), exports: listExports_(c.email), version: '1.0.0'
    };
  });
}

function apiSaveProfile(profile, baseUpdatedAt) {
  return run_(function () {
    var c = ctx_();
    return lock_(function () {
      var rec = findProfileRow_(c.email);
      if (rec && baseUpdatedAt && String(rec.updatedAt) !== String(baseUpdatedAt)) {
        return { conflict: true, updatedAt: rec.updatedAt, profile: decryptProfile_(rec.profile) };
      }
      var clean = cleanProfile_(profile, rec && rec.profile), ts = nowIso_();
      var chunks = pack_(clean);
      var fixed = [c.email, c.org, rec ? rec.createdAt : ts, ts, JSON.stringify(rec ? rec.consent : {}), chunks.length];
      writeRowWithChunks_(sheet_('Profiles'), rec ? rec.row : 0, fixed, chunks);
      audit_(c.email, 'profile.save', c.email, '');
      return { updatedAt: ts, profile: decryptProfile_(clean) };
    });
  });
}

var CONSENT_KEYS = ['profile', 'contact', 'education', 'projects', 'publications', 'expertise'];
function apiSaveConsent(consent) {
  return run_(function () {
    var c = ctx_();
    return lock_(function () {
      var rec = findProfileRow_(c.email);
      if (!rec) throw userError_('Hãy lưu hồ sơ trước khi thiết lập chia sẻ.');
      var old = rec.consent || {}, out = {}, ts = nowIso_();
      CONSENT_KEYS.forEach(function (k) {
        var on = !!(consent && consent[k]);
        out[k] = { on: on, at: (old[k] && !!old[k].on === on) ? old[k].at : ts };
      });
      sheet_('Profiles').getRange(rec.row, 5).setValue(JSON.stringify(out));
      audit_(c.email, 'consent.update', c.email, CONSENT_KEYS.filter(function (k) { return out[k].on; }).join(','));
      return out;
    });
  });
}

function apiMyAdminPreview() {
  return run_(function () {
    var c = ctx_(), rec = findProfileRow_(c.email);
    var admins = readAll_('Admins').filter(function (a) { return String(a.orgs).toLowerCase().split(',').map(function (x) { return x.trim(); }).indexOf(c.org) >= 0; }).map(function (a) { return a.email; });
    if (c.isSys && admins.indexOf(c.email) < 0) admins.push(c.email);
    var invites = readAll_('Invites').filter(function (i) { return String(i.to).toLowerCase() === c.email; }).slice(-30).reverse()
      .map(function (i) { return { from: i.from, subject: i.subject, kind: i.kind, createdAt: i.createdAt }; });
    return { view: rec ? projectForAdmin_(rec) : { email: c.email, org: c.org, consent: [] }, admins: admins, invites: invites };
  });
}

function apiDeleteAccount(confirmEmail) {
  return run_(function () {
    var c = ctx_();
    if (String(confirmEmail || '').toLowerCase() !== c.email) throw userError_('Email xác nhận không khớp.');
    return lock_(function () {
      var rec = findProfileRow_(c.email); if (rec) sheet_('Profiles').deleteRow(rec.row);
      deleteRowsWhere_('Exports', 'email', c.email);
      deleteRowsWhere_('EmailVerify', 'email', c.email);
      deleteRowsWhere_('Invites', 'to', c.email);
      var anon = 'deleted:' + Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, c.email)).slice(0, 10);
      var au = sheet_('Audit'), n = au.getLastRow();
      if (n >= 2) {
        var vals = au.getRange(2, 1, n - 1, 5).getValues(), ch = false;
        vals.forEach(function (r) { if (String(r[1]).toLowerCase() === c.email) { r[1] = anon; ch = true; } if (String(r[3]).toLowerCase() === c.email) { r[3] = anon; ch = true; } });
        if (ch) au.getRange(2, 1, n - 1, 5).setValues(vals);
      }
      audit_(anon, 'account.delete', anon, '');
      return true;
    });
  });
}
function deleteRowsWhere_(name, key, email) {
  var rows = readAll_(name).filter(function (r) { return String(r[key]).toLowerCase() === email; }).map(function (r) { return r._row; }).sort(function (a, b) { return b - a; });
  var sh = sheet_(name); rows.forEach(function (r) { sh.deleteRow(r); });
}

/* ===================== TRA CỨU DOI (Crossref → OpenAlex) ===================== */
var VN_SURNAMES_ = ['nguyen', 'tran', 'le', 'pham', 'hoang', 'huynh', 'phan', 'vu', 'vo', 'dang', 'bui', 'do', 'ho', 'ngo', 'duong', 'ly', 'truong', 'dinh', 'dao', 'luong', 'ta', 'trinh', 'mai', 'ha', 'lam', 'cao'];
function vnName_(given, family) {
  given = String(given || '').trim(); family = String(family || '').trim();
  var fam = CVm_().norm(family).split(' ')[0];
  if (VN_SURNAMES_.indexOf(fam) >= 0 && family.split(' ').length <= 2) return (family + ' ' + given).trim();
  return (given + ' ' + family).trim();
}
function extractDoi_(input) {
  var m = /10\.\d{4,9}\/[^\s"<>]+/i.exec(String(input || '')); if (!m) return '';
  return m[0].replace(/[.,;)\]]+$/, '');
}
function apiLookupDoi(input) {
  return run_(function () {
    var c = ctx_(), doi = extractDoi_(input);
    if (!doi) throw userError_('Không tìm thấy DOI hợp lệ (dạng 10.xxxx/...). Với tạp chí trong nước không có DOI, hãy nhập tay.');
    var mail = c.owner || c.email, res = null;
    try {
      var r = UrlFetchApp.fetch('https://api.crossref.org/works/' + encodeURIComponent(doi).replace(/%2F/g, '/') + '?mailto=' + encodeURIComponent(mail), { muteHttpExceptions: true });
      if (r.getResponseCode() === 200) res = fromCrossref_(JSON.parse(r.getContentText()).message, doi);
    } catch (e) { console.warn('crossref', e); }
    if (!res) {
      try {
        var r2 = UrlFetchApp.fetch('https://api.openalex.org/works/https://doi.org/' + encodeURIComponent(doi).replace(/%2F/g, '/') + '?mailto=' + encodeURIComponent(mail), { muteHttpExceptions: true });
        if (r2.getResponseCode() === 200) res = fromOpenAlex_(JSON.parse(r2.getContentText()), doi);
      } catch (e2) { console.warn('openalex', e2); }
    }
    if (!res) throw userError_('Không tra cứu được DOI "' + doi + '" từ Crossref/OpenAlex. Bạn có thể nhập tay.');
    audit_(c.email, 'doi.lookup', doi, res.source);
    return res;
  });
}
function fromCrossref_(m, doi) {
  var type = m.type === 'book' || m.type === 'monograph' || m.type === 'edited-book' ? 'book' : (m.type === 'proceedings-article' ? 'conference' : 'article');
  var dp = (m.issued && m.issued['date-parts'] && m.issued['date-parts'][0]) || [];
  return { source: 'crossref', verified: true, type: type, doi: doi, title: (m.title && m.title[0]) || '',
    authors: (m.author || []).map(function (a) { return { name: vnName_(a.given, a.family) || a.name || '', me: false, main: false, corr: false }; }),
    venue: (m['container-title'] && m['container-title'][0]) || '', volume: m.volume || '', issue: m.issue || '', pages: m.page || '',
    year: dp[0] ? String(dp[0]) : '', issn: (m.ISSN && m.ISSN[0]) || '', isbn: (m.ISBN && m.ISBN[0]) || '', publisher: m.publisher || '', keywords: m.subject || [] };
}
function fromOpenAlex_(w, doi) {
  var loc = (w.primary_location && w.primary_location.source) || {}, bib = w.biblio || {};
  return { source: 'openalex', verified: true, type: w.type === 'book' ? 'book' : 'article', doi: doi, title: w.title || w.display_name || '',
    authors: (w.authorships || []).map(function (a) { var n = (a.author && a.author.display_name) || ''; var p = n.split(' '); return { name: vnName_(p.slice(0, -1).join(' '), p.slice(-1)[0]), me: false, main: false, corr: false }; }),
    venue: loc.display_name || '', volume: bib.volume || '', issue: bib.issue || '', pages: [bib.first_page, bib.last_page].filter(Boolean).join('-'),
    year: w.publication_year ? String(w.publication_year) : '', issn: loc.issn_l || '', isbn: '', publisher: loc.host_organization_name || '',
    keywords: (w.keywords || []).map(function (k) { return k.display_name || k; }).slice(0, 8) };
}

/* ===================== XÁC MINH EMAIL LIÊN HỆ ===================== */
function apiSendEmailVerification(contact) {
  return run_(function () {
    var c = ctx_(); contact = str_(contact, 200).toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(contact)) throw userError_('Email không hợp lệ.');
    var code = String(Math.floor(100000 + Math.random() * 900000)), token = Utilities.getUuid().replace(/-/g, '');
    lock_(function () { deleteRowsWhere_('EmailVerify', 'email', c.email); appendRow_('EmailVerify', [c.email, contact, code, token, nowIso_(), '']); });
    var link = ScriptApp.getService().getUrl() + '?verify=' + token;
    MailApp.sendEmail({ to: contact, subject: '[' + APP_NAME + '] Xác minh email liên hệ',
      htmlBody: '<p>Mã xác minh của bạn: <b style="font-size:18px">' + code + '</b></p><p>Hoặc mở liên kết: <a href="' + link + '">' + link + '</a></p><p>Mã có hiệu lực 48 giờ. Nếu bạn không yêu cầu, hãy bỏ qua thư này.</p>', name: APP_NAME });
    audit_(c.email, 'email.verify.send', c.email, '');
    return true;
  });
}
function applyVerified_(email, contact) {
  var rec = findProfileRow_(email); if (!rec) return false;
  rec.profile.basic.contactEmail = contact; rec.profile.basic.contactEmailVerified = true;
  var chunks = pack_(rec.profile), ts = nowIso_();
  writeRowWithChunks_(sheet_('Profiles'), rec.row, [rec.email, rec.org, rec.createdAt, ts, JSON.stringify(rec.consent), chunks.length], chunks);
  return ts;
}
function apiConfirmEmailCode(code) {
  return run_(function () {
    var c = ctx_();
    return lock_(function () {
      var r = readAll_('EmailVerify').filter(function (x) { return String(x.email).toLowerCase() === c.email; })[0];
      if (!r || String(r.code) !== String(code).trim() || Date.now() - new Date(r.createdAt).getTime() > 48 * 3600 * 1000) throw userError_('Mã không đúng hoặc đã hết hạn.');
      var ts = applyVerified_(c.email, r.contact);
      if (!ts) throw userError_('Hãy lưu hồ sơ trước khi xác minh email.');
      sheet_('EmailVerify').deleteRow(r._row);
      audit_(c.email, 'email.verify.ok', c.email, '');
      return { contactEmail: r.contact, updatedAt: ts };
    });
  });
}
function verifyLinkPage_(token) {
  var msg = 'Liên kết không hợp lệ hoặc đã hết hạn.';
  try {
    lock_(function () {
      var r = readAll_('EmailVerify').filter(function (x) { return String(x.token) === String(token); })[0];
      if (r && Date.now() - new Date(r.createdAt).getTime() < 48 * 3600 * 1000 && applyVerified_(String(r.email).toLowerCase(), r.contact)) {
        sheet_('EmailVerify').deleteRow(r._row); msg = 'Đã xác minh email liên hệ. Bạn có thể đóng trang này và quay lại ứng dụng.';
      }
    });
  } catch (e) { console.error(e); }
  return HtmlService.createHtmlOutput('<meta charset="utf-8"><body style="font-family:sans-serif;max-width:520px;margin:15vh auto;padding:0 16px"><h2>' + APP_NAME + '</h2><p>' + msg + '</p></body>');
}

/* ===================== LỊCH SỬ XUẤT & XUẤT FILE ===================== */
function getConfig_(key, def) {
  var r = readAll_('Config').filter(function (x) { return x.key === key; })[0];
  return r ? safeJson_(r.json, def) : def;
}
function setConfig_(key, val) {
  var r = readAll_('Config').filter(function (x) { return x.key === key; })[0];
  if (r) sheet_('Config').getRange(r._row, 2).setValue(JSON.stringify(val)); else appendRow_('Config', [key, JSON.stringify(val)]);
}
function listExports_(email) {
  return readAll_('Exports').filter(function (r) { return String(r.email).toLowerCase() === email; })
    .map(function (r) { return { id: r.id, name: r.name, createdAt: r.createdAt, template: r.template, format: r.format, config: safeJson_(r.config, {}) }; })
    .sort(function (a, b) { return a.createdAt < b.createdAt ? 1 : -1; });
}
function purgeExports_(email) {
  var keep = getConfig_('retention', { maxExports: 20, days: 365 });
  var mine = readAll_('Exports').filter(function (r) { return String(r.email).toLowerCase() === email; }).sort(function (a, b) { return a.createdAt < b.createdAt ? 1 : -1; });
  var cutoff = Date.now() - keep.days * 86400000, del = [];
  mine.forEach(function (r, i) { if (i >= keep.maxExports || new Date(r.createdAt).getTime() < cutoff) del.push(r._row); });
  del.sort(function (a, b) { return b - a; }).forEach(function (r) { sheet_('Exports').deleteRow(r); });
}

/* ===================== TẠO FILE .DOCX TRỰC TIẾP (OOXML) =====================
 * Tự dựng gói .docx để có tab dẫn dấu chấm (leader) và dòng nối tiếp đúng mẫu BM04,
 * điều mà DocumentApp không hỗ trợ. */
var PAGE_W_ = 11906, PAGE_H_ = 16838, MAR_L_ = 1701, MAR_R_ = 1134, MAR_T_ = 1134, MAR_B_ = 1134;
var TEXT_W_ = PAGE_W_ - MAR_L_ - MAR_R_; // 9071 twips
function xe_(t) { return String(t == null ? '' : t).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function runXml_(r, size) {
  if (r === '\t') return '<w:r><w:tab/></w:r>';
  if (!r.t) return '';
  var pr = (r.b ? '<w:b/>' : '') + (r.i ? '<w:i/>' : '') + (size ? '<w:sz w:val="' + Math.round(size * 2) + '"/><w:szCs w:val="' + Math.round(size * 2) + '"/>' : '');
  return '<w:r>' + (pr ? '<w:rPr>' + pr + '</w:rPr>' : '') + '<w:t xml:space="preserve">' + xe_(r.t) + '</w:t></w:r>';
}
function paraXml_(runs, o) {
  o = o || {};
  var ppr = '';
  if (o.keepNext) ppr += '<w:keepNext/>';
  if (o.rule) ppr += '<w:pBdr><w:bottom w:val="single" w:sz="6" w:space="2" w:color="000000"/></w:pBdr>';
  if (o.tabs && o.tabs.length) ppr += '<w:tabs>' + o.tabs.map(function (t) { return '<w:tab w:val="' + t.val + '" w:leader="' + (t.leader || 'none') + '" w:pos="' + t.pos + '"/>'; }).join('') + '</w:tabs>';
  ppr += '<w:spacing w:before="' + Math.round((o.before || 0) * 20) + '" w:after="' + Math.round((o.after == null ? 3 : o.after) * 20) + '" w:line="' + (o.line || 264) + '" w:lineRule="auto"/>';
  if (o.rule) { var ind = Math.round((1 - o.rule) / 2 * TEXT_W_); ppr += '<w:ind w:left="' + ind + '" w:right="' + ind + '"/>'; }
  if (o.align === 'center') ppr += '<w:jc w:val="center"/>'; else if (o.align === 'right') ppr += '<w:jc w:val="right"/>';
  return '<w:p><w:pPr>' + ppr + '</w:pPr>' + runs.map(function (r) { return runXml_(r, o.size); }).join('') + '</w:p>';
}
function rowRuns_(b) { // dòng nối tiếp: chỉ mục TRỐNG mới có dấu chấm dẫn; mục đã nhập thì không còn dấu chấm thừa
  var runs = [], tabs = [], n = b.items.length;
  if (b.leadW) { if (b.lead) runs.push({ t: b.lead, b: true }); runs.push('\t'); tabs.push({ val: 'left', leader: 'none', pos: Math.round(b.leadW * TEXT_W_) }); }
  b.items.forEach(function (it, i) {
    runs.push({ t: it.label + (it.plain ? ' ' : ': ') }); if (it.value) runs.push({ t: it.value, b: true });
    if (i < n - 1) { runs.push('\t'); tabs.push({ val: 'left', leader: it.value ? 'none' : 'dot', pos: Math.round((b.stops[i] || ((i + 1) / n)) * TEXT_W_) }); }
    else if (!it.value) { runs.push('\t'); tabs.push({ val: 'right', leader: 'dot', pos: TEXT_W_ }); }
  });
  return { runs: runs, tabs: tabs };
}
function cellXml_(c, w, o) {
  o = o || {};
  var paras = typeof c === 'string' ? [[{ t: c }]] : c.paras;
  var inner = paras.map(function (runs) {
    if (o.bold) runs = runs.map(function (r) { return { t: r.t, b: true, i: r.i }; });
    return paraXml_(runs, { size: o.size || 11.5, after: 0, before: 0, line: 252, align: o.center ? 'center' : '' });
  }).join('');
  return '<w:tc><w:tcPr><w:tcW w:w="' + w + '" w:type="dxa"/>' + '' + '</w:tcPr>' + inner + '</w:tc>';
}
function tableXml_(b, borders) {
  var tot = b.widths.reduce(function (a, x) { return a + x; }, 0), ws = b.widths.map(function (w) { return Math.round(TEXT_W_ * w / tot); });
  var bd = borders ? '<w:tblBorders>' + ['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map(function (k) { return '<w:' + k + ' w:val="single" w:sz="4" w:space="0" w:color="000000"/>'; }).join('') + '</w:tblBorders>' : '<w:tblBorders>' + ['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map(function (k) { return '<w:' + k + ' w:val="nil"/>'; }).join('') + '</w:tblBorders>';
  var x = '<w:tbl><w:tblPr><w:tblW w:w="' + TEXT_W_ + '" w:type="dxa"/>' + bd + '<w:tblLayout w:type="fixed"/><w:tblCellMar><w:top w:w="40" w:type="dxa"/><w:left w:w="80" w:type="dxa"/><w:bottom w:w="40" w:type="dxa"/><w:right w:w="80" w:type="dxa"/></w:tblCellMar></w:tblPr><w:tblGrid>' + ws.map(function (w) { return '<w:gridCol w:w="' + w + '"/>'; }).join('') + '</w:tblGrid>';
  if (b.head) x += '<w:tr><w:trPr><w:cantSplit/><w:tblHeader/></w:trPr>' + b.head.map(function (h, i) { return cellXml_(h, ws[i], { bold: true, center: true }); }).join('') + '</w:tr>';
  b.rows.forEach(function (r) { x += '<w:tr><w:trPr><w:cantSplit/></w:trPr>' + r.map(function (c, i) { return cellXml_(c, ws[i], { center: b.center && b.center.indexOf(i) >= 0 }); }).join('') + '</w:tr>'; });
  return x + '</w:tbl>';
}
function blocksToDocumentXml_(blocks) {
  var body = '';
  blocks.forEach(function (b) {
    if (b.t === 'p') body += paraXml_(b.runs, { size: b.size || 12, align: b.align, before: b.before, after: b.after, rule: b.rule, keepNext: b.size >= 12.5 && b.runs.length === 1 && b.runs[0].b && b.align !== 'center' });
    else if (b.t === 'row') { var r = rowRuns_(b); body += paraXml_(r.runs, { size: 12, tabs: r.tabs, after: b.after == null ? 3 : b.after }); }
    else if (b.t === 'table') body += tableXml_(b, true) + paraXml_([{ t: '' }], { size: 4, after: 2 });
    else if (b.t === 'sign') body += tableXml_({ widths: [1, 1], rows: [[b.left, b.right]], center: [0, 1] }, false);
  });
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' + body +
    '<w:p/><w:sectPr><w:pgSz w:w="' + PAGE_W_ + '" w:h="' + PAGE_H_ + '"/><w:pgMar w:top="' + MAR_T_ + '" w:right="' + MAR_R_ + '" w:bottom="' + MAR_B_ + '" w:left="' + MAR_L_ + '" w:header="567" w:footer="567" w:gutter="0"/></w:sectPr></w:body></w:document>';
}
var STYLES_XML_ = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:eastAsia="Times New Roman" w:cs="Times New Roman"/><w:sz w:val="24"/><w:szCs w:val="24"/><w:lang w:val="vi-VN" w:eastAsia="vi-VN"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="0" w:line="264" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style><w:style w:type="table" w:default="1" w:styleId="TableNormal"><w:name w:val="Normal Table"/><w:tblPr><w:tblInd w:w="0" w:type="dxa"/><w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="108" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style></w:styles>';
var CT_XML_ = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>';
var RELS_XML_ = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>';
var DOCRELS_XML_ = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>';

/* ZIP kiểu "store" (không nén) tự viết để không phụ thuộc cách Utilities.zip đặt tên thư mục */
var CRC_T_ = null;
function crc32_(bytes) {
  if (!CRC_T_) { CRC_T_ = []; for (var n = 0; n < 256; n++) { var c = n; for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); CRC_T_[n] = c >>> 0; } }
  var crc = 0xFFFFFFFF; for (var i = 0; i < bytes.length; i++) crc = CRC_T_[(crc ^ bytes[i]) & 255] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}
function u8_(str) { return Utilities.newBlob(str, 'text/plain').getBytes().map(function (b) { return b & 255; }); }
function le_(v, n) { var o = []; for (var i = 0; i < n; i++) o.push((v >>> (8 * i)) & 255); return o; }
function zipStore_(files) { // files: [{name, text}] -> mảng byte có dấu (dùng cho Utilities.newBlob)
  var out = [], central = [], offset = 0;
  files.forEach(function (f) {
    var nm = u8_(f.name), data = u8_(f.text), crc = crc32_(data);
    var lh = [].concat(le_(0x04034b50, 4), le_(20, 2), le_(0x0800, 2), le_(0, 2), le_(0, 2), le_(0x21, 2), le_(crc, 4), le_(data.length, 4), le_(data.length, 4), le_(nm.length, 2), le_(0, 2), nm);
    out = out.concat(lh, data);
    central = central.concat(le_(0x02014b50, 4), le_(20, 2), le_(20, 2), le_(0x0800, 2), le_(0, 2), le_(0, 2), le_(0x21, 2), le_(crc, 4), le_(data.length, 4), le_(data.length, 4), le_(nm.length, 2), le_(0, 2), le_(0, 2), le_(0, 2), le_(0, 2), le_(0, 4), le_(offset, 4), nm);
    offset += lh.length + data.length;
  });
  var end = [].concat(le_(0x06054b50, 4), le_(0, 2), le_(0, 2), le_(files.length, 2), le_(files.length, 2), le_(central.length, 4), le_(offset, 4), le_(0, 2));
  return out.concat(central, end).map(function (b) { return b > 127 ? b - 256 : b; });
}
function buildDocxBytes_(blocks) {
  return zipStore_([{ name: '[Content_Types].xml', text: CT_XML_ }, { name: '_rels/.rels', text: RELS_XML_ },
    { name: 'word/document.xml', text: blocksToDocumentXml_(blocks) }, { name: 'word/styles.xml', text: STYLES_XML_ }, { name: 'word/_rels/document.xml.rels', text: DOCRELS_XML_ }]);
}
var DOCX_MIME_ = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
function docxToPdfBytes_(docxBytes) { // chuyển docx -> Google Doc tạm (Drive API nâng cao v3) -> PDF
  var blob = Utilities.newBlob(docxBytes, DOCX_MIME_, 'tmp.docx'), f = Drive.Files.create({ name: 'tmp-export-' + Utilities.getUuid(), mimeType: 'application/vnd.google-apps.document' }, blob);
  try {
    var resp = UrlFetchApp.fetch('https://docs.google.com/document/d/' + f.id + '/export?format=pdf', { headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() }, muteHttpExceptions: true });
    if (resp.getResponseCode() !== 200) throw userError_('Không tạo được PDF (' + resp.getResponseCode() + ').');
    return resp.getBlob().getBytes();
  } finally { try { DriveApp.getFileById(f.id).setTrashed(true); } catch (e) { } }
}
function slug_(s) { return CVm_().norm(s).replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40) || 'CV'; }
function buildFile_(snapshot, cfg, format) {
  var CV = CVm_(), P = decryptProfile_(snapshot.profile); P.account = { email: snapshot.accountEmail };
  var bytes = buildDocxBytes_(CV.buildModel(P, cfg)), fmt = format === 'pdf' ? 'pdf' : 'docx';
  if (fmt === 'pdf') bytes = docxToPdfBytes_(bytes);
  var stamp = Utilities.formatDate(new Date(), 'Asia/Ho_Chi_Minh', 'yyyyMMdd');
  return { fileName: 'LyLichKhoaHoc_' + slug_(P.basic.fullName) + '_' + stamp + '.' + fmt, mime: fmt === 'pdf' ? 'application/pdf' : DOCX_MIME_, base64: Utilities.base64Encode(bytes) };
}
function apiExport(cfg, format, name) {
  return run_(function () {
    var c = ctx_(), rec = findProfileRow_(c.email);
    if (!rec) throw userError_('Hãy lưu hồ sơ trước khi xuất.');
    var CV = CVm_(), clean = CV.mergeConfig(cfg), snap = { profile: rec.profile, accountEmail: c.email, takenAt: nowIso_() };
    var file = buildFile_(snap, clean, format), id = 'x' + Utilities.getUuid().replace(/-/g, '').slice(0, 12), ts = nowIso_();
    lock_(function () {
      var chunks = pack_(snap);
      writeRowWithChunks_(sheet_('Exports'), 0, [id, c.email, str_(name, 120) || ('Bản xuất ' + Utilities.formatDate(new Date(), 'Asia/Ho_Chi_Minh', 'dd/MM/yyyy HH:mm')), ts, clean.template, format === 'pdf' ? 'pdf' : 'docx', JSON.stringify(clean), chunks.length], chunks);
      purgeExports_(c.email);
    });
    audit_(c.email, 'export', c.email, clean.template + '/' + format);
    file.id = id; file.exports = listExports_(c.email);
    return file;
  });
}
function exportRow_(email, id) {
  var r = readAll_('Exports').filter(function (x) { return x.id === id && String(x.email).toLowerCase() === email; })[0];
  if (!r) throw userError_('Không tìm thấy bản xuất.');
  return r;
}
/** mode: 'snapshot' = tải lại đúng dữ liệu lúc xuất; 'current' = xuất lại bằng dữ liệu hiện tại với cấu hình đã lưu */
function apiReexport(id, mode, format, cfgOverride) {
  return run_(function () {
    var c = ctx_(), r = exportRow_(c.email, id), CV = CVm_();
    var cfg = CV.mergeConfig(cfgOverride || safeJson_(r.config, {}));
    var snap = unpack_(chunksOf_(r._raw, EXPORT_CHUNK_COL - 1, r._raw[7]));
    if (mode === 'current') { var rec = findProfileRow_(c.email); snap = { profile: rec.profile, accountEmail: c.email, takenAt: nowIso_() }; }
    audit_(c.email, 'export.' + mode, id, '');
    return buildFile_(snap, cfg, format || r.format);
  });
}
function apiExportSnapshotProfile(id) { // để mở lại cấu hình trên trang Xuất CV
  return run_(function () { var c = ctx_(), r = exportRow_(c.email, id); return { config: safeJson_(r.config, {}), name: r.name }; });
}
function apiRenameExport(id, name) {
  return run_(function () { var c = ctx_(), r = exportRow_(c.email, id); sheet_('Exports').getRange(r._row, 3).setValue(safeCell_(str_(name, 120))); return listExports_(c.email); });
}
function apiDeleteExport(id) {
  return run_(function () { var c = ctx_(); return lock_(function () { var r = exportRow_(c.email, id); sheet_('Exports').deleteRow(r._row); return listExports_(c.email); }); });
}

/* ===================== DANH MỤC ===================== */
function getCatalogs_() {
  var out = {};
  readAll_('Catalogs').forEach(function (r) { out[r.name] = safeJson_(r.json, []); });
  var def = defaultCatalogs_(); Object.keys(def).forEach(function (k) { if (!out[k] || !out[k].length) out[k] = def[k]; });
  return out;
}