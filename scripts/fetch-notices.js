#!/usr/bin/env node
'use strict';
/**
 * 外部抓取器（GitHub Actions 或本机运行）：把公开招标公告汇总成 data/raw-notices.json。
 * 原始结果再由 tools/build-data.js 补摘要/指纹，生成站点用的 data/notices.json。
 *
 * 为什么放在 GitHub Actions：
 *   0 元套餐的云函数执行超时固定 3 秒，武汉平台的列表接口单次 3–10 秒，直连必然超时；
 *   Actions 单次可跑几分钟，抓完把结果写进仓库，云函数只负责读一个几百 KB 的 JSON（<0.5s）。
 *
 * 用法：node scripts/fetch-notices.js
 *   WINDOW_DAYS  保留多少天（默认 62）
 *   MAX_DETAIL   单轮最多补抓多少条详情正文（默认 40）
 */

const fs = require('fs');
const path = require('path');

const WINDOW_DAYS = Math.max(1, parseInt(process.env.WINDOW_DAYS, 10) || 62);
const MAX_DETAIL = Math.max(0, parseInt(process.env.MAX_DETAIL, 10) || 40);
const UA = 'BidNoticeBot/1.0 (public-notice-index; +https://github.com/yuanhao-o/bid)';
/* 部分高校站点对非浏览器 UA 直接 403（仅 UA 过滤，robots.txt 未限制），
   这里用常规浏览器头读取公开列表页，每个站点每轮只请求 1 次。 */
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const OUT = path.join(__dirname, '..', 'data', 'raw-notices.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------- 通用 ---------------- */
async function httpGet(url, ms = 25000, browser = false) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, {
      signal: ctl.signal,
      headers: browser
        ? { 'User-Agent': BROWSER_UA, 'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8', 'Accept-Language': 'zh-CN,zh;q=0.9' }
        : { 'User-Agent': UA, 'Accept': 'text/html,application/json,*/*', 'Accept-Language': 'zh-CN,zh;q=0.9' }
    });
    return { ok: r.ok, status: r.status, text: await r.text() };
  } catch (e) {
    return { ok: false, status: 0, text: '', error: String(e.message || e) };
  } finally { clearTimeout(timer); }
}

async function httpPostJson(url, body, ms = 40000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, {
      method: 'POST', signal: ctl.signal,
      headers: {
        'User-Agent': UA, 'Content-Type': 'application/json;charset=UTF-8',
        'Accept': 'application/json, text/plain, */*',
        'Origin': 'https://www.whzbtbxt.cn', 'Referer': 'https://www.whzbtbxt.cn/whebd/'
      },
      body: JSON.stringify(body)
    });
    const text = await r.text();
    return { ok: r.ok, status: r.status, text: text };
  } catch (e) {
    return { ok: false, status: 0, text: '', error: String(e.message || e) };
  } finally { clearTimeout(timer); }
}

function htmlToText(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6]|section|article)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"')
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
}

/* 从详情页文本里裁掉导航、面包屑与字体控件，保留正文 */
function cleanDetail(text, title) {
  let t = String(text || '')
    .split('\n')
    .filter((line) => {
      const s = line.trim();
      if (!s) return false;
      if (/^首页\s*[>›]/.test(s)) return false;
      if (/^当前位置/.test(s) || /^当前的位置/.test(s)) return false;
      if (/^\d{6,}$/.test(s)) return false;                       // 栏目编号 004003004
      if (/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(s)) return false; // GUID
      if (/^(打印本页|关闭窗口|返回顶部|网站地图|友情链接)$/.test(s)) return false;
      // 短且无标点/数字的行基本都是栏目导航（首页、机构设置、综合办公室…）
      if (s.length <= 6 && !/[：:，,。.、；;（）()\d]/.test(s)) return false;
      return true;
    })
    .join('\n')
    .replace(/【?\s*字体\s*[:：]?\s*大\s*中\s*小\s*】?/g, ' ')
    .replace(/浏览次数[:：]?\s*\d*/g, ' ')
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim();
  const key = String(title || '').slice(0, 12);
  if (key) {
    const i = t.indexOf(key);
    if (i > 0 && i < 1200) t = t.slice(i);
  }
  return t.slice(0, 3000);
}

