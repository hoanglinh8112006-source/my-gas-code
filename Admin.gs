/* ===================== PHÂN HỆ ADMIN & QUẢN TRỊ HỆ THỐNG ===================== */

/** Chiếu hồ sơ → chỉ những gì người dùng ĐỒNG Ý chia sẻ. Không bao giờ có số giấy tờ. */
function projectForAdmin_(rec) {
  var CV = CVm_(), P = rec.profile, cn = rec.consent || {}, D = CV.derive(P);
  function on(k) { return !!(cn[k] && cn[k].on); }
  var out = { email: rec.email, org: rec.org, updatedAt: rec.updatedAt, consent: CONSENT_KEYS.filter(on) };
  if (on('profile')) { out.name = P.basic.fullName; out.workplace = P.basic.workplace; out.position = P.basic.position;
    var H = CV.effective(P); out.highestDegree = H.degree; out.highestTitle = H.title; out.titleCode = H.title === 'Giáo sư' ? 'GS' : (H.title === 'Phó giáo sư' ? 'PGS' : D.titleCode); out.titleMajor = D.titleMajor; }
  if (on('contact')) { out.phones = [P.basic.phoneCQ && 'CQ: ' + P.basic.phoneCQ, P.basic.phoneDD && 'ĐĐ: ' + P.basic.phoneDD].filter(Boolean).join('  ');
    out.contactEmail = P.basic.contactEmailVerified ? P.basic.contactEmail : ''; out.address = P.basic.address; }
  if (on('education')) {
    out.degrees = P.degrees.map(function (d) { return { level: d.level, degree: d.degree, major: d.major, institution: d.institution, country: d.country, year: d.year }; });
    out.languages = P.languages.map(function (l) { return { language: l.language, level: l.level }; });
    out.work = P.work.map(function (w) { return { from: w.from, to: w.to, current: w.current, org: w.org, position: w.position }; });
  }
  if (on('projects')) out.projects = P.projects;
  if (on('publications')) out.pubs = P.pubs.map(function (p) { return { title: p.title, year: p.year, venue: p.venue || p.publisher, type: p.type, indexClass: p.indexClass, verified: p.verified, keywords: p.keywords, doi: p.doi }; });
  if (on('expertise')) { out.aspirations = P.extra.aspirations; out.courses = P.extra.courses; out.directions = P.extra.directions;
    out.orcid = P.extra.orcid; out.scopusId = P.extra.scopusId; out.scholar = P.extra.scholar; out.awards = P.awards; }
  return out;
}

function orgScope_(c) { return c.adminOrgs; }

function adminViews_(c) {
  return allProfiles_(orgScope_(c)).map(projectForAdmin_);
}
function stats_(v) {
  var lead = {}; CVm_().LEVELS.forEach(function (l) { lead[l] = 0; });
  (v.projects || []).forEach(function (p) { if (p.role === 'Chủ nhiệm' && lead[p.level] != null) lead[p.level]++; });
  var intl = 0, dom = 0, iv = 0, dv = 0;
  (v.pubs || []).forEach(function (p) {
    if (p.indexClass === 'isi_scopus' || p.indexClass === 'intl_other') { intl++; if (p.verified) iv++; }
    else if (p.indexClass === 'domestic') { dom++; if (p.verified) dv++; }
  });
  return { lead: lead, intl: intl, dom: dom, intlVerified: iv, domVerified: dv, projects: (v.projects || []).length };
}

