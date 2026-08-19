// content/extractor.js
// 提取页面信息并判断是否为目录页
// 两种入口：
//  1. 经 executeScript 注入目标页面，直接分析页面 document（返回值被 executeScript 捕获）；
//  2. 在后台 service worker 中 importScripts 加载，配合 DOMParser 分析
//     fetch 抓取的 HTML（注入不可用时的回退路径，如 HTTPS 优先模式拦截页）。
// 分类特征表统一来自 shared/classifier.js（随本文件一起注入 / importScripts）。

/**
 * 分析给定文档并返回提取结果
 * @param {Document} doc 待分析文档
 * @param {string} locHref 用于同页锚点比较的「当前地址」
 * @param {Function} tfn i18n 翻译函数
 */
function analyzeBookmarkDocument(doc, locHref, tfn) {
  'use strict';

  // 检测 Chrome 错误页面
  const body = doc.body;

  // 渲染中的文档用 innerText（自动排除 script/style 文本）；
  // DOMParser 解析的文档（defaultView 为 null）innerText 退化为 textContent，
  // 会把脚本源码计入正文导致错误签名误匹配，需手动剥离
  function plainText(node) {
    let s = '';
    const walk = (n) => {
      for (const c of n.childNodes) {
        if (c.nodeType === 3) s += c.nodeValue;
        else if (c.nodeType === 1 && !/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(c.tagName)) walk(c);
      }
    };
    walk(node);
    return s;
  }
  const bodyText = !body ? '' : (doc.defaultView ? body.innerText : plainText(body));

  // 人机验证页检测（优先于错误签名，避免误判为 403）。
  // 强/弱特征分级判定见 classifier.js：「请稍候」等弱文案单独命中不判验证页
  if (isChallengeDoc({
    title: doc.title || '',
    bodyText,
    htmlSnippet: body ? body.innerHTML.slice(0, 1500) : '',
  })) {
    return {
      title: doc.title || '',
      isDirectory: false,
      lastChapter: null,
      status: 'cf_challenge',
      message: tfn('cfMessage'),
    };
  }

  // Chrome 内部错误页 / 常见 HTTP 错误页的文本签名（特征表见 classifier.js）
  const errHit = detectErrorPage({
    bodyText,
    outerHtml: doc.documentElement ? doc.documentElement.outerHTML : '',
    linkCount: doc.querySelectorAll('a[href]').length,
  }, tfn);
  if (errHit) {
    return {
      title: doc.title || '',
      isDirectory: false,
      lastChapter: null,
      status: errHit.status,
      message: errHit.message,
    };
  }

  // 正常页面：提取目录信息
  const title = doc.title || '';
  const allLinks = Array.from(doc.querySelectorAll('a[href]'));

  // 章节匹配模式
  const chapterPatterns = [
    // 中文：第X章/话/回/节/集/卷/部/篇/话（含大写数字）
    /第[\s]*[\d一二三四五六七八九十百千万零壹贰叁肆伍陆柒捌玖拾〇]+[\s]*[章话回节集卷部篇]/,
    // 英文
    /(?:chapter|ch\.?|vol\.?|volume|ep\.?|episode|part)\s*\d+/i,
    // 日文
    /(?:第[\s]*[\d]+[\s]*[話章]|(?:CH|Ch)\.?\s*[\d]+)/,
    // 纯数字序号（如 001, 002 等，需至少3位）
    /^\s*\d{3,}\s*[-_.\s]/,
    // "XX话" 无第字
    /[\d]+[\s]*[话話]/,
    // 数字开头（可带短英文前缀）+ 中文标题，如 "668探墓"、"TBW36 父母心"；
    // 单看较宽松，靠密集列表的占比/数量门槛防误判
    /^\s*[A-Za-z]{0,6}\s*\d{1,4}\s*[、.．\-_：:，]?\s*[\u4e00-\u9fa5]/,
  ];

  /**
   * 判断链接文本是否匹配章节模式（含误判过滤）
   */
  function isChapterLink(link) {
    const text = (link.textContent || '').trim();
    if (!text || text.length > 200) return false;
    const cleaned = cleanLinkText(link);

    // 章节标题通常较短：过滤商品卡片、评分组件等超长文案
    if (cleaned.length > 40) return false;
    // 噪声字符：问号（FAQ 问题）、百分号/星（评分组件）
    if (/[\uff1f?%\u661f]/.test(cleaned)) return false;
    // 年份开头：博客归档/期刊链接（如 "2018年8月(3)"、"2024年10期"）
    if (/^(19|20)\d{2}/.test(cleaned)) return false;

    // 同页锚点（文章内小标题/目录）：章节必然跳转到不同页面
    const href = link.getAttribute('href') || '';
    if (!href || href.charAt(0) === '#' || /^javascript:/i.test(href)) return false;
    try {
      const target = new URL(link.href);
      const here = new URL(locHref);
      target.hash = '';
      here.hash = '';
      if (target.href === here.href) return false;
    } catch (e) {
      // URL 解析失败时继续按文本判断
    }

    return chapterPatterns.some(p => p.test(text));
  }

  /** 中文数字简易转换（仅处理常见情况，如 三百二十一） */
  function cnNumToInt(str) {
    const cnMap = { '零': 0, '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9, '十': 10, '百': 100, '千': 1000 };
    let num = 0;
    let current = 0;
    for (const ch of str.split('')) {
      const val = cnMap[ch];
      if (val === undefined) continue;
      if (val >= 10) {
        if (current === 0) current = 1;
        current *= val;
        num += current;
        current = 0;
      } else {
        current = val;
      }
    }
    return num + current;
  }

  /**
   * 从链接文本中提取章节序号。
   * 优先取「第N章 / Chapter N」这类结构化模式的最后一个匹配，
   * 避免取文中第一个数字（「第3季 第5章」会误取 3）；
   * 无结构化匹配时才回退取首个阿拉伯数字
   */
  function extractChapterNumber(text) {
    const structured = [
      // 中文/日文「第N章/话/回…」，取最后一个匹配（正文末尾的章节最具体）
      /第[\s]*(\d+|[\u4e00-\u9fa5]+)[\s]*[章话話回节節集卷部篇]/g,
      // 英文 chapter/ch/vol/episode + 数字
      /(?:chapter|ch\.?|vol\.?|volume|ep\.?|episode|part)\s*(\d+)/gi,
      // 无第字「XX话」
      /(\d+)[\s]*[话話]/g,
    ];
    for (const re of structured) {
      let m;
      let last = null;
      while ((m = re.exec(text)) !== null) last = m[1];
      if (last !== null) {
        return /^\d+$/.test(last) ? parseInt(last, 10) : cnNumToInt(last);
      }
    }

    // 回退：首个阿拉伯数字（如 "668探墓"、"TBW36 父母心"）
    const arabicMatch = text.match(/(\d+)/);
    if (arabicMatch) return parseInt(arabicMatch[1], 10);
    return null;
  }

  /** 清理链接文本：压缩空白、去掉（47P）这类页数后缀 */
  function cleanLinkText(link) {
    return (link.textContent || '').trim()
      .replace(/（\s*\d+\s*[Pp]）/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /** 单个章节列表内的最新一话：严格降序取首项，否则按首尾序号均值判升/降序 */
  function latestInList(chapters) {
    const numbered = chapters.filter((cl) => cl.number !== null);
    if (numbered.length >= 3) {
      let strictlyDescending = true;
      for (let i = 1; i < numbered.length; i++) {
        if (numbered[i].number >= numbered[i - 1].number) {
          strictlyDescending = false;
          break;
        }
      }
      if (strictlyDescending) return chapters[0];

      const head = numbered.slice(0, 3);
      const tail = numbered.slice(-3);
      const headAvg = head.reduce((s, cl) => s + cl.number, 0) / head.length;
      const tailAvg = tail.reduce((s, cl) => s + cl.number, 0) / tail.length;
      return tailAvg >= headAvg ? chapters[chapters.length - 1] : chapters[0];
    }
    return chapters[chapters.length - 1];
  }

  /**
   * 密集章节列表检测：容器内大部分链接都是章节链接。
   * 只看局部列表，不受整页导航链接噪声影响；
   * 对章节数少的小作品同样有效。
   * 容量上限放宽到 3000，避免超长篇目录（>600 章）漏判主路径
   */
  function findChapterLists() {
    const containers = Array.from(doc.querySelectorAll(
      'ul, ol, [class*="chapter"], [class*="list"], [class*="catalog"], [class*="directory"]'));
    const candidates = [];
    for (const container of containers) {
      const links = Array.from(container.querySelectorAll('a[href]'));
      if (links.length < 3 || links.length > 3000) continue;
      const chapters = [];
      for (const link of links) {
        if (isChapterLink(link)) {
          const text = cleanLinkText(link);
          chapters.push({ element: link, text, number: extractChapterNumber(text) });
        }
      }
      if (chapters.length >= 3 && chapters.length / links.length >= 0.6) {
        candidates.push({ container, chapters });
      }
    }
    // 去掉包裹了其他候选的外层容器，保留最内层密集列表
    return candidates.filter((c) =>
      !candidates.some((o) => o !== c && c.container.contains(o.container)));
  }

  /**
   * 判断页面是否为目录页
   * 策略：优先找密集章节列表；找不到再退回全局占比/数量评分
   */
  function analyzeDirectory() {
    // 1) 密集章节列表：每列表取最新一话，再跨列表取序号最大者
    const lists = findChapterLists();
    if (lists.length > 0) {
      let best = null;
      for (const list of lists) {
        const latest = latestInList(list.chapters);
        if (!best || (latest.number !== null && (best.number === null || latest.number > best.number))) {
          best = latest;
        }
      }
      return { isDirectory: true, lastChapter: best.text };
    }

    // 2) 回退：全局评分（无列表容器的页面）
    if (allLinks.length < 5) {
      return { isDirectory: false, lastChapter: null };
    }

    const chapterLinks = [];

    for (const link of allLinks) {
      if (isChapterLink(link)) {
        const text = cleanLinkText(link);
        const num = extractChapterNumber(text);
        chapterLinks.push({ element: link, text, number: num });
      }
    }

    const ratio = chapterLinks.length / allLinks.length;
    let score = 0;

    // 章节链接占比 > 30% 加分
    if (ratio > 0.5) score += 3;
    else if (ratio > 0.3) score += 2;
    else if (ratio > 0.15) score += 1;

    // 章节链接绝对数量
    if (chapterLinks.length > 50) score += 3;
    else if (chapterLinks.length > 20) score += 2;
    else if (chapterLinks.length > 10) score += 1;

    // 检查是否在列表容器中（ul/ol 或其子 li 中）
    const listContainerLinks = chapterLinks.filter(cl =>
      cl.element.closest('ul, ol, .chapter-list, .list, .catalog, .directory, [class*="chapter"], [class*="list"], [class*="catalog"]')
    );
    if (listContainerLinks.length > chapterLinks.length * 0.5) score += 1;

    // 分数 >= 3 判定为目录页
    if (score < 3 || chapterLinks.length < 5) {
      return { isDirectory: false, lastChapter: null };
    }

    return { isDirectory: true, lastChapter: latestInList(chapterLinks).text };
  }

  const result = analyzeDirectory();

  return {
    title,
    isDirectory: result.isDirectory,
    lastChapter: result.lastChapter,
    status: 'success',
    message: result.isDirectory ? tfn('msgDirectory') : tfn('msgNonDirectory'),
  };
}

// 页面注入入口：仅在存在 document 时自动执行（executeScript 注入场景）；
// 后台 service worker 经 importScripts 加载时 document 为 undefined，
// 此时本文件只注册 analyzeBookmarkDocument 函数，供 fetch 回退路径调用。
(typeof document !== 'undefined' && document.body)
  ? analyzeBookmarkDocument(document, location.href, t)
  : null;
