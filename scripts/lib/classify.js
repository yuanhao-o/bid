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
  [/(流标|废标|采购失败|招标失败|竞价失败|招标异常|采购异常|异常公告)/, '流标公告'],
  [/(终止|撤销|中止)(公告|公示|通知)?\s*$/, '终止公告'],
  [/(第\s*\d+\s*次)?\s*答疑/, '答疑公告'],
  [/澄清|补遗/, '澄清公告'],
  [/更正/, '更正公告'],
  [/变更公告|变更公示/, '变更公告'],
  [/延期/, '延期公告'],
  [/中标候选|候选人公示/, '中标候选公示'],
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

/* ---------------- 业务类型：这活儿是施工、监理还是设计 ----------------
   和 industry 正交：industry 说「项目属于哪个行业」（房建/水利/交通…），
   workType 说「这次招的是什么活儿」。两者不能互相塞，否则「图书馆监理服务」
   要么被标成房建、要么被标成服务，都丢掉了用户最关心的信息。

   单值互斥，按数组顺序取第一个命中；判不出来写「未识别」，不硬猜。
   顺序要点：
     · 专业服务（EPC/监理/设计/勘察/咨询/检测）在「施工」之前——
       「××改造工程监理服务」必须归监理，不能因为标题里有「改造」就归施工。
     · 「施工」在「设备货物」「服务」之前——
       「××设备采购及安装施工」是施工活，不能被「设备」这个词抢走。
     · skip 用来挡住机构名/平台名里的同形词：艺术与设计学院、测绘遥感实验室、
       检测试剂采购、物流集团有限公司，这些都不是对应业务。 */
const WORK_TYPE_RULES = [
  { label: 'EPC/总承包', re: /EPC|ＥＰＣ|设计施工一体化|设计采购施工|工程总承包|施工总承包|总承包|勘察设计施工一体化/i },
  { label: '监理', re: /监理|总监办|监理工程师/ },
  { label: '设计', re: /方案设计|初步设计|施工图设计|设计服务|设计咨询|规划设计|建筑设计|图纸设计|深化设计|勘察设计|概算|设计(?!施工一体化|学院|研究院|系|中心|艺术)/i },
  { label: '勘察', re: /勘察|勘测|地质勘查|岩土|物探|测绘(?!遥感|科学|学院|实验室)|测绘服务|地形测绘|工程测绘|详勘/ },
  { label: '咨询/造价', re: /造价|咨询|项目管理|招标代理|代建|可行性研究|可研|审计|预算编制|清单编制|结算审核|成效评估|环境影响评估|节能评估|风险评估|资产评估|评估服务/ },
  { label: '检测', re: /工程监测|第三方监测|沉降监测|结构监测|检测|试验检测|检测试验|质量鉴定|安全鉴定|房屋鉴定|检定|探伤/,
    skip: /(检验|检测)试剂|试剂(采购|购置|一批)/ },
  { label: '施工', re: /施工|改造|装修|裝修|装饰|裝飾|维修|維修|修缮|整治|加固|幕墙|土建|拆除|新建|扩建|绿化|綠化|铺设|安装工程|景观工程|园林工程|建设项目|工程项目|建设工程/,
    skip: /平台建设|系统建设|信息化建设|课程建设|资源建设|数据库建设|数字化建设/ },
  { label: '设备货物', re: /货物|物资|耗材|试剂|仪器|家具|器材|设备|装置|机具|配件|备件|材料|沥青|钢材|水泥|管材|电缆|苗木|图书|办公用品|软件|数据库|电子期刊|数字资源|实训(中心|平台|室|基地)|系统(购置|采购|集成)/ },
  { label: '服务', re: /物业|运维|维保|维护保养|保洁|保安|培训|会务|展览|印刷|出版|保险|运输|物流服务|物流配送|物流运输|书刊物流|仓储服务|餐饮|托管|运营服务|维护服务|技术服务|数据服务|评价服务|测评|劳务|外包|软件开发|布展|课程建设|资源建设/ }
];
/* 面板里的显示顺序：与判定优先级一致，方便对照「为什么归到这一类」 */
const WORK_TYPES = WORK_TYPE_RULES.map((r) => r.label).concat('未识别');

/* 返回 { label, by }：by 是命中的词，前端 hover 可显示判定依据 */
function workTypeOf(item) {
  const t = String((item && item.title) || '');
  for (const rule of WORK_TYPE_RULES) {
    if (rule.skip && rule.skip.test(t)) continue;
    const m = t.match(rule.re);
    if (m) return { label: rule.label, by: m[0] };
  }
  return { label: '未识别', by: '' };
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
  workTypeOf, WORK_TYPES, WORK_TYPE_RULES,
  ownerOf,
  isHouseBuild, isTenderNotice, isPushType, isPushCandidate,
  CAT_TYPE, SUB_INDUSTRY, PUSH_TYPES, SOURCE_OWNER
};
