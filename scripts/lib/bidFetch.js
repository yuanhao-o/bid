'use strict';
/**
 * bidFetch —— 来源台账采集 / 抽字段 / 关键信息摘要 / 去重入库（普通云函数 / Node.js 20 / index.main）
 *
 * 触发：定时触发器 bidFetchTimer（每日 09:00 / 17:00），或控制台「测试」手动触发。
 *
 * ★ 采集词与推送词已解耦（2026-11-08 晚改造）：
 *   bid_subscriptions.collectKeywords  → 本函数用的「采集宽词」，决定列表里哪些条目进入候选；
 *                                        留空 / 不配 = 不做前置过滤，抓全部，保证查询页覆盖不被订阅词收窄。
 *   bid_subscriptions.keywords         → bidNotify 专用的「推送严格词」，只决定企微群推什么。
 *   两者互不影响：把推送词改成「装饰/装修/维修/改造/改扩建」，前端仍能浏览全部公告。
 *
 * ★ 摘要改造：不再截正文前 N 字（会带出「当前的位置：首页 > …」「【字体 大中小】」和 GUID）。
 *   makeSummary() 先清噪声，再抽取「招标人 / 建设规模 / 招标范围 / 标段 / 投标截止 / 预算 /
 *   评标办法」等结构化字段，或按关键词加权挑出 1–2 句正文要点，组合成一条可复述的摘要。
 *
 * ★ 维护模式：{"refreshSummaries":true} 用库中已存的 snapshotText 重算全部摘要（不联网）；
 *   加 "fetchMissing":true 可对「只有标题、没有正文」的记录重新抓一次公开详情页补齐。
 *
 * 环境变量：无。凭据一律不进代码。
 *
 * 0 元套餐：超时固定 3 秒 / 内存 256 MB。BUDGET=2400ms，列表详情并行抓取、批量查重、并行入库。
 */
/* ---------------- 数据库 SDK ---------------- */
let app, db, SDK_KIND = 'tcb';
try {
  const tcb = require('@cloudbase/node-sdk');
  try { app = tcb.init({ env: tcb.SYMBOL_CURRENT_ENV }); } catch (e) { app = tcb.init(); }
  db = app.database();
} catch (e1) {
  try {
    const cloud = require('wx-server-sdk');
    cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
    app = cloud; db = cloud.database(); SDK_KIND = 'wx';
  } catch (e2) {
    throw new Error('缺少数据库 SDK：请在本函数目录 package.json 的 dependencies 中加入 "@cloudbase/node-sdk" 后重新部署');
  }
}
const C = (name) => db.collection(name);
const addDoc = (name, data) => SDK_KIND === 'wx' ? C(name).add({ data: data }) : C(name).add(data);
const setDoc = (name, id, data) => SDK_KIND === 'wx' ? C(name).doc(id).update({ data: data }) : C(name).doc(id).update(data);

const BUDGET = 2400;      // 总时间预算 ms，留 600ms 给收尾与调用 bidNotify
const MAX_LIST = 19;      // 单源列表页最多解析多少条（湖北实测 19 条/页，原 12 会漏掉页尾 7 条）
const MAX_BACKFILL = 20;  // 回溯模式单轮最多入库多少条（只写列表字段、不抓详情，3 秒内可完成）
const MAX_DETAIL = 6;     // 单轮并行抓几条详情（轮转游标，见步骤 2）
const MAX_INSERT = 6;     // 单轮最多入库多少条
const SUMMARY_VERSION = 2;

