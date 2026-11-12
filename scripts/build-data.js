'use strict';
/**
 * 把「外部抓取器原始结果」+「云端已有记录」合并成站点数据。
 *
 * 用法：
 *   node tools/build-data.js
 *
 * 输入：
 *   repo-files/data/raw-notices.json   抓取器原始输出（只有标题/链接/日期/来源/地区/正文）
 *   bidQuery 网关                      云端已有记录（可选，失败则只用本地）
 * 输出：
 *   repo-files/data/notices.json       站点数据（补 id / 摘要 / 指纹 / 采集时间，按时间倒序）
 *   out/bid_notices.import.N.jsonl     云端缺少的部分，供控制台「导入数据」，pushPending=false 不推群
 *
 * 说明：摘要与指纹复用云端 bidFetch 的同一份代码本地执行，保证线上线下字段口径一致。
 */
const fs = require('fs');
const path = require('path');
const Module = require('module');
const classify = require('./lib/classify');

const ROOT = path.resolve(__dirname, '..');
/* 路径可用环境变量覆盖：GitHub Actions 里仓库根目录结构与本地不同 */
const RAW = path.join(ROOT, 'data', 'raw-notices.json');
const OUT_JSON = path.join(ROOT, 'data', 'notices.json');
const OUT_DIR = '';                                         // Actions 不生成导入文件
const DELTA_OUT = path.join(ROOT, 'data', 'delta.json');     // 云函数只读这份小文件
const DELTA_HOURS = Math.max(1, parseInt(process.env.DELTA_HOURS, 10) || 40);
const DELTA_SNAP = 0;                                       // 云函数 3 秒预算：增量里不带正文
const DELTA_MAX = 24;                                       // 云函数一轮最多入库 20 条，留几条余量抵掉重复
/* 推送口径（2026-11-11 用户定）：只推「招标公告 + 房建」。
   关键词留作第二道可选收窄：不传 PUSH_KEYWORDS（或传空串）= 不按关键词过滤。 */
const DEFAULT_PUSH_KEYWORDS = '';
const SEED_JSON = OUT_JSON;                                 // 用上一版补上超出抓取窗口的历史
const SKIP_CLOUD = true;                                    // GitHub 上没有云端读取权限
const FN = path.join(__dirname, 'lib', 'bidFetch.js');
const GATEWAY = 'https://cloud1-d3gaf5eqqbde1768e-1510684745.ap-shanghai.app.tcloudbase.com/bidQuery';
const WINDOW = 400;
const BATCH = 200;

function key(d) {
  return String(d.source || '') + '|' + String(d.normalizedUrl || d.url || '');
}

/* ---------------- 标题清洗：去栏目前缀 / 去重复段 / 去状态后缀 ---------------- */
const TITLE_PREFIX = /^【(?:湖北省中心|分散采购备案单|快速采购|单一来源|货物|工程|服务)】\s*/;
const TITLE_NEW = /^[（(]新[）)]\s*/;
const TITLE_STATUS = /\s*[\[【](?:文件获取中|已结束|报名中|进行中|已截止|已开标|待开标|中标公示中)[\]】]\s*$/;

function cleanTitle(raw) {
  const origin = String(raw || '').replace(/\s+/g, ' ').trim();
  let s = origin.replace(TITLE_NEW, '').replace(TITLE_PREFIX, '').replace(TITLE_STATUS, '').trim();
  /* 源站把「项目名」拼了两遍：找最长的「前缀自我重复」并删掉一份 */
  for (let i = Math.floor(s.length / 2); i >= 10; i--) {
    const a = s.slice(0, i);
    if (s.slice(i, i + i) === a) { s = a + s.slice(2 * i); break; }
  }
  return s.trim() || origin;
}

/* ---------------- 招标单位抽取：只认「机构名」，宁缺毋滥 ---------------- */
const ORG_TAIL = ['股份有限公司', '有限责任公司', '有限公司', '集团有限公司', '管理委员会', '研究院', '研究所',
  '管理处', '管理局', '指挥部', '办公室', '委员会', '大学', '学院', '医院', '学校', '集团', '公司',
  '中心', '银行', '局', '厅', '院', '站', '厂', '所'];