const ymd = (d) => {
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
};

/* ---------------- 湖北：静态列表 6 页 + 详情正文 ---------------- */
const HUBEI_PAGES = [
  'https://www.hbbidcloud.cn/shengbenji/jyxx/aboutccgs.html',
  'https://www.hbbidcloud.cn/shengbenji/jyxx/2.html',
  'https://www.hbbidcloud.cn/shengbenji/jyxx/3.html',
  'https://www.hbbidcloud.cn/shengbenji/jyxx/4.html',
  'https://www.hbbidcloud.cn/shengbenji/jyxx/5.html',
  'https://www.hbbidcloud.cn/shengbenji/jyxx/6.html'
];

async function fetchHubei() {
  const seen = new Set();
  const items = [];
  const detailTargets = [];
  for (const page of HUBEI_PAGES) {
    const r = await httpGet(page);
    if (!r.ok) { console.log('  列表失败', page, r.status, r.error || ''); continue; }
    const re = /<a[^>]+href="([^"]*\/\d{8}\/[^"]+\.html)"[^>]*title="([^"]+)"/g;
    let m, n = 0;
    while ((m = re.exec(r.text))) {
      const url = new URL(m[1], 'https://www.hbbidcloud.cn').toString();
      if (seen.has(url)) continue;
      seen.add(url);
      const dm = url.match(/\/(\d{4})(\d{2})(\d{2})\//);
      items.push({
        title: m[2].replace(/\s+/g, ' ').trim(),
        url: url,
        publishTime: dm ? dm[1] + '-' + dm[2] + '-' + dm[3] : '',
        source: 'hbbidcloud',
        region: '湖北',
        noticeType: '招标公告',
        tenderer: ''
      });
      n++;
    }
    console.log('  ' + page.split('/').pop() + ' → ' + n + ' 条');
    await sleep(300);
  }
  console.log('湖北列表合计 ' + items.length + ' 条，准备补详情');
  for (const it of items) detailTargets.push(it);
  return { items, detailTargets };
}

async function enrichDetail(it) {
  const site = it.source !== 'hbbidcloud';
  const r = await httpGet(it.url, 20000, site);
  if (!r.ok) return false;
  const txt = cleanDetail(htmlToText(r.text), it.title);
  if (txt.length < 60) return false;
  it.snapshotText = txt;
  return true;
}

