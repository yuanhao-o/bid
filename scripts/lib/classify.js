'use strict';
/**
 * 公告类型与行业分类（抓取侧唯一口径）
 *
 * 为什么单独抽一个文件：
 *   抓取（fetch-notices.js）要写这两个字段，构建（build-data.js）要用它们过滤推送候选，
 *   两边如果各写一套，慢慢就会不一致。前端只读数据里的值，缺失时才用它自己那份轻量兜底。
 *
 * 判定顺序（重要）：
 *   类型：标题关键词 → URL 栏目码 → 来源默认值
 *   行业：项目编号行业段 → URL 栏目码二级 → 标题关键词 → 未分类
 *   为什么标题优先：源站自己也会把条目放错栏目（004001 报建栏目里混着「投资人遴选」）。
 *   标题里「…项目报建公告」是最硬的特征；标题判不出来（很多条目只有项目名）时，栏目码才最可靠。
 */

/* ---------------- 湖北公共资源交易云平台栏目码 ---------------- */
/* URL 形如 /shengbenji/jyxx/004002/004002003/20261111/uuid.html
   一级 6 位 = 业务类型，三级里前 6 位同一级、后 3 位 = 行业分类 */
const CAT_TYPE = {
  '004001': '项目报建公告',
  '004002': '招标公告',
  '004003': '答疑公告',
  '004004': '评标结果公示',
  '004005': '中标公告',
  '004006': '合同信息公示'
};
const SUB_INDUSTRY = {
  '001': '房建市政',
  '002': '水利',
  '003': '交通',
  '004': '铁路',
  '005': '土地整治',
  '006': '其它工程',
  '007': '政府采购'
};
/* 荆州公共资源交易网自己没有行业分类，只有 012001 工程建设 / 012002 政府采购 */
const JZ_TYPE = {
  '012001002': '招标公告',
  '012001004': '评标结果公示',
  '012001005': '中标公告',
  '012002001': '采购公告'
};