const ORG_CHARS = '[^\\s，。；：、|]';
const ORG_BAD_START = /^(提出|已经|已|根据|本次|本项目|本工程|该|中标|详见|见|按照|经|如|若|凡|请|对|在|为|于)/;
const ORG_BAD_WORD = /(已经|确认|公告|提出|如下|详见|应当|可以|不得|负责|有关|相关)/;

function cutOrg(s) {
  const v = String(s || '').trim();
  if (!v) return '';
  /* 取「最长的合法机构名」：避免把「中铁十一局集团有限公司」截成「中铁十一局」 */
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
  const core = s.replace(/（[^）]{1,10}）$/, '');   // 「中国地质大学（武汉）」去掉括号再判后缀
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

/* 摘要里「招标单位：…」的值不是机构名就整段丢掉，避免「招标单位：提出」这种句子 */
function scrubSummary(s) {
  let t = String(s || '');
  t = t.replace(/招标单位：([^；]*)(；|$)/g, (all, val) => (isValidOrg(String(val).trim()) ? all : ''));
  return t.replace(/^；+|；+$/g, '').replace(/；{2,}/g, '；').trim();
}

async function cloudRows() {
  const rows = [];
  if (SKIP_CLOUD) return rows;          // Actions 里没有云端读取权限，只用抓取结果
  try {
    for (let page = 1; page <= 40; page++) {
      const r = await fetch(GATEWAY + '?page=' + page + '&size=50', { signal: AbortSignal.timeout(15000) });
      if (!r.ok) break;
      const j = await r.json();
      const rs = j.rows || [];
      rows.push(...rs);
      if (!rs.length || rows.length >= (j.total || 0)) break;
    }
  } catch (e) {
    console.warn('云端读取失败（只用本地数据）：' + e.message);
  }
  return rows;
}

(async () => {
  if (!fs.existsSync(RAW)) {
    console.error('缺少 ' + RAW + '，请先运行 node repo-files/scripts/fetch-notices.js');
    process.exit(1);
  }
  const RAWJ = JSON.parse(fs.readFileSync(RAW, 'utf8'));
  const rawItems = Array.isArray(RAWJ) ? RAWJ : (RAWJ.items || []);
  console.log('原始抓取 ' + rawItems.length + ' 条');

  /* 已经生成过 id 的记录直接当文档用，不再重跑 */
  const alreadyDocs = rawItems.every((x) => x.id && x.normalizedUrl);
  let docs = [];

  if (alreadyDocs) {
    docs = rawItems.slice();
  } else {
    const collected = [];
    const seen = new Map();
    let windowStart = 0;
    const SRC = {
      _id: 'gh', code: 'ghfile', enabled: true, mode: 'json', method: 'GET',
      listUrl: 'https://local.invalid/notices.json',
      recordsPath: 'items', urlField: 'url', maxList: WINDOW, maxPick: 25, maxInsert: 20,
      fieldMap: {
        title: 'title', tenderer: 'tenderer', publishTime: 'publishTime',
        source: 'source', region: 'region', noticeType: 'noticeType', snapshotText: 'snapshotText'
      },
      noticeType: '招标公告'
    };
    function coll(name) {
      const o = {};
      ['where', 'orderBy', 'limit'].forEach((k) => { o[k] = () => o; });
      o.get = async () => {
        if (name === 'bid_sources') return { data: [SRC] };
        if (name === 'bid_subscriptions') return { data: [] };
        return { data: [...seen.entries()].map(([u, src]) => ({ source: src, normalizedUrl: u })) };
      };
      o.add = async (d) => { collected.push(d); seen.set(d.normalizedUrl, d.source); return { id: d.id }; };
      o.doc = () => ({ update: async (patch) => { Object.assign(SRC, patch); return {}; } });
      return o;
    }
    const db = { collection: coll, command: { in: () => ({}), gte: () => ({}) } };
    const origLoad = Module._load;
    Module._load = function (req) {
      if (req === '@cloudbase/node-sdk') {
        return { SYMBOL_CURRENT_ENV: 'env', init: () => ({ database: () => db }), callFunction: async () => ({}) };
      }
      if (req === 'wx-server-sdk') throw new Error('no wx sdk');
      return origLoad.apply(this, arguments);
    };
    const realFetch = global.fetch;
    global.fetch = async () => {
      const items = rawItems.slice(windowStart, windowStart + WINDOW);
      return { ok: true, status: 200, text: async () => JSON.stringify({ count: items.length, items }) };
    };
    const fn = require(FN);
    for (let off = 0; off < rawItems.length; off += WINDOW) {
      windowStart = off;
      SRC.listCursor = 0;
      for (let i = 0; i < 40; i++) {
        const before = collected.length;
        await fn.main({});
        if (collected.length === before) break;
      }
    }
    global.fetch = realFetch;
    Module._load = origLoad;
    docs = collected;
  }
  console.log('生成完整文档 ' + docs.length + ' 条');

  const merged = new Map();
  docs.forEach((d) => merged.set(key(d), d));

  /* 上一版数据的留存：抓取窗口只有 62 天，Actions 里又读不到云端库，
     用上一版补上「已超出窗口但仍想留」的条目，避免每次重建把历史越洗越少 */
  if (SEED_JSON && fs.existsSync(SEED_JSON)) {
    try {
      const prev = JSON.parse(fs.readFileSync(SEED_JSON, 'utf8'));
      const arr = Array.isArray(prev) ? prev : (prev.items || []);
      let kept = 0;
      arr.forEach((d) => {
        if (!d || !d.title || !d.url) return;
        const k = key(d);
        if (merged.has(k)) return;
        merged.set(k, d);
        kept++;
      });
      console.log('上一版留存 ' + arr.length + ' 条，沿用 ' + kept + ' 条');
    } catch (e) {
      console.warn('上一版读取失败（忽略）：' + e.message);
    }
  }

  const cloud = await cloudRows();
  let added = 0;
  cloud.forEach((c) => {
    const k = key(c);
    if (merged.has(k)) return;
    merged.set(k, {
      id: c.id || '', title: c.title, url: c.url, source: c.source, tenderer: c.tenderer,
      publishTime: c.publishTime, collectTime: c.collectTime, summary: c.summary || '',
      summaryVersion: c.summaryVersion || 1, region: c.region || '', industry: c.industry || '',
      noticeType: c.noticeType || '', status: c.status || '有效',
      normalizedUrl: c.normalizedUrl || c.url || '', fingerprint: c.fingerprint || '',
      pageHash: c.pageHash || '', httpStatus: c.httpStatus || 200, snapshotText: ''
    });
    added++;
  });
  console.log('云端 ' + cloud.length + ' 条，其中补充 ' + added + ' 条');

  const stat = { titleChanged: 0, orgFilled: 0, orgDropped: 0, orgFromSource: 0 };
  const items = [...merged.values()]
    .filter((d) => d.title && d.url)
    .map((d) => {
      const rawTitle = String(d.titleRaw || d.title || '').trim();
      const title = cleanTitle(rawTitle);
      if (title !== rawTitle) stat.titleChanged++;

      let tenderer = String(d.tenderer || '').trim();
      let tendererFrom = '';
      if (!isValidOrg(tenderer)) {
        if (tenderer && tenderer !== '—') stat.orgDropped++;
        tenderer = findOrg(d.snapshotText || '');
        if (tenderer) stat.orgFilled++;
      }
      /* 高校自建平台：公告由学校自己发，招标人就是这所学校 */
      if (!tenderer) {
        const owner = classify.ownerOf(d.source);
        if (owner) {
          tenderer = owner;
          tendererFrom = 'platform';
          stat.orgFromSource++;
        }
      }

      const doc = {
        id: d.id,
        title: title,
        titleRaw: title !== rawTitle ? rawTitle : '',
        url: d.url,
        source: d.source,
        tenderer: tenderer || '—',
        tendererFrom: tendererFrom,
        publishTime: String(d.publishTime || '').slice(0, 16),
        collectTime: d.collectTime || '',
        summary: scrubSummary(d.summary),
        region: d.region || '',
        industry: d.industry || '',
        noticeType: d.noticeType || '',
        status: d.status || '有效',
        normalizedUrl: d.normalizedUrl || d.url,
        pageHash: d.pageHash || '',
        httpStatus: d.httpStatus || 200,
        snapshotText: d.snapshotText || ''
      };
      /* 类型与行业在这里再算一次：抓取侧已算过，历史数据（以及云端补进来的记录）
         还是旧的「一律招标公告」，重算一遍才能把「合同信息公示」这类错的标签纠正过来 */
      doc.noticeType = classify.typeOf(doc);
      doc.industry = classify.industryOf(doc);
      return doc;
    })
    .sort((a, b) => String(b.publishTime).localeCompare(String(a.publishTime)));

  const dates = items.map((x) => x.publishTime.slice(0, 10)).filter(Boolean).sort();
  const nowCn = new Date(Date.now() + 8 * 3600000).toISOString().replace('T', ' ').slice(0, 16);
  const payload = {
    generatedAt: nowCn,
    windowDays: 62,
    cutoff: new Date(Date.now() - 62 * 86400000).toISOString().slice(0, 10),
    count: items.length,
    items
  };
  fs.writeFileSync(OUT_JSON, JSON.stringify(payload, null, 1) + '\n', 'utf8');

  /* 增量文件（给云函数读）：只留「最近 N 小时 + 命中推送关键词」的条目。
     原因：云函数固定 3 秒超时，一轮最多读 30 KB、最多入库 20 条；
     全量每天 70–120 条根本喂不进去。云端的库只承担「企微推送候选池」这一个职责，
     网页那份 data/notices.json 才是全量。云侧按「来源+链接」去重，重复读不会重复入库。 */
  if (DELTA_OUT) {
    /* 按「日期」比较：不少来源的发布时间只到天（2026-11-09），
       用带时分秒的阈值做字符串比较会把它们整体漏掉 */
    const sinceDate = new Date(Date.now() - DELTA_HOURS * 3600000).toISOString().slice(0, 10);
    const kwsRaw = process.env.PUSH_KEYWORDS;
    const kws = String(kwsRaw === undefined ? DEFAULT_PUSH_KEYWORDS : kwsRaw)
      .split(/[,，\s]+/).map((s) => s.trim()).filter(Boolean);
    /* 推送口径三道闸（顺序即成本，先便宜后贵）：
       ① 时间窗  ② 类型白名单（招标/答疑/澄清/更正/变更）  ③ 只要房建  ④ 可选关键词
       前两道闸决定「推什么」，是用户 2026-11-11 定的口径：
       中标、评标、合同公示、报建、流标这些只进网页，不进企微。 */
    const stat4 = { time: 0, type: 0, industry: 0, kw: 0 };
    let recent = items.filter((d) => {
      if (String(d.publishTime || '').slice(0, 10) < sinceDate) { stat4.time++; return false; }
      if (!classify.isPushType(d)) { stat4.type++; return false; }
      if (!classify.isHouseBuild(d)) { stat4.industry++; return false; }
      if (!kws.length) return true;
      const hay = String(d.title || '') + ' ' + String(d.summary || '');
      if (!kws.some((k) => hay.indexOf(k) >= 0)) { stat4.kw++; return false; }
      return true;
    });
    console.log('推送闸门：时间窗内被排除 非推送类型 ' + stat4.type + ' 条、非房建 ' + stat4.industry +
      ' 条' + (kws.length ? '、未命中关键词 ' + stat4.kw + ' 条' : '（未设关键词，不筛）'));
    if (DELTA_MAX) recent = recent.slice(0, DELTA_MAX);   // items 已按发布时间倒序
    /* 只留云函数入库需要的字段：指纹、页面哈希、正文这些都留在网页那份里，
       否则 30 条就有 35 KB，超出云函数 1.5 秒的下载预算 */
    recent = recent.map((d) => ({
      id: d.id,
      title: d.title,
      url: d.url,
      normalizedUrl: d.normalizedUrl || d.url,
      source: d.source,
      region: d.region || '',
      industry: d.industry || '',
      noticeType: d.noticeType || '',
      tenderer: d.tenderer || '',
      publishTime: d.publishTime || '',
      summary: String(d.summary || '').slice(0, 140)
    }));
    fs.mkdirSync(path.dirname(DELTA_OUT), { recursive: true });
    fs.writeFileSync(DELTA_OUT, JSON.stringify({ generatedAt: nowCn, since: sinceDate, keywords: kws, count: recent.length, items: recent }, null, 1) + '\n', 'utf8');
    console.log('增量 ' + recent.length + ' 条（' + sinceDate + ' 起，命中 ' + kws.join('/') + '）→ ' + DELTA_OUT +
      '，' + Math.round(fs.statSync(DELTA_OUT).size / 1024) + ' KB');
  }

  /* 云端没有的，生成导入文件 */
  let missing = [], n = 0;
  if (!OUT_DIR) {
    console.log('（未指定 OUT_DIR，跳过导入文件生成）');
  } else {
  const cloudKeys = new Set(cloud.map(key));
  missing = items.filter((d) => !cloudKeys.has(key(d)));
  fs.mkdirSync(OUT_DIR, { recursive: true });
  for (const f of fs.readdirSync(OUT_DIR)) {
    if (/^bid_notices\.import\.\d+\.jsonl$/.test(f)) fs.unlinkSync(path.join(OUT_DIR, f));
  }
  for (let i = 0; i < missing.length; i += BATCH) {
    n++;
    const lines = missing.slice(i, i + BATCH).map((d) => {
      const doc = Object.assign({}, d);
      doc.pushPending = false;
      doc.hitSubIds = [];
      return JSON.stringify(doc);
    });
    fs.writeFileSync(path.join(OUT_DIR, 'bid_notices.import.' + n + '.jsonl'), lines.join('\n'), 'utf8');
  }
  }

  const bySrc = {};
  items.forEach((d) => { bySrc[d.source] = (bySrc[d.source] || 0) + 1; });
  console.log('---');
  console.log('站点数据 ' + items.length + ' 条 → ' + OUT_JSON);
  console.log('时间范围 ' + dates[0] + ' ~ ' + dates[dates.length - 1]);
  console.log('标题清洗 ' + stat.titleChanged + ' 条，单位补全 ' + stat.orgFilled + ' 条，丢弃错值 ' + stat.orgDropped + ' 条');
  console.log('单位按平台主体兜底 ' + stat.orgFromSource + ' 条');
  console.log('有单位 ' + items.filter((d) => d.tenderer && d.tenderer !== '—').length + ' 条');
  console.log('带摘要 ' + items.filter((d) => d.summary).length + '，带正文 ' + items.filter((d) => d.snapshotText).length);
  console.log('来源 ' + JSON.stringify(bySrc));
  console.log('待静默入库 ' + missing.length + ' 条 / ' + n + ' 个文件 → ' + OUT_DIR);

  /* 清洗对照报告：抽前若干条，方便人工过一眼 */
  if (OUT_DIR) {
  const rep = [];
  rep.push('# 标题与单位清洗对照（' + nowCn + '）', '');
  rep.push('共 ' + items.length + ' 条：标题被清洗 ' + stat.titleChanged + ' 条；单位补全 ' + stat.orgFilled +
    ' 条；丢弃错误单位 ' + stat.orgDropped + ' 条；当前有单位 ' + items.filter((d) => d.tenderer !== '—').length + ' 条。', '');
  rep.push('## 标题（前 30 条）', '');
  items.filter((d) => d.titleRaw).slice(0, 30).forEach((d, i) => {
    rep.push('**' + (i + 1) + '.** 原（' + d.titleRaw.length + ' 字）：' + d.titleRaw);
    rep.push('　→ 新（' + d.title.length + ' 字）：' + d.title, '');
  });
  rep.push('## 单位（前 30 条非空）', '');
  items.filter((d) => d.tenderer !== '—').slice(0, 30).forEach((d, i) => {
    rep.push('**' + (i + 1) + '.** ' + d.tenderer + '　（' + d.source + '）' + d.title.slice(0, 40));
  });
  fs.writeFileSync(path.join(OUT_DIR, 'clean-report.md'), rep.join('\n'), 'utf8');
  console.log('对照报告 → ' + path.join(OUT_DIR, 'clean-report.md'));
  }

})().catch((e) => { console.error('失败：' + (e && e.message)); process.exit(1); });