/* ---------------- 武汉：公开 JSON 接口（单次 3–10 秒，Actions 里没问题） ---------------- */
async function fetchWuhan(pages) {
  const out = [];
  for (let p = 1; p <= pages; p++) {
    const r = await httpPostJson('https://www.whzbtbxt.cn/whebd-server/cmsHomePage/tendererNoticeList',
      { current: p, size: 10, noticeState: '2' });
    if (!r.ok) { console.log('  武汉第 ' + p + ' 页失败', r.status, r.error || ''); break; }
    let j;
    try { j = JSON.parse(r.text); } catch (e) { console.log('  武汉返回非 JSON'); break; }
    const recs = (j && j.data && j.data.records) || [];
    recs.forEach((x) => {
      const id = x.id, regId = x.registrationId;
      if (!id) return;
      const url = 'https://www.whzbtbxt.cn/whebd/#/cmsIndex?path=tendererNotice&id=' + id +
        (regId ? '&registrationId=' + regId : '') + '&type=details';
      const parts = [];
      if (x.prjbuildCorpName) parts.push('招标单位：' + x.prjbuildCorpName);
      if (x.tenderContentName) parts.push('招标范围：' + x.tenderContentName);
      if (x.tenderContentDescription) parts.push('建设规模：' + String(x.tenderContentDescription).slice(0, 160));
      if (x.allInvestStr || x.totalInvestment) parts.push('预算投资：' + (x.allInvestStr || (Number(x.totalInvestment) ? x.totalInvestment + '万元' : '')));
      if (x.noticeEndDate || x.bidDocumentSubmitEndDate) parts.push('投标截止时间：' + String(x.noticeEndDate || x.bidDocumentSubmitEndDate).slice(0, 16));
      if (x.prjAddress) parts.push('建设地点：' + String(x.prjAddress).slice(0, 40));
      if (x.sectionQuantity) parts.push('标段划分：' + x.sectionQuantity + ' 个标段');
      if (x.plannedPeriod) parts.push('工期：' + x.plannedPeriod);
      if (x.evaluationMethodName) parts.push('评标办法：' + x.evaluationMethodName);
      if (x.agencyCorpName) parts.push('招标代理机构：' + x.agencyCorpName);
      out.push({
        title: String(x.tenderPrjName || x.titleName || '').trim(),
        url: url,
        publishTime: String(x.noticeStartDate || '').slice(0, 10),
        source: 'whzbtb',
        region: '湖北武汉',
        noticeType: '招标公告',
        tenderer: String(x.prjbuildCorpName || ''),
        snapshotText: parts.join(' | ')
      });
    });
    console.log('  武汉第 ' + p + ' 页 → ' + recs.length + ' 条');
    if (recs.length < 10) break;
    await sleep(500);
  }
  return out;
}

/* ---------------- 湖北高校 / 单位：各自官网的公开采购公告列表 ----------------
 * 加一个站点只需补一条配置：
 *   code / name / region / noticeType  展示用
 *   base        相对链接的解析基准（站点根）
 *   listUrls    一个或多个列表页（同一站点多个栏目就写多条）
 *   itemRe      条目正则，用命名分组：url 链接、title 或 text 标题、date 日期（可选）
 * 日期抓不到时会自动往条目后面 260 字内找一次。
 */
/* 同一套「cms.chtml」模板的站点（华科 / 武理工 / 武科大 / 地大）共用一条正则：
   <span class="date"> 2026-11-06 </span> <a title="标题" href="/xxx/1234.chtml"> */