function parseCodes(url) {
  const u = String(url || '');
  const m = u.match(/\/jyxx\/(\d{6})\/(\d{9})\//);
  if (!m) return null;
  return { cat: m[1], sub: m[2].slice(6), full: m[1] + m[2].slice(6) };
}

/* ---------------- 来源主体：自建平台的招标人就是平台自己 ---------------- */
/* 高校自建的采购/招投标平台，公告由学校自己发布，招标人即该学校；
   省/市公共资源交易平台是第三方交易场所，招标人是具体公司或代理机构，不能套用这个兜底。 */
const SOURCE_OWNER = {
  'whu-zb': '武汉大学',
  'hust-cgzx': '华中科技大学',
  'whut-cgyztb': '武汉理工大学',
  'wust-cgpt': '武汉科技大学',
  'cug-cggl': '中国地质大学（武汉）',
  'ccnu-zb': '华中师范大学',
  'hzau-ztb': '华中农业大学',
  'hubu-ztb': '湖北大学',
  'jhun-cgyztb': '江汉大学'
};
function ownerOf(source) {
  return SOURCE_OWNER[String(source || '')] || '';
}

/* ---------------- 标题关键词（顺序即优先级） ----------------
   ★ 变更类（答疑/澄清/补遗/更正/变更/延期）必须排在阶段类（资格预审/评标/中标）之前。
     源站标题常常是「…工程（二次）第4次资审答疑」「中标结果更正公告」，
     先命中「资审」「中标」就会标成资格预审公告/中标公告，而它实际是答疑/更正。
     2026-11-12 修正：资格预审 34 条里有 11 条实为资审答疑。 */
const TITLE_RULES = [
  [/合同(信息)?(公示|公告|公开)/, '合同信息公示'],
  [/(流标|废标|采购失败|招标失败|竞价失败)/, '流标公告'],
  [/(终止|撤销|中止)(公告|公示|通知)?\s*$/, '终止公告'],
  [/(第\s*\d+\s*次)?\s*答疑/, '答疑公告'],
  [/澄清|补遗/, '澄清公告'],
  [/更正/, '更正公告'],
  [/变更公告|变更公示/, '变更公告'],
  [/延期/, '延期公告'],
  [/中标候选/, '中标候选公示'],
  [/评标结果|评标公示/, '评标结果公示'],
  [/(中标结果|中标公告|中标公示|中标通知|成交结果|成交公告|中选结果|中选公示|结果公告|结果公示)/, '中标公告'],
  [/资格预审|资格后审|资审/, '资格预审公告'],
  [/单一来源/, '单一来源公示'],
  [/竞争性磋商|磋商/, '磋商公告'],
  [/竞争性谈判|谈判/, '谈判公告'],
  [/询价/, '询价公告'],
  [/竞价/, '竞价公告'],
  [/比选/, '比选公告'],
  [/遴选/, '遴选公告'],
  [/项目报建|报建公告/, '项目报建公告'],
  [/招标公告|施工招标|采购公告|招标$/, '招标公告']
];

function typeFromTitle(title) {
  const t = String(title || '');
  for (const [re, label] of TITLE_RULES) if (re.test(t)) return label;
  return '';
}

/* 栏目码兜底：004003 是「澄清/答疑」混合栏目，再按标题细分一次 */
function typeFromCode(codes) {
  if (!codes) return '';
  if (JZ_TYPE[codes.full]) return JZ_TYPE[codes.full];
  const base = CAT_TYPE[codes.cat];
  if (!base) return '';
  if (codes.cat === '004003') {
    if (/答疑/.test(String(codes._t || ''))) return '答疑公告';
    return '澄清公告';
  }
  return base;
}

/* ---------------- 行业 ---------------- */
/* 项目编号里的行业段：HBSJ-202611FJ-023、JZSJ-202611FJ-01、HBXT-202610GT-01…
   字母含义按湖北平台惯例：FJ 房建 / SZ 市政 / GL 公路（交通）/ SL 水利 / TL 铁路 / GT 国土整治 / QT 其它 */
const ID_INDUSTRY = {
  FJ: '房建', SZ: '市政', GL: '交通', SL: '水利', TL: '铁路', GT: '土地整治', QT: '其它工程'
};
const ID_RX = /(?:[A-Z]{2,4}[-\u2014]?\d{6}|\d{6})([A-Z]{2})[-\d]/;

function industryFromId(text) {
  const m = String(text || '').match(ID_RX);
  if (!m) return '';
  return ID_INDUSTRY[m[1]] || '';
}

/* 标题 / 摘要兜底：只在既没有编号段、也没有栏目码时使用，宁少不错。
   ★ 关键教训（2026-11-11）：只看「医院 / 学校 / 食堂 / 图书馆」这类建筑名词会把
     「校医院采购支气管镜」「监狱食堂生鲜采购」全判成房建。房建的本质是「有施工动作」，
     所以先要求命中工程动词（ENGINE_WORDS），建筑名词只用来加分。 */
const ENGINE_WORDS = /(施工|总承包|EPC|改扩建|装修|装饰|改造|加固|幕墙|机电安装|土建|修缮|维修工程|维修项目|整治)/;
const HOUSE_WORDS = /(住宅|公寓|宿舍|厂房|车间|教学楼|实训楼|图书馆|体育馆|场馆|综合楼|办公楼|写字楼|商务楼|酒店|宾馆|医院|卫生院|学校|幼儿园|养老|食堂|展厅|博物馆|档案馆|实验室|老旧小区|棚户|保障房|安置房|人才公寓|房屋|人防|地下车库|校区|病区|病房|门诊|礼堂|报告厅|楼)/;
const ROAD_WORDS = /(公路|高速|国道|省道|道路|桥梁|隧道|路面|交安|航道|码头|港口|铁路|轨道|地铁|站房|立交|涵洞|大道|[\u4e00-\u9fa5]{1,4}路[（(])/;
const WATER_WORDS = /(水利|水库|河道|堤防|泵站|水闸|灌区|防洪|排涝|水土保持|水系|流域|清淤|疏浚|水生态|水环境)/;
const MUNI_WORDS = /(管网|排水|污水|供水|燃气|热力|绿化|景观|人行道|路灯|停车|综合管廊|广场|市政|江滩|街|通道|出线|管线|电缆)/;
const SERVICE_WORDS = /(服务|采购|购置|租赁|咨询|检测|评估|监理|出版|印刷|运维|保洁|保安|物业|教材|设备|器材|物资|食材|药品|家具|服装)/;

/* 返回 '房建' / '交通' / '水利' / '货物服务' / ''（判不出来） */
function industryFromTitle(title) {
  const t = String(title || '');
  if (!t) return '';
  const build = ENGINE_WORDS.test(t);
  if (!build) return SERVICE_WORDS.test(t) ? '货物服务' : '';
  /* 有施工动作时，再排除「明明是路桥水利、只是带了栋楼」的情况 */
  if (ROAD_WORDS.test(t) && !/(房建|住宅|厂房|教学楼|宿舍|办公楼)/.test(t)) return '交通';
  if (WATER_WORDS.test(t)) return '水利';
  if (MUNI_WORDS.test(t) && !HOUSE_WORDS.test(t)) return '市政';
  return '房建';
}

/* 栏目码二级 → 行业。001「房建市政」这一栏在源站是混装的，
   用项目编号的 FJ/SZ 或标题里的市政特征再拆成房建 / 市政，避免前端出现含混的「房建市政」 */
function industryOf(item) {
  const it = item || {};
  const codes = parseCodes(it.url);
  const title = String(it.title || '');
  const fromId = industryFromId(title + ' ' + String(it.snapshotText || ''));
  if (codes && SUB_INDUSTRY[codes.sub]) {
    const base = SUB_INDUSTRY[codes.sub];
    if (base === '房建市政') {
      if (fromId === '房建' || fromId === '市政') return fromId;
      if (MUNI_WORDS.test(title) && !HOUSE_WORDS.test(title)) return '市政';
      return '房建';
    }
    return base;
  }
  if (fromId) return fromId;
  return industryFromTitle(title) || '未分类';
}

/* 公告类型 */
function typeOf(item) {
  const it = item || {};
  const codes = parseCodes(it.url);
  if (codes) codes._t = it.title;
  return typeFromTitle(it.title) || typeFromCode(codes) || it.noticeType || '招标公告';
}

/* ---------------- 推送口径：只推「房建 + 招标/澄清类公告」 ---------------- */
/* 房建 = 行业判定为「房建」。市政（道路管网）、交通、水利、铁路、土地整治一律不推。
   类型白名单：招标公告 + 答疑/澄清/更正/变更/补遗。
   为什么带答疑类：用户 2026-11-11 拍板「已推过的房建项目，之后出答疑/澄清要补推一条」。
   这些公告本身就挂在房建项目下，行业判定已经把它们圈住了，数量约 0.8 条/天，不会刷屏。
   中标、评标、合同公示、流标、报建这些仍然只进网页。 */
const PUSH_TYPES = {
  '招标公告': 1, '答疑公告': 1, '澄清公告': 1, '更正公告': 1, '变更公告': 1, '补遗公告': 1, '延期公告': 1
};

function isHouseBuild(item) {
  return industryOf(item) === '房建';
}
function isTenderNotice(item) {
  return typeOf(item) === '招标公告';
}
function isPushType(item) {
  return !!PUSH_TYPES[typeOf(item)];
}
/* 推送候选：类型与行业都过闸 */
function isPushCandidate(item) {
  return isPushType(item) && isHouseBuild(item);
}

module.exports = {
  parseCodes, typeOf, typeFromTitle, typeFromCode,
  industryOf, industryFromId, industryFromTitle,
  ownerOf,
  isHouseBuild, isTenderNotice, isPushType, isPushCandidate,
  CAT_TYPE, SUB_INDUSTRY, PUSH_TYPES, SOURCE_OWNER
};
