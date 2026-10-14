/**
 * NHẬP TỪ CV CŨ (Word .docx hoặc PDF, kể cả PDF scan).
 *  - .docx: đọc trực tiếp trong Apps Script (giải nén XML), file KHÔNG rời khỏi hệ thống.
 *  - .pdf : đổi sang Google Docs tạm trong Drive của chủ ứng dụng với OCR tiếng Việt (ocrLanguage=vi), lấy chữ rồi XOÁ VĨNH VIỄN bản tạm ngay lập tức.
 *  - Mặc định KHÔNG dùng dịch vụ AI bên ngoài: việc tách mục dùng quy tắc (nhãn, năm, DOI...), mỗi kết quả có mức tin cậy.
 *  - Tuỳ chọn: nếu có AI_API_KEY và người dùng tích đồng ý riêng, ImportAI.gs bổ sung kết quả AI (xem file đó).
 *  - File gốc và văn bản thô không bao giờ được lưu vào Sheet; chỉ trả kết quả tách về trình duyệt để người dùng duyệt.
 *  - Máy chủ KHÔNG ghi vào hồ sơ: người dùng duyệt ở màn hình đối chiếu, bấm áp dụng rồi mới bấm Lưu.
 */
var IMPORT_MAX_BYTES = 8 * 1024 * 1024;
var IMPORT_PER_HOUR = 10;

function apiImportCv(fileName, b64, useAi) {
  return run_(function () {
    var c = ctx_();
    fileName = str_(fileName, 150);
    var m = /\.(docx|pdf)$/i.exec(fileName);
    if (!m) throw userError_('Chỉ hỗ trợ file Word (.docx) hoặc PDF (.pdf). File .doc cũ hãy mở bằng Word và lưu lại thành .docx.');
    var ext = m[1].toLowerCase();
    b64 = String(b64 || '');
    if (!b64 || b64.length > IMPORT_MAX_BYTES * 1.4) throw userError_('File rỗng hoặc lớn hơn 8 MB.');
    var cache = CacheService.getScriptCache(), key = 'imp:' + c.email, n = Number(cache.get(key) || 0);
    if (n >= IMPORT_PER_HOUR) throw userError_('Bạn đã nhập quá ' + IMPORT_PER_HOUR + ' file trong 1 giờ. Vui lòng thử lại sau.');
    cache.put(key, String(n + 1), 3600);
    var bytes = Utilities.base64Decode(b64);
    if (bytes.length > IMPORT_MAX_BYTES) throw userError_('File lớn hơn 8 MB.');
    var head = (bytes[0] & 255) + ',' + (bytes[1] & 255) + ',' + (bytes[2] & 255) + ',' + (bytes[3] & 255);
    if (ext === 'docx' ? head.indexOf('80,75') !== 0 : head !== '37,80,68,70') throw userError_('Nội dung file không đúng định dạng ' + ext.toUpperCase() + '.');
    var blob = Utilities.newBlob(bytes, ext === 'pdf' ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'cv.' + ext);
    var text = ext === 'docx' ? docxText_(blob) : pdfText_(blob);
    if (String(text).replace(/\s+/g, '').length < 40) throw userError_('Không đọc được chữ trong file' + (ext === 'pdf' ? ' (PDF scan quá mờ hoặc trống).' : '.'));
    var res = parseCv_(text);
    if (useAi === true) res = impWithAi_(text, res, c.email);
    res.ext = ext; res.ocr = ext === 'pdf'; res.chars = text.length;
    audit_(c.email, 'import.cv', ext + (res.ai ? '+ai' : ''), 'fields=' + res.fields.length + '; items=' + Object.keys(res.items).map(function (k) { return k + ':' + res.items[k].length; }).join(','));
    return res;
  });
}