function apiAdminSearch(f) {
  return run_(function () {
    var c = needAdmin_(), CV = CVm_(); f = f || {};
    var bl = {}; getBlocked_().forEach(function (b) { bl[b.email] = 1; });
    var q = CV.norm(f.q || ''), unit = CV.norm(f.unit || ''), major = CV.norm(f.major || '');
    var needs = (f.needs || []).filter(function (k) { return ['giangDay', 'hoiDong', 'nghienCuu', 'huongDan', 'tuVan'].indexOf(k) >= 0; });
    var res = adminViews_(c).filter(function (v) {
      var st = v._st = stats_(v);
      if (q && CV.norm([v.email, v.name].join(' ')).indexOf(q) < 0) return false;
      if (unit && CV.norm(v.workplace || '').indexOf(unit) < 0) return false;
      if (major) {
        var hay = CV.norm([v.titleMajor].concat((v.degrees || []).map(function (d) { return d.major; })).concat((v.directions || []).map(function (d) { return d.name; })).join(' '));
        if (hay.indexOf(major) < 0) return false;
      }
      if (needs.length) {
        var a = v.aspirations; if (!a) return false;
        var hits = needs.filter(function (k) { return a[k]; });
        if (f.needsMode === 'all' ? hits.length !== needs.length : hits.length === 0) return false;
      }
      if (f.title) { if (f.title === 'any' ? !v.titleCode : (f.title === 'none' ? (v.titleCode || !v.consent.length) : v.titleCode !== f.title)) return false; }
      if (f.minDegree) { if (CV.DEG_RANK[v.highestDegree] == null || CV.DEG_RANK[v.highestDegree] < CV.DEG_RANK[f.minDegree]) return false; }
      if (f.leadMin) { var lv = f.leadLevel ? st.lead[f.leadLevel] : Object.keys(st.lead).reduce(function (s, k) { return s + st.lead[k]; }, 0); if (lv < Number(f.leadMin)) return false; }
      var intl = f.verifiedOnly ? st.intlVerified : st.intl, dom = f.verifiedOnly ? st.domVerified : st.dom;
      if (f.intlMin && intl < Number(f.intlMin)) return false;
      if (f.domMin && dom < Number(f.domMin)) return false;
      return true;
    }).map(function (v) {
      return { blocked: !!bl[String(v.email).toLowerCase()], email: v.email, name: v.name || '', workplace: v.workplace || '', position: v.position || '', highestDegree: v.highestDegree || '', highestTitle: v.highestTitle || '',
        phones: v.phones || '', contactEmail: v.contactEmail || '', aspirations: v.aspirations || null, stats: v._st, consent: v.consent, hasProfileConsent: v.consent.indexOf('profile') >= 0 };
    });
    audit_(c.email, 'admin.search', '', { f: f, n: res.length });
    return res;
  });
}

function apiAdminMember(email) {
  return run_(function () {
    var c = needAdmin_(); email = String(email || '').toLowerCase();
    var rec = allProfiles_(orgScope_(c)).filter(function (r) { return String(r.email).toLowerCase() === email; })[0];
    if (!rec) throw userError_('Không tìm thấy thành viên trong phạm vi tổ chức của bạn.');
    audit_(c.email, 'admin.view', email, '');
    var v = projectForAdmin_(rec); v.stats = stats_(v); return v;
  });
}