const CHTM_ITEM = /<span class="date">\s*(?<date>20\d{2}-\d{2}-\d{2})\s*<\/span>\s*<a[^>]*?title="(?<title>[^"]+)"[^>]*?href="(?<url>[^"]+\.chtml)"/;

const SITE_SOURCES = [
  {
    code: 'whu-zb', name: '武汉大学采购与招投标管理中心', region: '湖北武汉', noticeType: '招标公告',
    base: 'https://zb.whu.edu.cn/',
    listUrls: ['https://zb.whu.edu.cn/cgxx.htm'],
    itemRe: /<a href="(?<url>info\/\d+\/\d+\.htm)">(?<text>[\s\S]{4,140}?)<\/a>\s*<div class="date1">(?<date>20\d{2}-\d{2}-\d{2})<\/div>/
  },
  {
    code: 'hust-cgzx', name: '华中科技大学采购与招标中心', region: '湖北武汉', noticeType: '招标公告',
    base: 'http://cgzx.hust.edu.cn',
    listUrls: ['http://cgzx.hust.edu.cn/cgjzcg/index.chtml'],
    itemRe: CHTM_ITEM
  },
  {
    code: 'whut-cgyztb', name: '武汉理工大学采购与招标管理办公室', region: '湖北武汉', noticeType: '招标公告',
    base: 'http://cgyztb.whut.edu.cn',
    listUrls: [
      'http://cgyztb.whut.edu.cn/cgjzcg/index.chtml',
      { url: 'http://cgyztb.whut.edu.cn/cgfscg/index.chtml', noticeType: '分散采购公告' }
    ],
    itemRe: CHTM_ITEM
  },
  {
    code: 'wust-cgpt', name: '武汉科技大学采购与招标管理办公室', region: '湖北武汉', noticeType: '招标公告',
    base: 'https://cgpt.wust.edu.cn',
    listUrls: [
      'https://cgpt.wust.edu.cn/cggghwl/index.chtml',
      'https://cgpt.wust.edu.cn/cgggfwl/index.chtml',
      'https://cgpt.wust.edu.cn/cggggcl/index.chtml'
    ],
    itemRe: CHTM_ITEM
  },
  {
    code: 'cug-cggl', name: '中国地质大学（武汉）采购与招标管理中心', region: '湖北武汉', noticeType: '招标公告',
    base: 'https://cggl.cug.edu.cn',
    listUrls: [
      'https://cggl.cug.edu.cn/wtcggg/index.chtml',
      'https://cggl.cug.edu.cn/fscggg/index.chtml'
    ],
    itemRe: CHTM_ITEM
  },
  {
    code: 'ccnu-zb', name: '华中师范大学招标信息网', region: '湖北武汉', noticeType: '招标公告',
    base: 'https://zb.ccnu.edu.cn/',
    listUrls: ['https://zb.ccnu.edu.cn/'],
    itemRe: /<a class="title"[^>]*href="(?<url>\/viewer\.do\?id=\d+&ver=\d+)">(?<text>[\s\S]{4,180}?)<\/a>\s*<div class="time">(?<date>20\d{2}-\d{2}-\d{2})<\/div>/
  },
  {
    code: 'hzau-ztb', name: '华中农业大学采购与招标中心', region: '湖北武汉', noticeType: '招标公告',
    base: 'https://ztb.hzau.edu.cn/',
    listUrls: [
      'https://ztb.hzau.edu.cn/cggg/jzcg/hw.htm',
      'https://ztb.hzau.edu.cn/cggg/jzcg/fw.htm',
      'https://ztb.hzau.edu.cn/cggg/jzcg/gc.htm'
    ],
    itemRe: /<LI><A href="(?<url>[^"]{10,400})"[^>]*>(?<text>[\s\S]{4,180}?)<\/A><EM>(?<date>20\d{2}-\d{2}-\d{2})<\/EM>/i
  },
  {
    code: 'hubu-ztb', name: '湖北大学招标采购网', region: '湖北武汉', noticeType: '招标公告',
    base: 'https://ztb.hubu.edu.cn/',
    listUrls: [
      { url: 'https://ztb.hubu.edu.cn/cggg/jjcg.htm', noticeType: '竞价公告' },
      { url: 'https://ztb.hubu.edu.cn/cggg/qt.htm', noticeType: '其他公告' },
      { url: 'https://ztb.hubu.edu.cn/cggg/tycg.htm', noticeType: '通用采购公告' }
    ],
    itemRe: /<a href="(?<url>\.\.\/info\/\d+\/\d+\.htm)"[^>]*title="(?<title>[^"]+)"[^>]*>[\s\S]{0,220}?<\/a>[\s\S]{0,60}?(?<date>20\d{2}-\d{2}-\d{2})/
  },
  {
    code: 'jhun-cgyztb', name: '江汉大学采购与招投标管理中心', region: '湖北武汉', noticeType: '招标公告',
    base: 'https://cgyztb.jhun.edu.cn/',
    listUrls: [
      { url: 'https://cgyztb.jhun.edu.cn/7931/list.htm', noticeType: '招标公告' },
      { url: 'https://cgyztb.jhun.edu.cn/7932/list.htm', noticeType: '成交公告' }
    ],
    itemRe: /<a href='(?<url>[^']+)' target='_blank' title='(?<title>[^']+)'>[\s\S]{0,220}?<\/a><\/span>\s*<span class="fontR news_meta">(?<date>20\d{2}-\d{2}-\d{2})<\/span>/
  },
  {
    /* 荆州：列表是静态 HTML，但栏目分得细，一条配置抓 4 个栏目 */
    code: 'jingzhou-ggzy', name: '荆州市公共资源交易信息网', region: '湖北荆州', noticeType: '招标公告',
    base: 'http://www.jzggzy.com',
    listUrls: [
      { url: 'http://www.jzggzy.com/jyxx/012001/012001002/moreinfo3.html', noticeType: '招标公告' },
      { url: 'http://www.jzggzy.com/jyxx/012001/012001004/moreinfo3.html', noticeType: '评标结果公示' },
      { url: 'http://www.jzggzy.com/jyxx/012001/012001005/moreinfo3.html', noticeType: '中标公告' },
      { url: 'http://www.jzggzy.com/jyxx/012002/012002001/moreinfo3.html', noticeType: '采购公告' }
    ],
    itemRe: /<a href="(?<url>\/jyxx\/[^"]+\/20\d{6}\/[^"]+\.html)"[^>]*title="(?<title>[^"]+)"[\s\S]{0,600}?ewb-ndate">\s*(?<date>20\d{2}-\d{2}-\d{2})/
  }
];