function docxText_(blob) {
  var zipBlob = blob.copyBlob().setContentType('application/zip');
  var parts = Utilities.unzip(zipBlob), xml = '';
  for (var i = 0; i < parts.length; i++) {
    if (parts[i].getName() === 'word/document.xml') { xml = parts[i].getDataAsString('UTF-8'); break; }
  }
  if (!xml) throw userError_('File Word không hợp lệ (thiếu word/document.xml).');
  return docxXmlToText_(xml);
}
function docxXmlToText_(xml) {
  return String(xml).replace(/<w:tab\/>/g, '\t').replace(/<w:br[^>]*\/>/g, '\n').replace(/<\/w:p>/g, '\n').replace(/<\/w:tc>/g, '\t').replace(/<\/w:tr>/g, '\n')
    .replace(/<[^>]+>/g, '').replace(/&#(\d+);/g, function (_, d) { return String.fromCharCode(Number(d)); })
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}
function pdfText_(blob) {
  var id = null;
  try {
    var f = Drive.Files.create({ name: 'tmp-import-' + Utilities.getUuid(), mimeType: 'application/vnd.google-apps.document' }, blob, { ocrLanguage: 'vi' });
    id = f.id;
    var res = UrlFetchApp.fetch('https://www.googleapis.com/drive/v3/files/' + id + '/export?mimeType=text%2Fplain', { headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() }, muteHttpExceptions: true });
    if (res.getResponseCode() !== 200) throw userError_('Không đọc được nội dung PDF (mã ' + res.getResponseCode() + ').');
    return res.getContentText('UTF-8');
  } finally {
    if (id) { try { Drive.Files.remove(id); } catch (e) { try { DriveApp.getFileById(id).setTrashed(true); } catch (e2) { console.error('Không xoá được file tạm ' + id + ': ' + e2); } } }
  }
}

/* ===================== TÁCH MỤC (thuần tuý, kiểm thử được) ===================== */
function nrm_(x) { return String(x == null ? '' : x).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[đĐ]/g, 'd').toLowerCase(); }
function impClean_(v) { return String(v == null ? '' : v).replace(/[…_]+/g, ' ').replace(/\.{2,}/g, ' ').replace(/\s+/g, ' ').replace(/^[\s:;,.\-–]+|[\s;,.\-–]+$/g, '').trim(); }
function impTitle_(v) { return v === v.toUpperCase() && v !== v.toLowerCase() ? v.toLowerCase().replace(/(^|\s)(\S)/g, function (m, a, b) { return a + b.toUpperCase(); }) : v; }
function impDate_(v) {
  var m = /(\d{1,2})\s*[\/.\-]\s*(\d{1,2})\s*[\/.\-]\s*((?:19|20)\d{2})/.exec(v) || /(\d{1,2})\s+th[aá]ng\s+(\d{1,2})\s+n[aă]m\s+((?:19|20)\d{2})/i.exec(v);
  return m ? ('0' + m[1]).slice(-2) + '/' + ('0' + m[2]).slice(-2) + '/' + m[3] : '';
}
var IMP_YEAR_G_ = /(?:^|[^\d])((?:19[5-9]|20[0-4])\d)(?!\d)/g;
function impYears_(v) { var out = [], m; IMP_YEAR_G_.lastIndex = 0; while ((m = IMP_YEAR_G_.exec(v))) out.push(m[1]); return out; }