/* ---- Ghép nối bằng từ khoá (không dùng embedding): xếp hạng + lý do gợi ý ---- */
var STOP_ = { 'va': 1, 'cua': 1, 'cho': 1, 'cac': 1, 'trong': 1, 'mot': 1, 'nhung': 1, 'de': 1, 'voi': 1, 'tai': 1, 'the': 1, 'of': 1, 'and': 1, 'for': 1, 'in': 1, 'a': 1, 'on': 1, 'to': 1, 'with': 1, 'an': 1, 'by': 1, 'is': 1, 'are': 1, 'cong': 1, 'nghe': 0 };
function tokens_(text) {
  var t = CVm_().norm(text).replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(function (w) { return w.length > 1 && !STOP_[w]; });
  var out = t.slice(); for (var i = 0; i < t.length - 1; i++) out.push(t[i] + ' ' + t[i + 1]); return out;
}
function apiAdminMatch(query, mode) {
  return run_(function () {
    var c = needAdmin_(); query = String(query || '').slice(0, 3000);
    if (query.trim().length < 3) throw userError_('Hãy nhập mô tả (hướng nghiên cứu, từ khoá hoặc bài toán của doanh nghiệp).');
    var qt = tokens_(query), qset = {}; qt.forEach(function (t) { qset[t] = 1; });
    var views = adminViews_(c), docs = [], df = {};
    views.forEach(function (v) {
      var tf = {}, srcs = [];
      function add(text, w, label, extra) {
        var tk = tokens_(text), hit = [];
        tk.forEach(function (t) { tf[t] = (tf[t] || 0) + w; if (qset[t]) hit.push(t); });
        if (hit.length) srcs.push({ label: label, text: text, hits: hit, w: w, extra: extra || 0 });
      }
      (v.directions || []).forEach(function (d) { add(d.name, 3, 'Hướng nghiên cứu'); add(d.keywords, 3, 'Từ khoá'); });
      (v.projects || []).forEach(function (p) { add(p.name, 2, 'Đề tài (' + (p.startYear || '') + ')', Number(p.startYear) || 0); });
      (v.pubs || []).forEach(function (p) { var rec = Math.max(0, (Number(p.year) || 2000) - 2000) / 100; add(p.title, 1.5 + rec, 'Bài báo (' + (p.year || '') + ')', Number(p.year) || 0); (p.keywords || []).forEach(function (k) { add(k, 1.5, 'Từ khoá bài báo'); }); });
      (v.courses || []).forEach(function (cc) { add(cc.name + ' ' + cc.desc, 1, 'Môn giảng dạy'); });
      if (mode === 'business') { (v.awards || []).forEach(function (a) { if (a.kind !== 'giai_thuong') add(a.name + ' ' + a.content, 2.5, CVm_().AWARD_KIND[a.kind] + ' (' + (a.year || '') + ')', Number(a.year) || 0); }); }
      Object.keys(tf).forEach(function (t) { df[t] = (df[t] || 0) + 1; });
      docs.push({ v: v, tf: tf, srcs: srcs });
    });
    var N = Math.max(1, docs.length);
    var ranked = docs.map(function (d) {
      var score = 0, matched = {};
      Object.keys(qset).forEach(function (t) { if (d.tf[t]) { score += d.tf[t] * (Math.log(1 + N / (df[t] || 1))); matched[t] = 1; } });
      if (mode === 'business' && d.v.aspirations && d.v.aspirations.tuVan) score *= 1.25;
      return { d: d, score: score, matched: Object.keys(matched) };
    }).filter(function (r) { return r.score > 0; }).sort(function (a, b) { return b.score - a.score; }).slice(0, 30);
    audit_(c.email, 'admin.match', '', { mode: mode, n: ranked.length });
    return ranked.map(function (r, i) {
      var v = r.d.v;
      var srcs = r.d.srcs.sort(function (a, b) { return (b.hits.length * b.w) - (a.hits.length * a.w) || b.extra - a.extra; }).slice(0, 3)
        .map(function (s) { return { label: s.label, text: String(s.text).slice(0, 160), hits: s.hits.filter(function (h) { return h.indexOf(' ') < 0; }).slice(0, 5) }; });
      return { rank: i + 1, email: v.email, name: v.name || '', workplace: v.workplace || '', highestDegree: v.highestDegree || '', highestTitle: v.highestTitle || '',
        keywords: r.matched.filter(function (m) { return m.indexOf(' ') < 0; }).slice(0, 8), reasons: srcs,
        tuVan: !!(v.aspirations && v.aspirations.tuVan), phones: v.phones || '', contactEmail: v.contactEmail || '' };
    });
  });
}

/* ---- Quy tắc hội đồng (cấu hình được, chỉ cảnh báo) ---- */
var DEFAULT_COUNCIL_ = [
  { id: 'khoa_luan_dh', label: 'Khoá luận đại học', minDegree: 'Thạc sĩ', preferTitles: [], minPreferred: 0 },
  { id: 'luan_van_ths', label: 'Luận văn thạc sĩ', minDegree: 'Tiến sĩ', preferTitles: ['PGS', 'GS'], minPreferred: 0 },
  { id: 'luan_an_ts', label: 'Luận án tiến sĩ', minDegree: 'Tiến sĩ', preferTitles: ['PGS', 'GS'], minPreferred: 0 }
];
function apiAdminCouncil(emails, ruleId) {
  return run_(function () {
    var c = needAdmin_(), CV = CVm_();
    var rules = getConfig_('council', DEFAULT_COUNCIL_), rule = rules.filter(function (r) { return r.id === ruleId; })[0];
    if (!rule) throw userError_('Chưa chọn loại hội đồng.');
    var set = {}; (emails || []).forEach(function (e) { set[String(e).toLowerCase()] = 1; });
    var views = adminViews_(c).filter(function (v) { return set[String(v.email).toLowerCase()]; });
    var need = CV.DEG_RANK[rule.minDegree] || 0, preferred = 0;
    var items = views.map(function (v) {
      var st = 'ok', note = '';
      if (!v.highestDegree && v.consent.indexOf('profile') < 0) { st = 'unknown'; note = 'Thành viên chưa chia sẻ học vị/học hàm.'; }
      else if ((CV.DEG_RANK[v.highestDegree] || 0) < need) { st = 'warn'; note = 'Học vị "' + (v.highestDegree || 'chưa rõ') + '" thấp hơn yêu cầu tối thiểu "' + rule.minDegree + '".'; }
      var pref = (rule.preferTitles || []).indexOf(v.titleCode) >= 0; if (pref && st === 'ok') { preferred++; note = 'Đáp ứng, thuộc diện ưu tiên (' + v.highestTitle + ').'; }
      return { email: v.email, name: v.name || v.email, degree: v.highestDegree || '', title: v.highestTitle || '', status: st, note: note || (st === 'ok' ? 'Đáp ứng.' : '') };
    });
    var overall = [];
    if (rule.minPreferred && preferred < rule.minPreferred) overall.push('Cần ít nhất ' + rule.minPreferred + ' thành viên là ' + (rule.preferTitles || []).join('/') + ' (hiện có ' + preferred + ').');
    audit_(c.email, 'admin.council', ruleId, { n: items.length });
    return { rule: rule, items: items, overall: overall, note: 'Chỉ mang tính cảnh báo; không thay thế quy chế hiện hành của cơ sở.' };
  });
}