/* 公告类型：省级子站列表混排「项目报建 / 招标公告 / 评标结果 / 中标结果 / 澄清」，
   标题里通常写明类型，这里按关键词归类（与前端 typeInfo 的判定口径一致） */
function guessType(title, fallback) {
  const t = String(title || '');
  if (/中标候选/.test(t)) return '中标候选公示';
  if (/(中标|成交)结果|中标公告|成交公告/.test(t)) return '中标公告';
  if (/评标结果/.test(t)) return '评标结果公示';
  if (/答疑/.test(t)) return '答疑公告';
  if (/澄清/.test(t)) return '澄清公告';
  if (/更正/.test(t)) return '更正公告';
  if (/变更/.test(t)) return '变更公告';
  if (/延期/.test(t)) return '延期公告';
  if (/流标|废标|采购失败/.test(t)) return '流标公告';
  if (/终止/.test(t)) return '终止公告';
  if (/资格预审/.test(t)) return '资格预审公告';
  if (/单一来源/.test(t)) return '单一来源公示';
  if (/磋商/.test(t)) return '磋商公告';
  if (/谈判/.test(t)) return '谈判公告';
  if (/询价/.test(t)) return '询价公告';
  if (/竞价/.test(t)) return '竞价公告';
  if (/比选/.test(t)) return '比选公告';
  if (/遴选/.test(t)) return '遴选公告';
  if (/采购公告|采购项目/.test(t)) return '采购公告';
  if (/项目报建|报建公告/.test(t)) return '项目报建公告';
  if (/招标公告/.test(t)) return '招标公告';
  return fallback || '招标公告';
}

/* ---------------- 湖北地市：省公共资源交易云平台的市级子站 ----------------
 * 与省本级同一套模板：/{slug}/jyxx/aboutccgs.html 是第一页，/{slug}/jyxx/{n}.html 是第 n 页。
 * 列表把报建、招标、评标、中标、澄清混在一起，公告类型交给 guessType 按标题判断。
 * 每页约 20 条、约 5 天，日常每站抓 3 页（≈15 天）足够，回补时用 CITY_PAGES 调大。
 */