/* ---------------- 工具 ---------------- */
const crypto = require('crypto');
function md5(s) { return crypto.createHash('md5').update(String(s || '')).digest('hex'); }
function sha(s) { return crypto.createHash('sha256').update(String(s || '')).digest('hex'); }
function shortId() { return crypto.randomBytes(8).toString('hex'); }
function shanghai(d) {
  const p = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(d);
  const g = function (t) { const x = p.find(function (i) { return i.type === t; }); return x ? x.value : ''; };
  return g('year') + '-' + g('month') + '-' + g('day') + ' ' + g('hour') + ':' + g('minute');
}
function nowStr() { return shanghai(new Date()); }
function stripTags(s) {
  return String(s || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&#\d+;/g, ' ');
}
function compact(s, max) { return stripTags(s).replace(/\s+/g, ' ').trim().slice(0, max || 2000); }

/* ---------------- 标题清洗：去栏目前缀 / 去重复段 / 去状态后缀 ---------------- */
const TITLE_PREFIX = /^【(?:湖北省中心|分散采购备案单|快速采购|单一来源|货物|工程|服务)】\s*/;
const TITLE_STATUS = /\s*[\[【](?:文件获取中|已结束|报名中|进行中|已截止|已开标|待开标|中标公示中)[\]】]\s*$/;
function cleanTitle(raw) {
  const origin = String(raw || '').replace(/\s+/g, ' ').trim();
  let s = origin.replace(TITLE_PREFIX, '').replace(TITLE_STATUS, '').trim();
  /* 源站把「项目名」拼了两遍：找最长的「前缀自我重复」并删掉一份 */
  for (let i = Math.floor(s.length / 2); i >= 10; i--) {
    const a = s.slice(0, i);
    if (s.slice(i, i + i) === a) { s = a + s.slice(2 * i); break; }
  }
  return s.trim() || origin;
}

/* ---------------- 招标单位抽取：只认机构名，宁缺毋滥 ---------------- */
const ORG_TAIL = ['股份有限公司', '有限责任公司', '有限公司', '集团有限公司', '管理委员会', '研究院', '研究所',
  '管理处', '管理局', '指挥部', '办公室', '委员会', '大学', '学院', '医院', '学校', '集团', '公司',
  '中心', '银行', '局', '厅', '院', '站', '厂', '所'];
const ORG_CHARS = '[^\\s，。；：、|]';
const ORG_BAD_START = /^(提出|已经|已|根据|本次|本项目|本工程|该|中标|详见|见|按照|经|如|若|凡|请|对|在|为|于)/;
const ORG_BAD_WORD = /(已经|确认|公告|提出|如下|详见|应当|可以|不得|负责|有关|相关)/;

function cutOrg(s) {
  const v = String(s || '').trim();
  if (!v) return '';
  const cands = [];
  for (const t of ORG_TAIL) {
    const i = v.indexOf(t);
    if (i > 0) cands.push({ end: i + t.length, t: t });
  }
  cands.sort((a, b) => b.end - a.end || b.t.length - a.t.length);
  for (const c of cands) {
    const out = v.slice(0, c.end);
    if (isValidOrg(out)) return out;
  }
  return '';
}
function isValidOrg(v) {
  const s = String(v || '').trim();
  if (s.length < 4 || s.length > 40) return false;
  if (/[，。；：、|]/.test(s)) return false;
  if (ORG_BAD_START.test(s) || ORG_BAD_WORD.test(s)) return false;
  const core = s.replace(/（[^）]{1,10}）$/, '');
  return ORG_TAIL.some((t) => core.endsWith(t));
}
const RX_ORG = [
  new RegExp('(?:招标人|采购人|招标单位|采购单位|建设单位|项目业主)\\s*[:：]\\s*(' + ORG_CHARS + '{4,40})', 'g'),
  new RegExp('(?:招标人|采购人|招标单位|采购单位|建设单位)\\s*为\\s*(' + ORG_CHARS + '{4,40})', 'g'),
  new RegExp('根据[^。]{0,60}?，\\s*(' + ORG_CHARS + '{4,40}?)\\s*(?:已经|已)(?:确认|完成|依法)', 'g')
];
function findOrg(text) {
  const src = String(text || '');
  for (const rx of RX_ORG) {
    rx.lastIndex = 0;
    let m;
    while ((m = rx.exec(src))) {
      const v = cutOrg(m[1]);
      if (isValidOrg(v)) return v;
      if (rx.lastIndex === m.index) rx.lastIndex++;
    }
  }
  return '';
}
function scrubSummary(s) {
  let t = String(s || '');
  t = t.replace(/招标单位：([^；]*)(；|$)/g, (all, val) => (isValidOrg(String(val).trim()) ? all : ''));
  return t.replace(/^；+|；+$/g, '').replace(/；{2,}/g, '；').trim();
}

function absoluteUrl(u, base) { try { return new URL(u, base || undefined).toString(); } catch (e) { return String(u || '').trim(); } }
function normalizeUrl(u, base) {
  try {
    const x = new URL(u, base || undefined);
    // SPA 的 hash 路由（#/cmsIndex?id=xxx）携带记录标识，必须保留；
    // 若一律清空，同一站点所有公告会被规范化成同一个 URL，唯一索引会把它们全判为重复。
    if (!/[?=]/.test(x.hash)) x.hash = '';
    ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'from', 'spm', '_t', 't', 'timestamp']
      .forEach(function (k) { x.searchParams.delete(k); });
    x.pathname = x.pathname.replace(/\/+$/, '') || '/';
    return x.protocol.toLowerCase() + '//' + x.host.toLowerCase() + x.pathname + (x.search ? x.search : '') + x.hash;
  } catch (e) { return String(u || '').trim(); }
}
/* 静态列表站的分页规律：/dir/aboutccgs.html 的第 2 页通常是 /dir/2.html。
   有了它，来源不必额外配置 pageUrl，回溯也能翻页；返回空串表示无法推断。 */