/* ---- Gửi thư & nhật ký ---- */
function apiAdminSendMail(p) {
  return run_(function () {
    var c = needAdmin_(); p = p || {};
    var to = (p.to || []).map(function (e) { return String(e).toLowerCase(); });
    var subject = str_(p.subject, 200), body = str_(p.body, 5000);
    if (!to.length || !subject || !body) throw userError_('Cần có người nhận, tiêu đề và nội dung.');
    if (to.length > 50) throw userError_('Tối đa 50 người nhận mỗi lần.');
    if (MailApp.getRemainingDailyQuota() < to.length) throw userError_('Đã hết hạn mức gửi thư trong ngày.');
    var mine = {}; allProfiles_(orgScope_(c)).forEach(function (r) { mine[String(r.email).toLowerCase()] = 1; });
    var kind = p.kind === 'invite' ? 'invite' : 'message', sent = 0;
    to.forEach(function (e) {
      if (!mine[e]) return;
      MailApp.sendEmail({ to: e, subject: '[' + APP_NAME + '] ' + subject, replyTo: c.email, name: APP_NAME + ' (' + c.email + ')',
        body: body + '\n\n—\nThư gửi qua hệ thống ' + APP_NAME + ' bởi quản trị ' + c.email + '. Bạn có thể trả lời trực tiếp thư này. Bạn có thể thu hồi quyền chia sẻ dữ liệu bất cứ lúc nào ở mục "Quyền riêng tư".' });
      appendRow_('Invites', ['m' + Utilities.getUuid().slice(0, 8), c.email, e, subject, kind, nowIso_()]);
      audit_(c.email, 'admin.mail.' + kind, e, subject); sent++;
    });
    return { sent: sent };
  });
}
function apiAdminExportLog(n, filters) {
  return run_(function () { var c = needAdmin_(); audit_(c.email, 'admin.export.list', '', { n: n, filters: filters }); return true; });
}
function apiAdminAudit(limit) {
  return run_(function () {
    var c = needAdmin_(), org = c.adminOrgs;
    var rows = readAll_('Audit');
    var mine = {}; allProfiles_(org).forEach(function (r) { mine[String(r.email).toLowerCase()] = 1; });
    return rows.filter(function (r) { var a = String(r.actor).toLowerCase(), t = String(r.target).toLowerCase(); return c.isSys || mine[a] || mine[t] || a === c.email; })
      .slice(-(limit || 300)).reverse().map(function (r) { return { ts: r.ts, actor: r.actor, action: r.action, target: r.target, detail: r.detail }; });
  });
}