var IMP_LABELS_ = [
  ['basic.fullName', 'ho (?:va|&) ten(?: khai sinh)?'], ['basic.gender', 'gioi tinh'],
  ['basic.dob', '(?:ngay,? ?thang,? ?nam sinh|ngay sinh)'], ['basic.pob', 'noi sinh'], ['basic.hometown', 'que quan'], ['basic.ethnicity', 'dan toc'],
  ['_hvYear', 'nam (?:nhan|cap|duoc phong|tot nghiep) (?:hoc vi|bang)'], ['_hvCountry', 'nuoc (?:nhan|cap) (?:hoc vi|bang)'],
  ['_hvTitleYear', 'nam (?:bo nhiem|cong nhan|phong) (?:chuc danh|hoc ham)'],
  ['_hvDegree', 'hoc vi(?: cao nhat)?'], ['_hvTitle', '(?:chuc danh khoa hoc|hoc ham)(?: cao nhat)?'],
  ['basic.position', 'chuc vu'], ['basic.workplace', '(?:don vi|co quan|noi) cong tac'],
  ['basic.address', '(?:cho o rieng(?: hoac dia chi lien (?:lac|he))?|dia chi lien (?:lac|he)|dia chi)'],
  ['_phone', 'dien thoai(?: lien (?:he|lac))?'], ['basic.fax', 'fax'], ['basic.contactEmail', '(?:e-?mail|thu dien tu)'],
  ['_idNum', '(?:so )?(?:cmnd|cmt|cccd|the can cuoc(?: cong dan)?|can cuoc cong dan|chung minh (?:nhan dan|thu))(?:/(?:cmnd|cccd|cmt))?'],
  ['idDoc.issueDate', 'ngay cap'], ['idDoc.issuePlace', 'noi cap']
];
var IMP_FIELD_LABEL_ = { 'basic.fullName': 'Họ và tên', 'basic.gender': 'Giới tính', 'basic.dob': 'Ngày sinh', 'basic.pob': 'Nơi sinh', 'basic.hometown': 'Quê quán', 'basic.ethnicity': 'Dân tộc',
  'basic.position': 'Chức vụ', 'basic.workplace': 'Đơn vị công tác', 'basic.address': 'Địa chỉ liên lạc', 'basic.phoneCQ': 'Điện thoại cơ quan', 'basic.phoneNR': 'Điện thoại nhà riêng', 'basic.phoneDD': 'Điện thoại di động',
  'basic.fax': 'Fax', 'basic.contactEmail': 'Email liên hệ', 'idDoc.type': 'Loại giấy tờ', 'idDoc.number': 'Số giấy tờ', 'idDoc.issueDate': 'Ngày cấp', 'idDoc.issuePlace': 'Nơi cấp',
  'extra.orcid': 'ORCID', 'extra.scopusId': 'Scopus Author ID', 'extra.scholar': 'Google Scholar' };
var IMP_HEADS_ = [
  ['training', /dao tao|bang cap|trinh do chuyen mon/], ['languages', /ngoai ngu/], ['work', /qua trinh cong tac|kinh nghiem lam viec|qua trinh lam viec/],
  ['projects', /de tai|du an|nhiem vu khoa hoc/], ['pubs', /cong bo|bai bao|san pham khoa hoc|cong trinh khoa hoc|danh muc cong trinh/],
  ['awards', /giai thuong|sang che|bang doc quyen|khen thuong/], ['directions', /huong nghien cuu|linh vuc nghien cuu/]
];
var IMP_COUNTRIES_ = [['viet nam', 'Việt Nam'], ['lien bang nga', 'Nga'], ['nga', 'Nga'], ['phap', 'Pháp'], ['hoa ky', 'Mỹ'], ['usa', 'Mỹ'], ['anh quoc', 'Anh'], ['duc', 'Đức'], ['nhat ban', 'Nhật Bản'],
  ['han quoc', 'Hàn Quốc'], ['trung quoc', 'Trung Quốc'], ['australia', 'Úc'], ['canada', 'Canada'], ['singapore', 'Singapore'], ['thai lan', 'Thái Lan'], ['ba lan', 'Ba Lan'], ['ha lan', 'Hà Lan']];