function inferPageUrl(listUrl) {
  const u = String(listUrl || '').split('#')[0].split('?')[0];
  const i = u.lastIndexOf('/');
  if (i < 0) return '';
  const tail = u.slice(i + 1);
  if (!/\.html?$/i.test(tail) || /^\d+\.html?$/i.test(tail)) return '';
  return u.slice(0, i + 1) + '{page}.html';
}
function withTimeout(p, ms, fallback) {
  return Promise.race([
    Promise.resolve(p).catch(function () { return fallback; }),
    new Promise(function (r) { setTimeout(function () { r(fallback); }, ms); })
  ]);
}
async function httpGet(url, ms) {
  const ctl = new AbortController();
  const timer = setTimeout(function () { ctl.abort(); }, ms);
  try {
    const r = await fetch(url, {
      signal: ctl.signal, redirect: 'follow',
      headers: {
        'User-Agent': 'BidNoticeBot/1.0 (public-notice-index; contact via query page)',
        'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8'
      }
    });
    if (!r.ok) return { ok: false, status: r.status, text: '', error: 'HTTP ' + r.status };
    const buf = Buffer.from(await r.arrayBuffer());
    let text = buf.toString('utf8');
    try {
      const m = text.slice(0, 3000).match(/charset\s*=\s*["']?([\w-]+)/i);
      if (m && /gbk|gb2312|gb18030/i.test(m[1])) text = new TextDecoder('gbk').decode(buf);
    } catch (e) { /* 保持 utf8 解码结果 */ }
    return { ok: true, status: r.status, text: text };
  } catch (e) {
    return { ok: false, status: 0, text: '', error: String(e.message || e) };
  } finally { clearTimeout(timer); }
}

/* ---------------- 摘要：清洗噪声 + 整合关键信息 ---------------- */
const NOISE_RULES = [
  /当前的位置\s*[:：]?[\s\S]{0,220}?(?=(?:【?\s*字体|\[\s*字体|发布时间|第一章|一、|1[.、]|项目概况))/g,
  /【?\s*字体\s*[:：]?\s*大\s*中\s*小\s*】?/g,
  /\[文件获取中\]|\[\s*打印\s*\]|\[\s*关闭\s*\]/g,
  /-{2,}>?|--&gt;|&gt;|&lt;|&nbsp;/g,
  /\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b/gi,
  /\b[0-9a-f]{24,}\b/gi,
  /浏览\s*[:：]?\s*\d*\s*次/g,
  /打印本页|关闭窗口|返回顶部|网站首页|设为首页|加入收藏|友情链接|网站地图/g
];
function cleanText(s) {
  let t = String(s || '');
  NOISE_RULES.forEach(function (re) { t = t.replace(re, ' '); });
  return t.replace(/[\uFEFF\u200B]/g, ' ').replace(/\s+/g, ' ').trim();
}
/* 结构化字段：标签 + 取值。顺序即优先级，靠前的先进入摘要。 */
const FIELD_RULES = [
  ['招标单位', /(?:招标人|采购人|招标单位|建设单位|采购单位)\s*(?:为|是|[:：])?\s*([^，,。;；\s]{2,30})/],
  ['招标范围', /招标范围\s*[:：]\s*([^。；;]{4,140})/],
  ['建设规模', /建设规模\s*[:：]\s*([^。；;]{4,120})/],
  ['投标截止', /(?:投标文件递交截止时间|投标截止时间|递交截止时间)\s*(?:为)?\s*[:：]?\s*([0-9]{4}\s*年[^，,。;；]{0,30}|[0-9]{4}-[0-9]{1,2}-[0-9]{1,2}[^，,。;；]{0,20})/],
  ['预算投资', /(?:招标控制价|最高投标限价|最高限价|预算金额|项目预算|总投资|投资额)\s*(?:为|约)?\s*[:：]?\s*([0-9.,]+\s*(?:万元|亿元|元))/],
  ['标段', /(?:标段划分|本标段为)\s*[:：]?\s*([^。；;]{2,60})/],
  ['建设地点', /建设地点\s*[:：]\s*([^，,。;；]{2,40})/],
  ['评标办法', /评标办法\s*(?:采用)?\s*[:：]?\s*([^。；;]{2,40})/],
  ['代理机构', /招标代理机构\s*(?:为|是|[:：])?\s*([^，,。;；\s]{2,30})/],
  ['交货地点', /交货地点\s*[:：]\s*([^，,。;；]{2,40})/]
];
/* JSON 源把接口字段压成 "key: value | key: value" 存进 snapshotText，走这张映射表 */
const KV_FIELDS = [
  ['项目', 'tenderPrjName'], ['招标单位', 'prjbuildCorpName'], ['公告时间', 'noticeStartDate'],
  ['截止时间', 'noticeEndDate'], ['投资额', 'totalInvestment'], ['评标办法', 'evaluationMethodName'],
  ['来源', 'platformDataSourceName'], ['公告编号', 'id'], ['项目编号', 'registrationId']
];
function parseKv(t) {
  const o = {};
  if (t.split('|').length < 3) return o;
  t.split('|').forEach(function (seg) {
    const i = seg.indexOf(':');
    if (i > 0) {
      const k = seg.slice(0, i).trim(), v = seg.slice(i + 1).trim();
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) && v) o[k] = v;
    }
  });
  return o;
}
const SENT_RULES = [
  [/招标范围|采购范围|项目概况|建设规模|采购需求|主要内容|工作内容|设备采购|施工内容/, 6],
  [/招标控制价|最高投标限价|最高限价|预算|投资|万元|亿元|金额/, 5],
  [/投标截止|递交截止|开标时间|报名截止|工期|服务期|交付时间|交货期/, 5],
  [/资格要求|资质|业绩|联合体|不接受|标段划分|评标办法|建设地点|交货地点/, 3],
  [/招标人|招标代理机构|采购人|项目编号|备案/, 2]
];
function clipSentence(s, n) { return s.length > n ? s.slice(0, n) + '…' : s; }
function keySentences(t, title, covered) {
  const scored = [];
  t.split(/[。；;！？!?\n]/).forEach(function (raw) {
    // 去掉「2.项目概况与招标范围 2.1」这类章节编号前缀，别让它混进摘要
    let s = raw.replace(/^\s*\d+(?:[.、]\d+)*\s*[.、]?\s*/, '').trim();
    if (s.length < 12 || s.length > 260) return;
    if (/当前的位置|字体|版权所有|ICP备|免责声明|网站地图|友情链接|注册登记指南|客服电话/.test(s)) return;
    if (title && (s.indexOf(title) >= 0 || title.indexOf(s) >= 0)) return;
    // 已抽成结构化字段的内容不要再用整句重复一遍
    if ((covered || []).some(function (label) { return s.indexOf(label) >= 0; })) return;
    let score = 0;
    SENT_RULES.forEach(function (r) { if (r[0].test(s)) score += r[1]; });
    if (score >= 5) scored.push({ s: s, score: score });
  });
  scored.sort(function (a, b) { return b.score - a.score; });
  const picked = [], seen = {};
  for (let i = 0; i < scored.length && picked.length < 2; i++) {
    const k = scored[i].s.replace(/[\s\d.,，。]/g, '').slice(0, 30);
    if (seen[k]) continue;
    seen[k] = 1; picked.push(clipSentence(scored[i].s, 100));
  }
  return picked;
}
/**
 * 生成「关键信息整合型」摘要：字段优先，其次正文要点句，最后结构化标题兜底。
 * 绝不再直接返回正文前缀（面包屑 / 字体控件 / 页面 GUID 会在 cleanText 里被清掉）。
 */
function makeSummary(meta, body) {
  const raw = cleanText(body || '');
  const kv = parseKv(raw);
  const isKv = Object.keys(kv).length > 0;
  const fields = [], seen = {};
  function add(label, val) {
    val = String(val || '').replace(/\s+/g, ' ').trim()
      // 详情正文常把下一节编号连在一起：「…09时00分 5.2 投标人应当…」
      .replace(/\s+\d+(?:\.\d+)+\s[\s\S]*$/, '').trim();
    if (!val || val === '—' || val.length < 2 || seen[label]) return;
    // 「项目：xxx」与标题完全重复时不要重复占一行
    if (label === '项目' && meta.title && (val === meta.title || String(meta.title).indexOf(val) >= 0)) return;
    const cap = (label === '招标范围' || label === '建设规模') ? 90 : 55;
    seen[label] = 1; fields.push(label + '：' + clipSentence(val, cap));
  }
  if (isKv) {
    // KV 已含「公告时间」，不再加 meta 的「发布」，避免同一时间出现两次
    KV_FIELDS.forEach(function (f) {
      if (kv[f[1]]) add(f[0], kv[f[1]] + (f[0] === '投资额' ? ' 万元' : ''));
    });
    if (!seen['招标单位'] && meta.tenderer && meta.tenderer !== '—') add('招标单位', meta.tenderer);
  } else {
    if (meta.tenderer && meta.tenderer !== '—') add('招标单位', meta.tenderer);
    FIELD_RULES.forEach(function (r) { const m = raw.match(r[1]); if (m) add(r[0], m[1]); });
  }
  const covered = fields.map(function (f) { return f.split('：')[0]; });
  const sents = isKv ? [] : keySentences(raw, meta.title, covered);
  // 按字段整体装入，不在字段中间硬截断（否则会出现「建设地点：湖」这种半截词）
  const parts = [];
  for (let i = 0; i < fields.length && parts.length < 6; i++) {
    if (parts.length && parts.concat([fields[i]]).join('；').length > 200) break;
    parts.push(fields[i]);
  }
  let s = parts.join('；');
  if (parts.length <= 2 && sents.length) s += (s ? '。' : '') + sents[0];
  if (fields.length < 2 && !sents.length) {
    // 无正文 / 字段不足时补结构化标题行；发布时间由列表与筛选栏负责，摘要里不再重复
    const lead = (meta.noticeType ? '【' + meta.noticeType + '】' : '') + String(meta.title || '').trim();
    s = [lead, meta.region ? '地区：' + meta.region : '', meta.source ? '来源：' + meta.source : '',
         s, '正文要点待补，以原文为准'].filter(Boolean).join(' · ');
  }
  return s.replace(/\s+/g, ' ').trim().slice(0, 220);
}

/* ---------------- 列表解析（尽力而为，源站结构请用 listPattern 覆写） ---------------- */
function parseList(html, src) {
  let re;
  try {
    re = src.listPattern
      ? new RegExp(src.listPattern, 'gi')
      : /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]{4,140}?)<\/a>/gi;
  } catch (e) { return []; }
  const base = src.baseUrl || src.listUrl || '';
  const seen = {}, out = [];
  let m, guard = 0;
  while ((m = re.exec(html)) !== null && guard++ < 600) {
    const href = (m[1] || '').trim();
    const tm = (m[0] || '').match(/title\s*=\s*["']([^"']+)["']/i);
    const title = compact(tm ? tm[1] : (m[2] || ''), 140);
    if (!href || /^(javascript:|#|mailto:|tel:)/i.test(href)) continue;
    if (title.length < 6) continue;
    const url = absoluteUrl(href, base);
    if (!/^https?:\/\//i.test(url) || seen[url]) continue;
    seen[url] = 1;
    const after = compact(html.slice(m.index + (m[0] || '').length, m.index + (m[0] || '').length + 400), 400);
    const dm = after.match(/20\d{2}[-/年]\d{1,2}[-/月]\d{1,2}/);
    out.push({
      title: title, url: url,
      publishTime: dm ? dm[0].replace(/[年月]/g, '-').replace(/日/g, '') : ''
    });
    if (out.length >= MAX_LIST) break;
  }
  return out;
}

/* ---------------- JSON 接口型来源（SPA 站点没有可抓的静态列表 HTML） ---------------- */
function pickPath(obj, path) {
  return String(path || 'data.records').split('.').reduce(function (o, k) {
    return o && o[k] !== undefined ? o[k] : undefined;
  }, obj);
}
function renderTemplate(tpl, row) {
  return String(tpl || '').replace(/\{([A-Za-z0-9_]+)\}/g, function (all, k) {
    return row[k] === undefined || row[k] === null ? '' : encodeURIComponent(String(row[k]));
  });
}
async function fetchJsonSource(src, ms) {
  const ctl = new AbortController();
  const timer = setTimeout(function () { ctl.abort(); }, ms);
  try {
    const isPost = String(src.method || 'POST').toUpperCase() === 'POST';
    const opts = {
      method: isPost ? 'POST' : 'GET', signal: ctl.signal,
      headers: {
        'User-Agent': 'BidNoticeBot/1.0 (public-notice-index; contact via query page)',
        'Accept': 'application/json, text/plain, */*',
        'Content-Type': 'application/json;charset=UTF-8'
      }
    };
    if (isPost) opts.body = typeof src.apiBody === 'string' ? src.apiBody : JSON.stringify(src.apiBody || { current: 1, size: 12 });
    const r = await fetch(src.listUrl, opts);
    if (!r.ok) return { ok: false, status: r.status, error: 'HTTP ' + r.status };
    const j = JSON.parse(await r.text());
    const rows = pickPath(j, src.recordsPath || 'data.records');
    if (!Array.isArray(rows)) return { ok: false, status: r.status, error: 'recordsPath 未取到数组' };

    const fm = src.fieldMap || {};
    const listCap = Math.max(1, Math.min(400, parseInt(src.maxList, 10) || MAX_LIST));
    const items = rows.slice(0, listCap).map(function (row) {
      const it = {
        title: row[fm.title || 'tenderPrjName'] || row.title || '',
        tenderer: row[fm.tenderer || 'prjbuildCorpName'] || '',
        publishTime: String(row[fm.publishTime || 'noticeStartDate'] || '').slice(0, 16),
        source: row[fm.source || 'platformDataSourceName'] || src.code || '',
        region: row[fm.region || 'region'] || '',
        industry: row[fm.industry || 'industry'] || '',
        noticeType: row[fm.noticeType || 'noticeType'] || src.noticeType || '',
        // urlField：行内本身就是完整链接（外部抓取器汇总文件用），不做编码
        url: (src.urlField && row[src.urlField]) ? String(row[src.urlField]) : renderTemplate(src.detailUrl || '', row)
      };
      if (!it.url) return null;
      // 外部抓取器已给出正文快照 / 摘要时直接用，避免被「key: value」拼串覆盖
      const givenSnap = (fm.snapshotText && row[fm.snapshotText]) || row.snapshotText;
      const givenSum = (fm.summary && row[fm.summary]) || row.summary;
      if (givenSnap) {
        it.snapshotText = compact(String(givenSnap), 3200);
      } else {
        // JSON 源无「页面正文」可抓：用接口返回的结构化字段生成压缩存证文本，跳过详情 HTTP 抓取
        it.snapshotText = compact(
          Object.keys(row).filter(function (k) {
            return row[k] !== null && row[k] !== '' && typeof row[k] !== 'object';
          }).map(function (k) { return k + ': ' + String(row[k]).slice(0, 120); }).join(' | '),
          3200
        );
      }
      it.summary = givenSum ? String(givenSum).slice(0, 220) : makeSummary(it, it.snapshotText);
      return it;
    }).filter(Boolean);
    return { ok: true, status: r.status, items: items, total: (j.data && j.data.total) || items.length };
  } catch (e) {
    return { ok: false, status: 0, error: String(e.message || e) };
  } finally { clearTimeout(timer); }
}

/* ---------------- 组文档 / 命中订阅 ---------------- */
function hitSubs(doc, subs) {
  const ids = [];
  (subs || []).forEach(function (s) {
    const kws = (Array.isArray(s.keywords) ? s.keywords : []).map(String).filter(Boolean);
    const hay = [doc.title, doc.summary, doc.tenderer, doc.region, doc.industry].join(' ').toLowerCase();
    if (kws.length && !kws.some(function (k) { return hay.indexOf(k.toLowerCase()) >= 0; })) return;
    if (s.region && doc.region !== s.region) return;
    if (s.industry && doc.industry !== s.industry) return;
    ids.push(s._id || s.id || s.name || '');
  });
  return ids;
}
function buildDoc(it, subs, opts) {
  const src = it._source || {};
  const url = String(it.url || '').trim();
  const rawTitle = compact(it.title || '', 140) || '（无标题）';
  const title = cleanTitle(rawTitle);
  const pub = String(it.publishTime || nowStr()).replace('T', ' ').slice(0, 16);
  const noticeType = String(it.noticeType || src.noticeType || '招标公告');
  const region = String(it.region || src.region || '');
  const industry = String(it.industry || src.industry || '');
  const source = String(it.source || src.code || 'manual');
  const snap = compact(it.snapshotText || it.summary || '', 3200);
  /* 招标单位：只认机构名，抽不到就留空，绝不把正文句子当单位 */
  let tenderer = compact(it.tenderer || '', 60);
  if (!isValidOrg(tenderer)) tenderer = findOrg(snap);
  const meta = {
    title: title, tenderer: tenderer || '—', publishTime: pub, noticeType: noticeType,
    region: region, industry: industry, source: source
  };
  const doc = {
    id: shortId(),
    title: title,
    titleRaw: title !== rawTitle ? rawTitle : '',
    url: url,
    source: source,
    tenderer: tenderer || '—',
    publishTime: pub, collectTime: nowStr(),
    summary: scrubSummary(it._keepSummary && it.summary ? compact(it.summary, 220) : makeSummary(meta, snap)),
    summaryVersion: SUMMARY_VERSION,
    region: region, industry: industry, noticeType: noticeType,
    status: String(it.status || '有效'),
    normalizedUrl: String(it.normalizedUrl || normalizeUrl(url, src.baseUrl || src.listUrl)),
    fingerprint: md5([title, tenderer, pub].join('|')),
    pageHash: String(it.pageHash || (snap ? sha(snap).slice(0, 16) : '')),
    snapshotText: snap,
    httpStatus: it.httpStatus || 200,
    hitSubIds: [],
    pushPending: !(opts && opts.noPush)
  };
  doc.hitSubIds = hitSubs(doc, subs);
  return doc;
}

/* ---------------- 维护模式：重算已有公告摘要 ---------------- */
async function refreshSummaries(ev, started, out) {
  out.mode = 'refresh';
  const limit = Math.max(1, Math.min(30, parseInt(ev.limit, 10) || 20));
  let rows = [];
  try {
    const r = await C('bid_notices').where({ status: '有效' }).orderBy('publishTime', 'desc').limit(limit).get();
    rows = r.data || [];
  } catch (e) { out.errors.push('bid_notices 读取失败：' + String(e.message || e)); return out; }
  out.checked = rows.length;

  // 只有标题、没有正文的记录：可选重新抓一次公开详情页补齐（SPA hash 页面抓不到，跳过）
  if (ev.fetchMissing !== false) {
    const thin = rows.filter(function (d) { return String(d.snapshotText || '').length < 200; });
    const batch = thin.slice(0, Math.max(0, Math.min(6, parseInt(ev.fetchLimit, 10) || 6)));
    await Promise.all(batch.map(async function (d) {
      const u = String(d.url || '');
      if (!/^https?:\/\//i.test(u) || /\/whebd\/#\//.test(u)) return;
      const r = await httpGet(u, 900);
      if (!r.ok) return;
      d._newSnap = compact(compact(r.text, 5000), 3200);
      out.fetched = (out.fetched || 0) + 1;
    }));
  }

  await Promise.all(rows.map(async function (d) {
    const snap = compact(d._newSnap || d.snapshotText || d.summary || '', 3200);
    const s = makeSummary({
      title: d.title, tenderer: d.tenderer, publishTime: d.publishTime,
      noticeType: d.noticeType, region: d.region, industry: d.industry, source: d.source
    }, snap);
    const patch = { summary: s, summaryVersion: SUMMARY_VERSION };
    if (d._newSnap) { patch.snapshotText = d._newSnap; patch.pageHash = sha(d._newSnap).slice(0, 16); }
    if (s === d.summary && !d._newSnap && d.summaryVersion === SUMMARY_VERSION) return;
    try { await setDoc('bid_notices', d._id || d.id, patch); out.refreshed = (out.refreshed || 0) + 1; }
    catch (e) { out.errors.push('摘要回写失败：' + String(e.message || e)); }
  }));
  out.ms = Date.now() - started;
  return out;
}

/* ---------------- 主函数 ---------------- */
exports.main = async function (event, context) {
  const ev = event || {}, started = Date.now();
  const out = {
    fn: 'bidFetch', at: nowStr(), mode: '', sources: [], listed: 0, filtered: 0,
    inserted: 0, skipped: 0, errors: [], notified: null, ms: 0
  };
  if (ev.refreshSummaries === true || ev.mode === 'refresh') return refreshSummaries(ev, started, out);

  /* 1. 读订阅规则：只用 collectKeywords 做采集前置过滤，keywords 归 bidNotify 专用 */
  let subs = [];
  try {
    const r = await C('bid_subscriptions').where({ enabled: true }).limit(20).get();
    subs = r.data || [];
  } catch (e) { out.errors.push('订阅读取失败：' + String(e.message || e)); }

  /* 2. 取候选条目：回溯 / 手动注入 / 台账采集 */
  let items = [];
  const backfill = (ev.backfill === true || ev.mode === 'backfill');
  if (backfill) {
    /* 回溯：按页翻历史列表，只写标题/链接/日期，不抓详情、不推送。
       参数 {"backfill":true,"page":3,"code":"hbbidcloud"}；省略 page 时读 bid_sources.backfillPage 自增，
       以便在控制台反复点「运行测试」连续翻页。 */
    out.mode = 'backfill';
    let src = null;
    try {
      const r = await C('bid_sources').where({ enabled: true }).limit(10).get();
      const arr = (r.data || []).filter(function (s) {
        return s.listUrl && String(s.mode || 'html').toLowerCase() !== 'json';
      });
      const want = String(ev.code || 'hbbidcloud');
      src = arr.filter(function (s) { return String(s.code || '') === want; })[0] || arr[0] || null;
    } catch (e) { out.errors.push('bid_sources 读取失败：' + String(e.message || e)); }
    if (!src) {
      out.errors.push('无可回溯的 HTML 来源');
    } else {
      const pageCount = Math.max(1, parseInt(src.pageCount, 10) || 200);
      const page = Math.min(pageCount, Math.max(1, parseInt(ev.page, 10) || parseInt(src.backfillPage, 10) || 1));
      const pageTpl = String(src.pageUrl || inferPageUrl(src.listUrl));
      const pageUrl = page <= 1 ? String(src.listUrl) : pageTpl.replace(/\{page\}/g, String(page));
      out.page = page; out.pageCount = pageCount; out.pageUrl = pageUrl;
      if (page > 1 && !pageTpl) {
        out.errors.push('来源未配置 pageUrl，且无法从 listUrl 推断分页规则，只能抓第 1 页');
      } else {
        /* 只回溯最近 N 天（默认 60 天）：整页都早于截止日即视为完成，不再往前翻 */
        const sinceDays = Math.max(1, parseInt(ev.sinceDays, 10) || 60);
        const sinceStr = shanghai(new Date(Date.now() - sinceDays * 86400000)).slice(0, 10);
        const resp = await httpGet(pageUrl, 1500);
        const list = resp.ok ? parseList(resp.text, src) : [];
        const inRange = list.filter(function (it) {
          const d = String(it.publishTime || '').slice(0, 10);
          return !d || d >= sinceStr;          // 解析不到日期时保守保留
        });
        out.listed = list.length;
        out.since = sinceStr;
        out.outOfRange = list.length - inRange.length;
        out.done = (list.length > 0 && inRange.length === 0) || page >= pageCount;
        if (!resp.ok) out.errors.push('列表抓取失败 ' + resp.status + ' ' + resp.error);
        inRange.forEach(function (it) { items.push(Object.assign({}, it, { _source: src })); });
        const srcId = src._id || src.id;
        if (srcId) {
          try {
            await setDoc('bid_sources', srcId, {
              backfillPage: page >= pageCount ? 1 : page + 1,
              lastFetchedAt: nowStr(), lastFetchStatus: resp.ok ? 'ok' : 'fail',
              lastFetchCount: list.length,
              lastFetchError: resp.ok ? '' : String(resp.error || resp.status).slice(0, 120)
            });
          } catch (e) { out.errors.push('回溯游标回写失败：' + String(e.message || e)); }
        }
      }
    }
  } else if (Array.isArray(ev.items) && ev.items.length) {
    out.mode = 'manual';
    items = ev.items.slice(0, MAX_INSERT * 2).map(function (x) {
      return Object.assign({}, x, { _keepSummary: !!x.summary });
    });
  } else {
    out.mode = 'crawl';
    let sources = [];
    try {
      const r = await C('bid_sources').where({ enabled: true }).limit(10).get();
      sources = r.data || [];
    } catch (e) { out.errors.push('bid_sources 读取失败：' + String(e.message || e)); }

    sources.sort(function (a, b) {
      return Number(a.lastFetchRound || 0) - Number(b.lastFetchRound || 0);
    });
    let maxRound = 0;
    sources.forEach(function (s) { maxRound = Math.max(maxRound, Number(s.lastFetchRound || 0)); });

    for (let i = 0; i < sources.length && Date.now() - started < BUDGET; i++) {
      const src = sources[i], code = String(src.code || src.name || 'unknown');
      if (src.robotsOk === false || src.allowed === false || src.autoAllowed === false) {
        out.sources.push({ code: code, skipped: '未通过准入评估（Robots / 服务条款）' }); continue;
      }
      if (!src.listUrl) { out.sources.push({ code: code, skipped: '未配置 listUrl' }); continue; }
      const left = BUDGET - (Date.now() - started);
      const mode = String(src.mode || 'html').toLowerCase();
      let resp, list;
      if (mode === 'json') {
        resp = await fetchJsonSource(src, Math.min(1500, Math.max(400, left - 700)));
        list = resp.ok ? resp.items : [];
      } else {
        resp = await httpGet(src.listUrl, Math.min(1200, Math.max(300, left - 800)));
        list = resp.ok ? parseList(resp.text, src) : [];
      }

      // 轮转游标：每轮只取列表的一小段抓详情；否则后面的条目永远排在前面几条的后面，
      // 每轮都重复抓同一批，列表后半段始终没有正文、摘要一直是「标题兜底」。
      const cursor = list.length ? Number(src.listCursor || 0) % list.length : 0;
      // 外部抓取器已带正文，不需要逐条抓详情，可一次多取一些（默认仍按 6 条轮转）
      const pickCap = Math.max(1, Math.min(20, parseInt(src.maxPick, 10) || MAX_DETAIL));
      const takeN = Math.min(pickCap, list.length);
      const picked = [];
      for (let k = 0; k < takeN; k++) picked.push(list[(cursor + k) % list.length]);
      const nextCursor = list.length ? (cursor + takeN) % list.length : 0;

      const srcId = src._id || src.id;
      if (srcId) {
        try {
          await setDoc('bid_sources', srcId, {
            lastFetchedAt: nowStr(), lastFetchRound: maxRound + 1,
            lastFetchStatus: resp.ok ? 'ok' : 'fail',
            lastFetchCount: list.length, listCursor: nextCursor,
            lastFetchError: resp.ok ? '' : String(resp.error || resp.status).slice(0, 120)
          });
        } catch (e) { out.errors.push('来源台账回写失败：' + String(e.message || e)); }
      }

      if (!resp.ok) { out.sources.push({ code: code, mode: mode, error: '列表抓取失败 ' + resp.status + ' ' + resp.error }); continue; }
      out.sources.push({ code: code, mode: mode, listItems: list.length, cursor: cursor, nextCursor: nextCursor, total: resp.total });
      picked.forEach(function (it) { items.push(Object.assign({}, it, { _source: src })); });
      break;   // 3 秒预算内每轮只处理 1 个源
    }
  }
  out.listed = items.length;

  /* 3. 采集前置过滤：只读 collectKeywords；留空 = 不过滤，保证查询页不受订阅收窄影响 */
  let kws = [];
  subs.forEach(function (s) {
    (Array.isArray(s.collectKeywords) ? s.collectKeywords : []).forEach(function (k) { if (k) kws.push(String(k)); });
  });
  if (Array.isArray(ev.keywords) && ev.keywords.length) kws = ev.keywords.map(String);
  kws = Array.from(new Set(kws));
  const hit = kws.length
    ? items.filter(function (it) { return kws.some(function (k) { return String(it.title || '').toLowerCase().indexOf(k.toLowerCase()) >= 0; }); })
    : items;
  out.filtered = hit.length;
  out.collectKeywords = kws.slice(0, 12);

  /* 4. 详情补字段 + 质量闸门（并行、带超时，3 秒预算内可覆盖 6 条）
        回溯模式跳过详情：只入库列表字段，否则 19 条详情必然超时；存证留空待后续补。 */
  const srcNow = items[0] && items[0]._source;
  const insertCap = Math.max(1, Math.min(20, parseInt(srcNow && srcNow.maxInsert, 10) || (backfill ? MAX_BACKFILL : MAX_INSERT)));
  const take = hit.slice(0, insertCap);
  if (!backfill) await Promise.all(take.map(async function (it) {
    if (it.snapshotText) return;
    if (!/^https?:\/\//i.test(String(it.url || ''))) return;
    const r = await httpGet(it.url, 900);
    if (!r.ok) return;
    const txt = compact(r.text, 5000);
    it.snapshotText = compact(txt, 3200);
    it.pageHash = sha(txt).slice(0, 16);
    it.httpStatus = r.status;
    if (!it.publishTime) {
      const dm = txt.match(/20\d{2}[-/年]\d{1,2}[-/月]\d{1,2}/);
      if (dm) it.publishTime = dm[0].replace(/[年月]/g, '-').replace(/日/g, '');
    }
    if (!it.tenderer) {
      const tm = txt.match(/(?:采购人|招标人|采购单位|建设单位|招标单位)\s*[:：为]?\s*([^\s，,。;；\n]{2,30})/);
      if (tm) it.tenderer = tm[1];
    }
  }));

  /* 5. 批量去重 + 并行入库（唯一索引 idx_source_url 兜底并发） */
  const docs = take.map(function (it) { return buildDoc(it, subs, backfill ? { noPush: true } : null); });
  const valid = docs.filter(function (d) {
    return d.title && d.normalizedUrl && /^https?:\/\//i.test(d.url);
  });
  out.skipped += docs.length - valid.length;
  const existing = {};
  try {
    const _ = db.command;
    const srcs = Array.from(new Set(valid.map(function (d) { return d.source; })));
    const urls = valid.map(function (d) { return d.normalizedUrl; });
    if (urls.length) {
      const r = await C('bid_notices')
        .where({ source: _.in(srcs), normalizedUrl: _.in(urls) }).limit(100).get();
      (r.data || []).forEach(function (x) { existing[x.source + '|' + x.normalizedUrl] = 1; });
    }
  } catch (e) { out.errors.push('批量查重失败，改由唯一索引兜底：' + String(e.message || e)); }
  const fresh = valid.filter(function (d) { return !existing[d.source + '|' + d.normalizedUrl]; });
  out.skipped += valid.length - fresh.length;

  const writes = await Promise.all(fresh.map(function (d) {
    return Promise.resolve(addDoc('bid_notices', d))
      .then(function () { return { ok: true, d: d }; })
      .catch(function (e) { return { ok: false, d: d, e: e }; });
  }));
  const newIds = [];
  writes.forEach(function (w) {
    if (w.ok) { newIds.push(w.d.id); out.inserted += 1; }
    else if (/duplicate|唯一|E11000|already exists|conflict/i.test(String(w.e.message || w.e))) out.skipped += 1;
    else out.errors.push('入库失败：' + String(w.e.message || w.e));
  });

  /* 6. 末尾调用 bidNotify（只等 700ms，避免把 3 秒预算耗尽） */
  if (newIds.length && !backfill) {
    try {
      const r = await withTimeout(app.callFunction({ name: 'bidNotify', data: { noticeIds: newIds } }), 700, null);
      out.notified = r && r.result ? r.result : { called: true, note: '已发起调用，返回结果未取到（不影响独立执行）' };
    } catch (e) { out.notified = { called: false, error: String(e.message || e) }; }
  } else if (backfill) {
    out.notified = { called: false, note: '回溯模式只入库、不入队推送' };
  } else {
    out.notified = { called: false, note: '本轮无新增公告' };
  }

  out.ms = Date.now() - started;
  return out;
};