/* ---- Quản trị hệ thống ---- */
function apiSysGet() {
  return run_(function () {
    needSys_();
    return { admins: readAll_('Admins').map(function (a) { return { email: a.email, role: a.role, orgs: a.orgs, addedBy: a.addedBy, addedAt: a.addedAt }; }),
      catalogs: getCatalogs_(), council: getConfig_('council', DEFAULT_COUNCIL_), retention: getConfig_('retention', { maxExports: 20, days: 365 }) };
  });
}
function apiSysSaveAdmins(list) {
  return run_(function () {
    var c = needSys_();
    return lock_(function () {
      var clean = (list || []).slice(0, 200).map(function (a) {
        var e = str_(a.email, 200).toLowerCase(); if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) return null;
        // Hồ sơ của tài khoản Gmail/email công cộng được ghi với tổ chức = chính email đó (xem orgOf_), nên "gmail.com" không bao giờ khớp ai: bỏ đi.
        // Không còn tổ chức hợp lệ thì mặc định: Quản trị hệ thống dùng email công cộng -> "*" (mọi tổ chức); admin thường -> chính tổ chức của mình.
        var pub = PUBLIC_DOMAINS_.indexOf(e.split('@')[1]) >= 0, role = a.role === 'sysadmin' ? 'sysadmin' : 'admin';
        var orgs = str_(a.orgs, 300).toLowerCase().split(',').map(function (x) { return x.trim(); }).filter(function (x) { return x && PUBLIC_DOMAINS_.indexOf(x) < 0; }).join(',') || (pub ? (role === 'sysadmin' ? '*' : e) : e.split('@')[1]);
        return { email: e, role: role, orgs: orgs };
      }).filter(Boolean);
      var sh = sheet_('Admins'); if (sh.getLastRow() > 1) sh.deleteRows(2, sh.getLastRow() - 1);
      clean.forEach(function (a) { appendRow_('Admins', [a.email, a.role, a.orgs, c.email, nowIso_()]); });
      audit_(c.email, 'sys.admins', '', clean.map(function (a) { return a.email + ':' + a.role; }).join(','));
      // Người được cấp quyền quản trị thì tự gỡ chặn, tránh tự khoá chính quản trị viên.
      var bl = getConfig_('blocked', []), keep = bl.filter(function (b) { return !clean.some(function (a) { return a.email === b.email; }); });
      if (keep.length !== bl.length) setBlocked_(keep);
      return clean;
    });
  });
}
function apiSysSaveCatalog(name, items) {
  return run_(function () {
    var c = needSys_();
    if (['schools', 'majors', 'countries', 'ethnicities', 'languages', 'systems', 'provinces'].indexOf(name) < 0) throw userError_('Danh mục không hợp lệ.');
    var list = (items || []).map(function (x) { return str_(x, 200); }).filter(String).slice(0, 3000);
    list = list.filter(function (x, i) { return list.indexOf(x) === i; });
    return lock_(function () {
      var r = readAll_('Catalogs').filter(function (x) { return x.name === name; })[0];
      if (r) sheet_('Catalogs').getRange(r._row, 2).setValue(JSON.stringify(list)); else appendRow_('Catalogs', [name, JSON.stringify(list)]);
      audit_(c.email, 'sys.catalog', name, list.length + ' mục'); return list;
    });
  });
}
function apiSysSaveConfig(council, retention) {
  return run_(function () {
    var c = needSys_(), CV = CVm_();
    var rules = (council || []).slice(0, 20).map(function (r) {
      return { id: str_(r.id, 40) || 'r' + Utilities.getUuid().slice(0, 6), label: str_(r.label, 120), minDegree: CV.DEG_RANK[r.minDegree] ? r.minDegree : 'Thạc sĩ',
        preferTitles: (r.preferTitles || []).filter(function (t) { return t === 'GS' || t === 'PGS'; }), minPreferred: Math.max(0, Math.min(10, Number(r.minPreferred) || 0)) };
    });
    var ret = { maxExports: Math.max(1, Math.min(100, Number(retention && retention.maxExports) || 20)), days: Math.max(7, Math.min(3650, Number(retention && retention.days) || 365)) };
    return lock_(function () { setConfig_('council', rules); setConfig_('retention', ret); audit_(c.email, 'sys.config', '', ''); return { council: rules, retention: ret }; });
  });
}