function impDegree_(norm) {
  if (/tien si|\bts\b|ph\.?d\b|doctor/.test(norm)) return /\bdba\b/.test(norm) ? 'Tiến sĩ (DBA)' : 'Tiến sĩ';
  if (/thac si|\bths\b|master|\bm\.?sc\b/.test(norm)) return 'Thạc sĩ';
  if (/ky su|engineer/.test(norm)) return 'Kỹ sư';
  if (/cu nhan|dai hoc|bachelor|tot nghiep/.test(norm)) return 'Cử nhân';
  return '';
}
function impCountry_(norm) { for (var i = 0; i < IMP_COUNTRIES_.length; i++) if (new RegExp('(?:^|[^a-z])' + IMP_COUNTRIES_[i][0] + '(?:[^a-z]|$)').test(norm)) return IMP_COUNTRIES_[i][1]; return ''; }
function impDegreeItem_(flat, degree) {
  // so khớp trên bản đã bỏ dấu (nrm_ giữ nguyên độ dài với chuỗi NFC) rồi cắt chữ gốc có dấu theo cùng vị trí
  var n = nrm_(flat), ys = impYears_(flat);
  function cut(re, grp) { var m = re.exec(n); if (!m) return ''; var g = m[grp || 1]; return impClean_(flat.substr(m.index + m[0].lastIndexOf(g), g.length)); }
  var inst = cut(/\b(truong [^,;()\t]*)/) || cut(/\b((?:dai hoc|hoc vien|university|institute|vien)[ ]+[^,;()\t]*)/);
  var maj = cut(/(?:chuyen nganh|nganh)\s*:?\s*([^,;()\t]+)/), th = cut(/(?:luan an|luan van|do an)[^:]*:\s*(.+)$/);
  return { id: '', level: /tien si|thac si/.test(nrm_(degree)) ? 'Sau đại học' : 'Đại học', degree: degree, major: maj, institution: inst,
    country: impCountry_(n), year: ys.length ? ys[ys.length - 1] : '', system: '', thesis: th, second: false };
}