const CITY_SUBSITES = [
  { slug: 'shiyan',      code: 'shiyan-ggzy',      name: '十堰市公共资源交易中心',   region: '湖北十堰' },
  { slug: 'jingmen',     code: 'jingmen-ggzy',     name: '荆门市公共资源交易中心',   region: '湖北荆门' },
  { slug: 'xiaogan',     code: 'xiaogan-ggzy',     name: '孝感市公共资源交易信息网', region: '湖北孝感' },
  { slug: 'huanggang',   code: 'huanggang-ggzy',   name: '黄冈市公共资源交易中心',   region: '湖北黄冈' },
  { slug: 'xianning',    code: 'xianning-ggzy',    name: '咸宁市公共资源交易信息网', region: '湖北咸宁' },
  { slug: 'suizhou',     code: 'suizhou-ggzy',     name: '随州市公共资源交易网',     region: '湖北随州' },
  { slug: 'xiantao',     code: 'xiantao-ggzy',     name: '仙桃市公共资源交易中心',   region: '湖北仙桃' },
  { slug: 'tianmen',     code: 'tianmen-ggzy',     name: '天门市公共资源交易网',     region: '湖北天门' },
  { slug: 'qianjiang',   code: 'qianjiang-ggzy',   name: '潜江市公共资源交易中心',   region: '湖北潜江' },
  { slug: 'shennongjia', code: 'shennongjia-ggzy', name: '神农架林区公共资源交易中心', region: '湖北神农架' }
];
const CITY_PAGES = Math.max(1, parseInt(process.env.CITY_PAGES, 10) || 3);
const HBBID_ITEM = /<a href="(\/[a-z]+\/[^"]*\/20\d{6}\/[^"]+\.html)"[^>]*title="([^"]+)"[\s\S]{0,200}?wb-data-date">\s*(20\d{2}-\d{2}-\d{2})/g;

async function fetchCitySubsites() {
  const out = [];
  for (const s of CITY_SUBSITES) {
    let n = 0;
    for (let p = 1; p <= CITY_PAGES; p++) {
      const listUrl = p === 1
        ? 'https://www.hbbidcloud.cn/' + s.slug + '/jyxx/aboutccgs.html'
        : 'https://www.hbbidcloud.cn/' + s.slug + '/jyxx/' + p + '.html';
      const r = await httpGet(listUrl, 20000, true);
      if (!r.ok) { console.log('  ' + s.name + ' 第 ' + p + ' 页失败 ' + r.status); break; }
      const re = new RegExp(HBBID_ITEM.source, 'g');
      let m, k = 0;
      while ((m = re.exec(r.text))) {
        const title = htmlToText(m[2]).replace(/\s+/g, ' ').trim();
        if (!title || title.length < 6) continue;
        const url = new URL(m[1], 'https://www.hbbidcloud.cn').toString();
        out.push({
          title: title,
          url: url,
          publishTime: m[3],
          source: s.code,
          region: s.region,
          noticeType: guessType(title),
          tenderer: ''
        });
        k++; n++;
      }
      await sleep(250);
      if (!k) break;
    }
    console.log('  ' + s.name + ' → ' + n + ' 条（' + CITY_PAGES + ' 页上限）');
  }
  return out;
}

async function fetchSites() {
  const out = [];
  for (const s of SITE_SOURCES) {
    let n = 0;
    for (const item of s.listUrls) {
      const listUrl = typeof item === 'string' ? item : item.url;
      const listType = (typeof item === 'object' && item.noticeType) || s.noticeType;
      const r = await httpGet(listUrl, 20000, true);
      if (!r.ok) { console.log('  ' + s.name + ' 列表失败 ' + r.status + ' ' + listUrl); continue; }
      const re = new RegExp(s.itemRe.source, 'g');
      let m, k = 0;
      while ((m = re.exec(r.text))) {
        const g = m.groups || {};
        const title = htmlToText(g.title || g.text || '').replace(/\s+/g, ' ').trim();
        const href = g.url || m[1] || '';
        if (!title || title.length < 6 || !href) continue;
        let date = g.date || m[3] || '';
        if (!date) {
          const tail = r.text.slice(m.index + m[0].length, m.index + m[0].length + 260);
          const dm = tail.match(/20\d{2}-\d{2}-\d{2}/);
          if (dm) date = dm[0];
        }
        out.push({
          title: title,
          url: new URL(href, s.base).toString(),
          publishTime: date,
          source: s.code,
          region: s.region,
          noticeType: listType,
          tenderer: ''
        });
        k++; n++;
      }
      console.log('  ' + s.name + ' [' + listUrl.replace(/^https?:\/\/[^/]+/, '') + '] → ' + k + ' 条');
      await sleep(300);
    }
    if (!n) console.log('  ' + s.name + ' 累计 0 条，请检查条目正则');
  }
  return out;
}