/* ---- Dữ liệu danh mục mặc định ---- */
function defaultCatalogs_() {
  var data = {
    ethnicities: ['Kinh', 'Tày', 'Thái', 'Hoa', 'Khơ-me', 'Mường', 'Nùng', "H'Mông", 'Dao', 'Gia-rai', 'Ngái', 'Ê-đê', 'Ba na', 'Xơ-Đăng', 'Sán Chay', 'Cơ-ho', 'Chăm', 'Sán Dìu', 'Hrê', 'Mnông', 'Ra-glai', 'Xtiêng', 'Bru-Vân Kiều', 'Thổ', 'Giáy', 'Cơ-tu', 'Gié Triêng', 'Mạ', 'Khơ-mú', 'Co', 'Tà-ôi', 'Chơ-ro', 'Kháng', 'Xinh-mun', 'Hà Nhì', 'Chu ru', 'Lào', 'La Chí', 'La Ha', 'Phù Lá', 'La Hủ', 'Lự', 'Lô Lô', 'Chứt', 'Mảng', 'Pà Thẻn', 'Cơ Lao', 'Cống', 'Bố Y', 'Si La', 'Pu Péo', 'Brâu', 'Ơ Đu', 'Rơ măm'],
    countries: ['Việt Nam', 'Hoa Kỳ', 'Anh', 'Pháp', 'Đức', 'Nga', 'Nhật Bản', 'Hàn Quốc', 'Trung Quốc', 'Úc', 'Canada', 'Singapore', 'Thái Lan', 'Malaysia', 'Đài Loan', 'Ấn Độ', 'Hà Lan', 'Bỉ', 'Thuỵ Sĩ', 'Thuỵ Điển', 'Đan Mạch', 'Phần Lan', 'Na Uy', 'Ý', 'Tây Ban Nha', 'Ba Lan', 'Séc', 'Hungary', 'Bulgaria', 'Rumani', 'Ukraina', 'New Zealand', 'Ireland', 'Áo', 'Cuba', 'Lào', 'Campuchia', 'Indonesia', 'Philippines', 'Hồng Kông'],
    provinces: ['An Giang', 'Bà Rịa - Vũng Tàu', 'Bắc Giang', 'Bắc Kạn', 'Bạc Liêu', 'Bắc Ninh', 'Bến Tre', 'Bình Định', 'Bình Dương', 'Bình Phước', 'Bình Thuận', 'Cà Mau', 'Cần Thơ', 'Cao Bằng', 'Đà Nẵng', 'Đắk Lắk', 'Đắk Nông', 'Điện Biên', 'Đồng Nai', 'Đồng Tháp', 'Gia Lai', 'Hà Giang', 'Hà Nam', 'Hà Nội', 'Hà Tĩnh', 'Hải Dương', 'Hải Phòng', 'Hậu Giang', 'Hòa Bình', 'Hưng Yên', 'Khánh Hòa', 'Kiên Giang', 'Kon Tum', 'Lai Châu', 'Lâm Đồng', 'Lạng Sơn', 'Lào Cai', 'Long An', 'Nam Định', 'Nghệ An', 'Ninh Bình', 'Ninh Thuận', 'Phú Thọ', 'Phú Yên', 'Quảng Bình', 'Quảng Nam', 'Quảng Ngãi', 'Quảng Ninh', 'Quảng Trị', 'Sóc Trăng', 'Sơn La', 'Tây Ninh', 'Thái Bình', 'Thái Nguyên', 'Thanh Hóa', 'Thừa Thiên Huế', 'Tiền Giang', 'TP. Hồ Chí Minh', 'Trà Vinh', 'Tuyên Quang', 'Vĩnh Long', 'Vĩnh Phúc', 'Yên Bái'],
    systems: ['Chính quy', 'Vừa làm vừa học', 'Từ xa', 'Liên thông', 'Văn bằng 2', 'Tại chức', 'Chương trình tiên tiến', 'Chương trình liên kết quốc tế'],
    languages: ['Tiếng Anh', 'Tiếng Pháp', 'Tiếng Nga', 'Tiếng Trung', 'Tiếng Nhật', 'Tiếng Hàn', 'Tiếng Đức', 'Tiếng Tây Ban Nha', 'Tiếng Ý'],
    schools: ['Trường Đại học Sư phạm Kỹ thuật TP. Hồ Chí Minh', 'Trường Đại học Bách khoa – ĐHQG TP.HCM', 'Trường Đại học Khoa học Tự nhiên – ĐHQG TP.HCM', 'Trường Đại học Khoa học Xã hội và Nhân văn – ĐHQG TP.HCM', 'Trường Đại học Kinh tế TP. Hồ Chí Minh', 'Trường Đại học Công nghệ Thông tin – ĐHQG TP.HCM', 'Trường Đại học Quốc tế – ĐHQG TP.HCM', 'Đại học Quốc gia Hà Nội', 'Trường Đại học Bách khoa Hà Nội', 'Trường Đại học Kinh tế Quốc dân', 'Trường Đại học Ngoại thương', 'Trường Đại học Sư phạm Hà Nội', 'Trường Đại học Sư phạm TP. Hồ Chí Minh', 'Trường Đại học Sư phạm Kỹ thuật Hưng Yên', 'Trường Đại học Sư phạm Kỹ thuật Vinh', 'Trường Đại học Công nghiệp TP. Hồ Chí Minh', 'Trường Đại học Nông Lâm TP. Hồ Chí Minh', 'Trường Đại học Tôn Đức Thắng', 'Trường Đại học Giao thông Vận tải', 'Trường Đại học Xây dựng', 'Trường Đại học Thuỷ lợi', 'Trường Đại học Cần Thơ', 'Trường Đại học Huế', 'Trường Đại học Đà Nẵng', 'Trường Đại học Bách khoa – ĐH Đà Nẵng', 'Trường Đại học Vinh', 'Trường Đại học Y Dược TP. Hồ Chí Minh', 'Trường Đại học Y Hà Nội', 'Trường Đại học Luật TP. Hồ Chí Minh', 'Trường Đại học Ngân hàng TP. Hồ Chí Minh', 'Trường Đại học Tài chính – Marketing', 'Trường Đại học Mở TP. Hồ Chí Minh', 'Trường Đại học Hoa Sen', 'Trường Đại học Văn Lang', 'Trường Đại học FPT', 'Trường Đại học Công nghệ TP. Hồ Chí Minh', 'Học viện Công nghệ Bưu chính Viễn thông', 'Học viện Kỹ thuật Quân sự', 'Viện Hàn lâm Khoa học và Công nghệ Việt Nam', 'Viện Hàn lâm Khoa học Xã hội Việt Nam'],
    majors: ['Công nghệ thông tin', 'Khoa học máy tính', 'Kỹ thuật phần mềm', 'Hệ thống thông tin', 'Mạng máy tính và truyền thông dữ liệu', 'An toàn thông tin', 'Trí tuệ nhân tạo', 'Khoa học dữ liệu', 'Công nghệ kỹ thuật điện – điện tử', 'Kỹ thuật điện tử – viễn thông', 'Kỹ thuật điều khiển và tự động hoá', 'Công nghệ kỹ thuật cơ khí', 'Công nghệ chế tạo máy', 'Kỹ thuật cơ điện tử', 'Kỹ thuật ô tô', 'Công nghệ kỹ thuật ô tô', 'Kỹ thuật nhiệt', 'Công nghệ kỹ thuật xây dựng', 'Kỹ thuật xây dựng', 'Kỹ thuật hoá học', 'Công nghệ thực phẩm', 'Công nghệ sinh học', 'Kỹ thuật môi trường', 'Quản lý công nghiệp', 'Quản trị kinh doanh', 'Kinh tế', 'Kế toán', 'Tài chính – Ngân hàng', 'Marketing', 'Thương mại điện tử', 'Logistics và quản lý chuỗi cung ứng', 'Luật kinh tế', 'Ngôn ngữ Anh', 'Sư phạm tiếng Anh', 'Giáo dục học', 'Lý luận và phương pháp dạy học', 'Quản lý giáo dục', 'Toán học', 'Toán ứng dụng', 'Vật lý', 'Hoá học', 'Sinh học', 'Thiết kế đồ hoạ', 'Thiết kế thời trang', 'Kiến trúc', 'Du lịch', 'Quản trị nhà hàng – khách sạn', 'Triết học', 'Văn học', 'Lịch sử', 'Xã hội học', 'Tâm lý học', 'Y khoa', 'Dược học', 'Điều dưỡng', 'Nông học', 'Chăn nuôi – Thú y', 'Thể dục thể thao']
  };
  return data;
}
function seedCatalogs_(ss) {
  var sh = ss.getSheetByName('Catalogs'); if (sh.getLastRow() > 1) return;
  var data = defaultCatalogs_();
  Object.keys(data).forEach(function (k) { sh.appendRow([k, JSON.stringify(data[k])]); });
}

