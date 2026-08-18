// content/extractor.js
// 注入到目标页面中执行，提取页面信息并判断是否为目录页
// 返回值会被 executeScript 的 Promise 捕获

(function () {
  'use strict';

  // 检测 Chrome 错误页面
  const body = document.body;
  const bodyText = body ? body.innerText : '';

  // Cloudflare 人机验证页检测（优先于错误签名，避免误判为 403）
  const cfSnippet = (
    (document.title || '') + '|' +
    bodyText.slice(0, 500) + '|' +
    (body ? body.innerHTML.slice(0, 1500) : '')
  ).toLowerCase();
  const cfMarkers = [
    'just a moment',
    'checking your browser',
    'verify you are human',
    'attention required! | cloudflare',
    'performing security verification',
    // 中文验证页
    '请稍候',
    '正在检查您的浏览器',
    '验证您是真人',
    '正在进行安全验证',
    'cf-chl',
    'cf-turnstile',
    'challenge-platform',
  ];
  if (cfMarkers.some((m) => cfSnippet.includes(m))) {
    return {
      title: document.title || '',
      isDirectory: false,
      lastChapter: null,
      status: 'cf_challenge',
      message: t('cfMessage'),
    };
  }

  // Chrome 内部错误页面的特征
  const errorSignatures = [
    { pattern: /ERR_NAME_NOT_RESOLVED/, status: 'network_error', message: 'DNS 解析失败' },
    { pattern: /ERR_CONNECTION_REFUSED/, status: 'network_error', message: '连接被拒绝' },
    { pattern: /ERR_CONNECTION_TIMED_OUT/, status: 'timeout', message: '连接超时' },
    { pattern: /ERR_CONNECTION_RESET/, status: 'network_error', message: '连接被重置' },
    { pattern: /ERR_INTERNET_DISCONNECTED/, status: 'network_error', message: '网络已断开' },
    { pattern: /ERR_SSL_PROTOCOL_ERROR/, status: 'network_error', message: 'SSL 协议错误' },
    { pattern: /ERR_CERT_/i, status: 'network_error', message: '证书错误' },
    { pattern: /403 Forbidden/i, status: 'access_denied', message: '403 禁止访问' },
    { pattern: /Access Denied/i, status: 'access_denied', message: '403 禁止访问' },
    { pattern: /404 Not Found/i, status: 'not_found', message: '404 页面不存在' },
    { pattern: /Page Not Found/i, status: 'not_found', message: '404 页面不存在' },
    { pattern: /500 Internal Server Error/i, status: 'server_error', message: '500 服务器错误' },
    { pattern: /502 Bad Gateway/i, status: 'server_error', message: '502 网关错误' },
    { pattern: /503 Service Unavailable/i, status: 'server_error', message: '503 服务不可用' },
    { pattern: /504 Gateway Timeout/i, status: 'server_error', message: '504 网关超时' },
  ];

  for (const sig of errorSignatures) {
    // 全文 HTML 匹配仅限内容极少且几乎无链接的页面（典型错误页）；
    // 避免正常页面的脚本/文案中提及错误字符串时被误判
    const smallPage = bodyText.length < 2000 && document.querySelectorAll('a[href]').length < 10;
    if (sig.pattern.test(bodyText) || (smallPage && sig.pattern.test(document.documentElement.outerHTML))) {
      return {
        title: document.title || '',
        isDirectory: false,
        lastChapter: null,
        status: sig.status,
        message: sig.message
      };
    }
  }

  // 正常页面：提取目录信息
  const title = document.title || '';
  const allLinks = Array.from(document.querySelectorAll('a[href]'));

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
   * 判断链接文本是否匹配章节模式
   */
  function isChapterLink(link) {
    const text = (link.textContent || '').trim();
    if (!text || text.length > 200) return false;
    return chapterPatterns.some(p => p.test(text));
  }

  /**
   * 从链接文本中提取章节序号
   */
  function extractChapterNumber(text) {
    // 阿拉伯数字
    const arabicMatch = text.match(/(\d+)/);
    if (arabicMatch) return parseInt(arabicMatch[1], 10);

    // 中文数字（简易转换，仅处理常见情况）
    const cnMap = { '零': 0, '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9, '十': 10, '百': 100, '千': 1000 };
    const cnMatch = text.match(/第[\s]*([一二三四五六七八九十百千万零]+)[\s]*[章话回节集卷部篇話]/);
    if (cnMatch) {
      let num = 0;
      const chars = cnMatch[1].split('');
      let current = 0;
      for (const ch of chars) {
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
      num += current;
      return num;
    }

    return null;
  }

  /** 清理链接文本：压缩空白、去掉（47P）这类页数后缀 */
  function cleanLinkText(link) {
    return (link.textContent || '').trim()
      .replace(/（\s*\d+\s*[Pp]）/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /** 单个章节列表内的最新一话：按首尾序号判断升/降序 */
  function latestInList(chapters) {
    const numbered = chapters.filter((cl) => cl.number !== null);
    if (numbered.length >= 3) {
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
   */
  function findChapterLists() {
    const containers = Array.from(document.querySelectorAll(
      'ul, ol, [class*="chapter"], [class*="list"], [class*="catalog"], [class*="directory"]'));
    const candidates = [];
    for (const container of containers) {
      const links = Array.from(container.querySelectorAll('a[href]'));
      if (links.length < 3 || links.length > 600) continue;
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
    message: result.isDirectory ? '目录页，已提取最后一话' : '非目录页'
  };
})();