/* ---------------- 主流程 ---------------- */
(async () => {
  const cutoff = ymd(new Date(Date.now() - WINDOW_DAYS * 86400000));
  console.log('窗口：' + cutoff + ' 起，保留 ' + WINDOW_DAYS + ' 天');

  let prev = [];
  try {
    const old = JSON.parse(fs.readFileSync(OUT, 'utf8'));
    prev = Array.isArray(old.items) ? old.items : [];
    console.log('已有文件 ' + prev.length + ' 条，用于保留已抓到的正文');
  } catch (e) { console.log('无历史文件，首次生成'); }

  const hb = await fetchHubei();
  const wh = await fetchWuhan(3);
  const city = await fetchCitySubsites();
  const sites = await fetchSites();
  console.log('来源合计：省本级 ' + hb.items.length + ' / 武汉 ' + wh.length +
    ' / 地市 ' + city.length + ' / 高校与单位 ' + sites.length);

  // 合并：新抓的覆盖旧条目，但保留已有 snapshotText（避免重复抓正文）
  const map = new Map();
  prev.forEach((x) => { if (x && x.url) map.set(x.url, x); });
  [...hb.items, ...wh, ...city, ...sites].forEach((x) => {
    if (!x || !x.url || !x.title) return;
    const old = map.get(x.url) || {};
    map.set(x.url, Object.assign({}, old, x, {
      snapshotText: x.snapshotText || old.snapshotText || ''
    }));
  });

  const all = [...map.values()].filter((x) => {
    const d = String(x.publishTime || '').slice(0, 10);
    return !d || d >= cutoff;
  });
  all.sort((a, b) => String(b.publishTime).localeCompare(String(a.publishTime)));

  // 补详情：只补最近 3 天、还没有正文的条目；每个来源最多 5 条，避免某个站占满配额
  const recent = ymd(new Date(Date.now() - 3 * 86400000));
  const DETAIL_SOURCES = ['hbbidcloud', 'whu-zb', 'hust-cgzx', 'jingzhou-ggzy'];
  CITY_SUBSITES.forEach((s) => DETAIL_SOURCES.push(s.code));
  const quota = {};
  const need = all.filter((x) => {
    if (DETAIL_SOURCES.indexOf(x.source) < 0) return false;
    if (x.snapshotText) return false;
    if (String(x.publishTime || '') < recent) return false;
    quota[x.source] = (quota[x.source] || 0) + 1;
    return quota[x.source] <= 5;
  }).slice(0, MAX_DETAIL);
  console.log('待补详情 ' + need.length + ' 条');
  let done = 0;
  for (let i = 0; i < need.length; i += 3) {
    const batch = need.slice(i, i + 3);
    const rs = await Promise.all(batch.map((it) => enrichDetail(it).catch(() => false)));
    done += rs.filter(Boolean).length;
    await sleep(250);
  }
  console.log('补详情成功 ' + done + ' 条');

  const payload = {
    generatedAt: new Date().toISOString(),
    windowDays: WINDOW_DAYS,
    cutoff: cutoff,
    count: all.length,
    items: all
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(payload, null, 1) + '\n', 'utf8');
  const withText = all.filter((x) => x.snapshotText).length;
  console.log('写入 ' + OUT + '：' + all.length + ' 条（' + withText + ' 条带正文）');
})().catch((e) => { console.error('FATAL', e && e.stack || e); process.exit(1); });