function apiSysGetCouncilPublic() {
  return run_(function () { needAdmin_(); return getConfig_('council', DEFAULT_COUNCIL_); });
}


/* ---- Chặn / gỡ chặn tài khoản (xử lý tài khoản rác) ----
 * Danh sách lưu trong Config (khoá "blocked"): [{email, reason, by, at}], có đệm ngắn trong CacheService và xoá đệm mỗi lần ghi.
 * Hiệu lực ngay: identity_() kiểm tra ở mọi lệnh gọi nên phiên đang mở cũng bị ngắt ở thao tác kế tiếp. Dữ liệu của tài khoản không bị xoá. */
var BLOCKED_MSG_ = 'Tài khoản của bạn đã bị quản trị chặn truy cập. Nếu cho rằng đây là nhầm lẫn, hãy liên hệ quản trị của tổ chức.';
function getBlocked_() {
  var cache = CacheService.getScriptCache(), raw = cache.get('blocked_v1');
  if (raw) { var o = safeJson_(raw, null); if (Array.isArray(o)) return o; }
  var list = getConfig_('blocked', []); if (!Array.isArray(list)) list = [];
  try { cache.put('blocked_v1', JSON.stringify(list), 300); } catch (e) { }
  return list;
}
function setBlocked_(list) {
  setConfig_('blocked', list);
  try { CacheService.getScriptCache().remove('blocked_v1'); } catch (e) { }
}
function isBlocked_(email) {
  email = String(email || '').toLowerCase();
  if (!email || email === ownerEmail_()) return false;   // chủ hệ thống không bao giờ bị chặn
  return getBlocked_().some(function (b) { return b.email === email; });
}
/** Quản trị theo tổ chức chỉ xử lý tài khoản thuộc tổ chức của mình; Quản trị hệ thống xử lý mọi tài khoản. */
function canManageAccount_(c, email) {
  return c.isSys || c.adminOrgs.indexOf('*') >= 0 || c.adminOrgs.indexOf(orgOf_(email)) >= 0;
}
function blockedFor_(c, list) {
  return (list || getConfig_('blocked', [])).filter(function (b) { return canManageAccount_(c, b.email) || b.by === c.email; })
    .sort(function (a, b) { return String(b.at).localeCompare(String(a.at)); });
}
function apiAdminBlockList() {
  return run_(function () { var c = needAdmin_(); return blockedFor_(c, getBlocked_()); });
}
function apiAdminBlock(email, reason) {
  return run_(function () {
    var c = needAdmin_(); email = str_(email, 200).toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw userError_('Email không hợp lệ.');
    if (email === c.email) throw userError_('Bạn không thể tự chặn tài khoản của mình.');
    if (email === ownerEmail_() || rolesOf_(email).canAdmin) throw userError_('Không thể chặn quản trị viên. Hãy gỡ quyền quản trị của họ trước (mục Quản trị hệ thống).');
    if (!canManageAccount_(c, email)) throw userError_('Tài khoản này nằm ngoài phạm vi tổ chức của bạn. Hãy nhờ Quản trị hệ thống xử lý.');
    reason = str_(reason, 200);
    return lock_(function () {
      var list = getConfig_('blocked', []).filter(function (b) { return b.email !== email; });
      if (list.length >= 2000) throw userError_('Danh sách chặn đã đầy (2000 tài khoản).');
      list.push({ email: email, reason: reason, by: c.email, at: nowIso_() });
      setBlocked_(list); audit_(c.email, 'admin.block', email, reason);
      return blockedFor_(c, list);
    });
  });
}
function apiAdminUnblock(email) {
  return run_(function () {
    var c = needAdmin_(); email = str_(email, 200).toLowerCase();
    return lock_(function () {
      var all = getConfig_('blocked', []), b = all.filter(function (x) { return x.email === email; })[0];
      if (!b) throw userError_('Tài khoản này hiện không bị chặn.');
      if (!(canManageAccount_(c, email) || b.by === c.email)) throw userError_('Tài khoản này nằm ngoài phạm vi tổ chức của bạn.');
      var list = all.filter(function (x) { return x.email !== email; });
      setBlocked_(list); audit_(c.email, 'admin.unblock', email, '');
      return blockedFor_(c, list);
    });
  });
}