function parseCv_(text) {
  text = String(text || '').replace(/\r/g, '').normalize('NFC');
  var rawLines = text.split('\n'), fields = {}, order = [], secLines = { training: [], languages: [], work: [], projects: [], pubs: [], awards: [], directions: [] }, sec = 'basic', hv = {};
  function put(path, val, conf) { val = impClean_(val); if (!val || fields[path]) return; fields[path] = { path: path, label: IMP_FIELD_LABEL_[path] || path, value: val, conf: conf || 'high' }; order.push(path); }

  rawLines.forEach(function (raw) {
    var line = raw.replace(/\t+/g, ' ').replace(/\s+/g, ' ').trim(); if (!line) return;
    var n = nrm_(line), after = line.indexOf(':') >= 0 ? line.slice(line.indexOf(':') + 1).trim() : '';
    // dòng tiêu đề mục: ngắn, không phải "nhãn: giá trị dài", không phải mục dữ liệu có năm
    if (line.length <= 90 && after.length <= 20 && !(impYears_(line).length && line.length > 40)) {
      for (var h = 0; h < IMP_HEADS_.length; h++) if (IMP_HEADS_[h][1].test(n) && !/^(?:\d+[.)]\s*)?(?:ho va ten|dia chi)/.test(n)) { sec = IMP_HEADS_[h][0]; return; }
    }
    if (sec !== 'basic') { secLines[sec].push({ flat: line, raw: raw }); return; }
    // tách các cặp "Nhãn: giá trị" (có thể nhiều cặp trên một dòng)
    var hits = [];
    IMP_LABELS_.forEach(function (L) {
      var re = new RegExp('(?:^|[^a-z0-9])(' + L[1] + ')\\s*(?:\\([^)]*\\))?\\s*:', 'g'), m;
      while ((m = re.exec(n))) hits.push({ key: L[0], start: m.index + m[0].indexOf(m[1]), end: m.index + m[0].length });
    });
    hits.sort(function (a, b) { return a.start - b.start || b.end - a.end; });
    var kept = [], last = -1; hits.forEach(function (x) { if (x.start >= last) { kept.push(x); last = x.end; } });
    kept.forEach(function (x, i) {
      var v = impClean_(line.slice(x.end, i + 1 < kept.length ? kept[i + 1].start : line.length).replace(/\s*\(?\d{1,2}[.)]\s*$/, '')), vn = nrm_(v);
      if (!v || /^(khong|chua co|none|n\/a)$/.test(vn)) return;
      switch (x.key) {
        case 'basic.fullName': put(x.key, impTitle_(v), 'high'); break;
        case 'basic.gender': if (/(^|\W)nu(\W|$)/.test(vn)) put(x.key, 'Nữ'); else if (/(^|\W)nam(\W|$)/.test(vn)) put(x.key, 'Nam'); break;
        case 'basic.dob': case 'idDoc.issueDate': { var d = impDate_(v); if (d) put(x.key, d); else put(x.key, v, 'low'); break; }
        case 'basic.contactEmail': { var em = /[\w.+\-]+@[\w\-]+(?:\.[\w\-]+)+/.exec(v); if (em) put(x.key, em[0].toLowerCase()); break; }
        case '_hvDegree': hv.degree = impDegree_(vn); hv.line = v; var y = impYears_(v); if (y.length) hv.year = y[y.length - 1]; hv.country = hv.country || impCountry_(vn); break;
        case '_hvYear': if (impYears_(v).length) hv.year = impYears_(v)[0]; break;
        case '_hvCountry': hv.country = impClean_(v); break;
        case '_hvTitle': if (/ph[oó] gi[aá]o s[uư]|\bpgs\b/i.test(v) || /pho giao su|\bpgs\b/.test(vn)) hv.title = 'PGS'; else if (/giao su|\bgs\b/.test(vn)) hv.title = 'GS'; { var ty = impYears_(v); if (ty.length) hv.titleYear = ty[0]; } break;
        case '_hvTitleYear': if (impYears_(v).length) hv.titleYear = impYears_(v)[0]; break;
        case '_phone': {
          var pr = /(?:^|[^a-z])(cq|nr|dd|di dong|co quan|nha rieng)\s*:?\s*([\d .\-+()]{7,20})/g, pm, got = 0, vv = nrm_(v);
          while ((pm = pr.exec(vv))) { var num = impClean_(v.substr(pm.index + pm[0].length - pm[2].length, pm[2].length)), k = pm[1]; got++; put(/^(cq|co quan)$/.test(k) ? 'basic.phoneCQ' : /^(nr|nha rieng)$/.test(k) ? 'basic.phoneNR' : 'basic.phoneDD', num); }
          if (!got) { var one = /(?:\+84|0)[\d .\-()]{8,13}/.exec(v); if (one) put(/^(?:\+84|0)\s*[35789]/.test(one[0]) ? 'basic.phoneDD' : 'basic.phoneCQ', one[0], 'medium'); }
          break; }
        case '_idNum': {
          var dg = /\b(\d{12}|\d{9})\b/.exec(v.replace(/[ .]/g, '')); var lab = nrm_(line.slice(x.start, x.end));
          if (dg) { put('idDoc.number', dg[1]); put('idDoc.type', /the can cuoc/.test(lab) ? 'The can cuoc' : (dg[1].length === 12 || /cccd|can cuoc/.test(lab)) ? 'CCCD' : 'CMND'); }
          break; }
        default: put(x.key, v, 'high');
      }
    });
    if (!kept.length && /^(?:\d+[.)]\s*)?(?:ho va ten|ten)\b/.test(n)) { /* nhãn không có dấu ':' */ }
  });

  // các trường nhận diện ở bất kỳ đâu
  var all = text;
  var em = /[\w.+\-]+@[\w\-]+(?:\.[\w\-]+)+/.exec(all); if (em) put('basic.contactEmail', em[0].toLowerCase(), 'medium');
  var or = /\b(\d{4}-\d{4}-\d{4}-\d{3}[\dX])\b/.exec(all); if (or) put('extra.orcid', or[1], 'high');
  var sc = /scopus[^\d]{0,40}(\d{9,12})/i.exec(all); if (sc) put('extra.scopusId', sc[1], 'high');
  var gs = /https?:\/\/scholar\.google\.[a-z.]+\/citations\?[^\s)]+/i.exec(all); if (gs) put('extra.scholar', gs[0], 'high');

  var items = { degrees: [], titles: [], languages: [], work: [], projects: [], pubs: [], awards: [], directions: [] }, skipped = 0;
  function add(sec, item, conf, summary) { items[sec].push({ item: item, conf: conf, summary: summary }); }

  // học vị / học hàm khai ở mục I
  if (hv.degree) { var it0 = impDegreeItem_(hv.line || hv.degree, hv.degree); if (hv.year) it0.year = hv.year; if (hv.country) it0.country = hv.country; add('degrees', it0, hv.year ? 'medium' : 'low'); }
  if (hv.title) add('titles', { id: '', title: hv.title, major: '', year: hv.titleYear || '' }, hv.titleYear ? 'medium' : 'low');

  // đào tạo
  secLines.training.forEach(function (l) {
    var n = nrm_(l.flat), deg = impDegree_(n); if (!deg || l.flat.length < 8 || /ngoai ngu/.test(n)) { if (l.flat.length > 25) skipped++; return; }
    var it = impDegreeItem_(l.raw, deg); add('degrees', it, it.year && it.institution ? 'medium' : 'low');
  });
  // ngoại ngữ
  secLines.languages.forEach(function (l) {
    var n = nrm_(l.flat), lg = /(tieng (?:anh|phap|nga|trung|nhat|han|duc|tay ban nha|y|lao|khmer|thai)|english|french|russian|chinese|japanese|korean|german)/.exec(n); if (!lg) return;
    var NAME = { 'tieng anh': 'Tiếng Anh', english: 'Tiếng Anh', 'tieng phap': 'Tiếng Pháp', french: 'Tiếng Pháp', 'tieng nga': 'Tiếng Nga', russian: 'Tiếng Nga', 'tieng trung': 'Tiếng Trung', chinese: 'Tiếng Trung', 'tieng nhat': 'Tiếng Nhật', japanese: 'Tiếng Nhật', 'tieng han': 'Tiếng Hàn', korean: 'Tiếng Hàn', 'tieng duc': 'Tiếng Đức', german: 'Tiếng Đức', 'tieng tay ban nha': 'Tiếng Tây Ban Nha', 'tieng y': 'Tiếng Ý', 'tieng lao': 'Tiếng Lào', 'tieng khmer': 'Tiếng Khmer', 'tieng thai': 'Tiếng Thái' };
    var lv = /muc do(?: su dung)?\s*:?\s*([^;,]+)/i.exec(l.flat), cef = /\b([ABC][12])\b/.exec(l.flat), cert = /(ielts\s*[\d.]+|toefl[^;,]*|toeic\s*\d+|jlpt\s*n\d|topik\s*\d|hsk\s*\d|dele\s*[abc][12]|delf\s*[abc][12])/i.exec(l.flat);
    add('languages', { id: '', language: NAME[lg[1]] || impClean_(lg[1]), level: cef ? cef[1] : lv ? impClean_(lv[1]) : '', certificate: cert ? impClean_(cert[1]) : '' }, cef || lv || cert ? 'medium' : 'low');
  });
  // công tác
  var PER = /((?:\d{1,2}\s*[\/.]\s*)?(?:19|20)\d{2})\s*(?:-|–|—|đến|tới|den)\s*((?:\d{1,2}\s*[\/.]\s*)?(?:19|20)\d{2}|nay|hiện nay|hien nay|present)/i;
  var ORG = /(truong|vien|khoa|bo mon|phong|trung tam|cong ty|dai hoc|hoc vien|so |ubnd|benh vien|to chuc|nha may|tap doan|ngan hang|bo |hoi )/, POS = /(giang vien(?: chinh| cao cap)?|truong khoa|pho truong khoa|truong bo mon|pho truong bo mon|nghien cuu vien|chuyen vien|can bo|ky su|giam doc|pho giam doc|chu tich|truong phong|pho truong phong|bien tap vien|tro ly|bac si|hieu truong|pho hieu truong|tro giang|chu nhiem)/;
  function ym(s) { var m = /(?:(\d{1,2})\s*[\/.]\s*)?((?:19|20)\d{2})/.exec(s); return m ? (m[1] ? ('0' + m[1]).slice(-2) + '/' + m[2] : m[2]) : ''; }
  secLines.work.forEach(function (l) {
    var m = PER.exec(l.flat); if (!m) { return; }
    var rest = l.raw.replace(PER, '\t'), cells = rest.split(/\t+/).map(impClean_).filter(String), org = '', pos = '', duties = [];
    if (cells.length === 1) { var pm = POS.exec(nrm_(cells[0])); if (pm) { pos = impClean_(cells[0].substr(pm.index, pm[0].length)); org = impClean_(cells[0].replace(cells[0].substr(pm.index, pm[0].length), '')); } else org = cells[0]; }
    else cells.forEach(function (c) { var cn = nrm_(c); if (!org && ORG.test(cn)) org = c; else if (!pos && POS.test(cn)) pos = c; else duties.push(c); });
    if (!org && duties.length) org = duties.shift();
    var cur = /nay|present/i.test(m[2]), from = ym(m[1]), to = cur ? '' : ym(m[2]);
    add('work', { id: '', from: from, to: to, current: cur, org: org, position: pos, duties: duties.join('; ') }, /\//.test(m[1]) && (cur || /\//.test(m[2])) && org ? 'medium' : 'low');
  });
  // đề tài
  var LV = [[/nha nuoc/, 'Nhà nước'], [/(?:cap )?bo\b|bo gd|bo khcn|nafosted/, 'Bộ'], [/nganh/, 'Ngành'], [/tinh|thanh pho|so khcn/, 'Tỉnh/Thành phố'], [/co so|truong/, 'Trường/Cơ sở']], RL = [[/pho chu nhiem/, 'Phó chủ nhiệm'], [/chu nhiem/, 'Chủ nhiệm'], [/thanh vien chinh/, 'Thành viên chính'], [/thanh vien/, 'Thành viên']];
  secLines.projects.forEach(function (l) {
    var cells = l.raw.split(/\t+/).map(impClean_).filter(String), n = nrm_(l.flat);
    if (l.flat.length < 14 || /^(stt|ten de tai|tt)\b/.test(n)) { return; }
    var name = cells.length > 1 ? cells.slice().sort(function (a, b) { return b.length - a.length; })[0] : impClean_(l.flat.replace(/^\s*(?:\d+[.)]\s*)+/, '')), ys = impYears_(l.flat), lv = '', rl = '';
    LV.some(function (p) { if (p[0].test(n)) { lv = p[1]; return true; } }); RL.some(function (p) { if (p[0].test(n)) { rl = p[1]; return true; } });
    var cd = /(?:ma so|ma|so)\s*:?\s*([A-Z0-9][\w.\-\/]{3,})/.exec(l.flat) || /\b([A-Z]{1,4}\d{2,4}[-.\/][\w\-.\/]+)\b/.exec(l.flat);
    add('projects', { id: '', name: name.replace(/^\s*(?:\d+[.)]\s*)+/, ''), startYear: ys.length > 1 ? ys[0] : (ys[0] || ''), endYear: ys.length > 1 ? ys[ys.length - 1] : '', ongoing: /\bnay\b|dang thuc hien/.test(n), level: lv, role: rl, code: cd ? cd[1] : '', result: '', funding: '' }, (ys.length && (lv || rl)) ? 'medium' : 'low');
  });
  // công bố
  secLines.pubs.forEach(function (l) {
    var s = impClean_(l.flat.replace(/^\s*(?:\[?\d+[\].)]\s*)+/, '')), ys = impYears_(s), doi = /10\.\d{4,9}\/[^\s"<>,;]+/.exec(s), q = /[“"](.{12,}?)[”"]/.exec(s), apa = /^(.*?)\(\s*((?:19|20)\d{2})[a-z]?\s*\)\s*[.,]?\s*(.+)$/.exec(s);
    if (s.length < 25 || (!ys.length && !doi)) { if (s.length > 25) skipped++; return; }
    var authors = '', title = '', venue = '', conf = 'low';
    if (q) { title = q[1]; authors = s.slice(0, q.index); venue = s.slice(q.index + q[0].length); conf = 'medium'; }
    else if (apa) { authors = apa[1]; var rest = apa[3].split(/\.\s+/); title = rest[0]; venue = rest.slice(1).join('. '); conf = 'medium'; }
    else { var pt = s.split(/\.\s+(?=[A-ZÀ-Ỵ0-9])/); if (pt.length >= 3) { authors = pt[0]; title = pt[1]; venue = pt.slice(2).join('. '); } else { title = s; } }
    var an = []; authors = impClean_(authors);
    if (authors) { var sur = authors.match(/[^,;]+,\s*(?:[A-ZÀ-Ỵ]\.\s*)+/g); an = authors.indexOf(';') >= 0 ? authors.split(';') : (sur && sur.length > 1 ? sur : authors.split(/,|&| và | and /)); an = an.map(impClean_).filter(function (x) { return x.length > 1 && x.length < 60; }).slice(0, 80); }
    var vol = /(\d+)\s*\((\d+)\)\s*[:,]\s*(\d+\s*[-–]\s*\d+)/.exec(s), pg = /\bpp?\.?\s*(\d+\s*[-–]\s*\d+)/i.exec(s), isbn = /isbn[:\s-]*([\d\- X]{10,17})/i.exec(s), issn = /\b(\d{4}-\d{3}[\dX])\b/.exec(s), sn = nrm_(s);
    var type = /conference|proceedings|symposium|hoi thao|hoi nghi|workshop/.test(sn) ? 'conference' : /nxb|nha xuat ban|isbn|publisher|giao trinh|sach chuyen khao/.test(sn) ? 'book' : 'article';
    add('pubs', { id: '', type: type, title: impClean_(title), authors: an.map(function (nm) { return { name: nm, me: false, main: false, corr: false }; }), venue: impClean_(venue).slice(0, 400),
      volume: vol ? vol[1] : '', issue: vol ? vol[2] : '', pages: vol ? vol[3].replace(/\s/g, '') : (pg ? pg[1].replace(/\s/g, '') : ''), year: apa ? apa[2] : (ys.length ? ys[ys.length - 1] : ''), doi: doi ? doi[0].replace(/[.)]+$/, '') : '',
      issn: issn ? issn[1] : '', isbn: isbn ? impClean_(isbn[1]) : '', publisher: '', bookRole: '', registrationNo: '', indexClass: /scopus|\bisi\b|\bwos\b|\bscie?\b|\bssci\b/.test(sn) ? 'isi_scopus' : '', keywords: [], verified: false, source: 'manual' },
      doi ? 'medium' : conf);
  });
  // giải thưởng, sáng chế
  secLines.awards.forEach(function (l) {
    var s = impClean_(l.flat.replace(/^\s*(?:\d+[.)]\s*)+/, '')), ys = impYears_(s), n = nrm_(s); if (s.length < 12 || !ys.length) { if (s.length > 25) skipped++; return; }
    add('awards', { id: '', kind: /bang (?:doc quyen )?sang che|giai phap huu ich|sang che/.test(n) ? 'sang_che' : 'giai_thuong', name: s.replace(/\s*[(\[]?(?:19|20)\d{2}[)\]]?\s*$/, ''), issuer: '', year: ys[ys.length - 1], content: '' }, 'low');
  });
  // hướng nghiên cứu
  secLines.directions.forEach(function (l) { var s = impClean_(l.flat.replace(/^\s*(?:[-•*•]|\d+[.)])\s*/, '')); if (s.length >= 4 && s.length < 200) add('directions', { id: '', name: s, keywords: '' }, 'low'); });

  // loại trùng trong chính file; khi trùng giữ bản đầy đủ hơn (vd. học vị khai ở mục I và dòng chi tiết ở mục đào tạo)
  function filled(o) { return Object.keys(o).filter(function (k) { var v = o[k]; return Array.isArray(v) ? v.length : v; }).length; }
  Object.keys(items).forEach(function (k) {
    var seen = {}, out = [];
    items[k].forEach(function (x) {
      var key = nrm_(x.item.title || x.item.name || x.item.language || (k === 'degrees' ? x.item.degree + (x.item.year || '') : '') || (x.item.from + x.item.org)); if (!key) return;
      if (seen[key] == null) { seen[key] = out.length; out.push(x); }
      else if (filled(x.item) > filled(out[seen[key]].item)) out[seen[key]] = x;
    });
    items[k] = out;
  });
  return { fields: order.map(function (p) { return fields[p]; }), items: items, skipped: skipped };
}