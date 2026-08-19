// shared/classifier.js
// 扫描结果的分类唯一事实源：验证页特征、错误页特征、net 错误码映射、
// 缓存可用性规则。同时供后台 service worker（importScripts）与
// 注入页面的提取脚本（executeScript files）使用。

// 结果状态枚举（UI 分组与报告统计依赖这些取值）
const SCAN_STATUS = {
  SUCCESS: 'success',
  NETWORK_ERROR: 'network_error',
  ACCESS_DENIED: 'access_denied',
  NOT_FOUND: 'not_found',
  SERVER_ERROR: 'server_error',
  TIMEOUT: 'timeout',
  CF_CHALLENGE: 'cf_challenge',
  PARSE_ERROR: 'parse_error',
  ERROR: 'error',
};

// 人机验证页特征：强特征单独命中即可判定；弱文案（加载占位页也常见）
// 需命中 ≥2 项或标题命中，避免把「请稍候」类过渡页误判为验证页
const CHALLENGE_MARKERS = {
  strong: [
    'cf-chl',
    'cf-turnstile',
    'challenge-platform',
    'teocaptchawidget', // 腾讯 TEO 人机验证（如 51cto）
    'just a moment',
    'checking your browser',
    'verify you are human',
    'attention required! | cloudflare',
    'performing security verification',
    '正在检查您的浏览器',
    '验证您是真人',
    '正在进行安全验证',
    '正在验证连接安全性',
    'verifying the safety of the connection',
  ],
  weak: ['请稍候'],
};

/**
 * 判断文档是否为验证页
 * @param {Object} info { title, bodyText, htmlSnippet }
 */
function isChallengeDoc(info) {
  const title = String(info.title || '').toLowerCase();
  const bodyText = String(info.bodyText || '');
  const snippet = (
    title + '|' +
    bodyText.slice(0, 500) + '|' +
    String(info.htmlSnippet || '')
  ).toLowerCase();

  if (CHALLENGE_MARKERS.strong.some((m) => snippet.includes(m))) return true;

  const weakHits = CHALLENGE_MARKERS.weak.filter((m) => snippet.includes(m)).length;
  return weakHits >= 2 || CHALLENGE_MARKERS.weak.some((m) => title.includes(m));
}

/**
 * 判断缓存条目的标题是否为验证页（作废旧版误缓存的「成功」记录）
 */
function isChallengeTitle(pageTitle) {
  return isChallengeDoc({ title: pageTitle, bodyText: '', htmlSnippet: '' });
}

/**
 * Chrome 内部错误页特征：ERR_* 模式只出现在 Chrome 自身的错误页中，
 * 正常网页的正文/HTML 不会包含这些字符串，全文匹配始终可靠
 */
const CHROME_ERROR_SIGNATURES = [
  { pattern: /ERR_NAME_NOT_RESOLVED/, status: 'network_error', key: 'errDns' },
  { pattern: /ERR_CONNECTION_REFUSED/, status: 'network_error', key: 'errConnRefused' },
  { pattern: /ERR_CONNECTION_TIMED_OUT/, status: 'timeout', key: 'errConnTimeout' },
  { pattern: /ERR_CONNECTION_RESET/, status: 'network_error', key: 'errConnReset' },
  { pattern: /ERR_INTERNET_DISCONNECTED/, status: 'network_error', key: 'errOffline' },
  { pattern: /ERR_SSL_PROTOCOL_ERROR/, status: 'network_error', key: 'errSsl' },
  { pattern: /ERR_CERT_/i, status: 'network_error', key: 'errCert' },
];

/**
 * HTTP 错误页特征：403/404/5xx 等文本可能出现在正常文章中
 * （代码示例、错误说明等），必须配合小页面门控才判定
 */
const HTTP_ERROR_SIGNATURES = [
  { pattern: /403 Forbidden/i, status: 'access_denied', key: 'err403' },
  { pattern: /Access Denied/i, status: 'access_denied', key: 'err403' },
  { pattern: /404 Not Found/i, status: 'not_found', key: 'err404' },
  { pattern: /Page Not Found/i, status: 'not_found', key: 'err404' },
  { pattern: /500 Internal Server Error/i, status: 'server_error', key: 'err500' },
  { pattern: /502 Bad Gateway/i, status: 'server_error', key: 'err502' },
  { pattern: /503 Service Unavailable/i, status: 'server_error', key: 'err503' },
  { pattern: /504 Gateway Timeout/i, status: 'server_error', key: 'err504' },
];

/**
 * 检测页面是否为错误页
 * @param {Object} info { bodyText, outerHtml, linkCount }
 * @param {Function} tfn i18n 翻译函数
 * @returns {{status: string, message: string}|null}
 */
function detectErrorPage(info, tfn) {
  // Chrome 内部错误页（ERR_*）：只出现在 chrome-error:// 页面，
  // 正常网页不会包含这些字符串，全文匹配始终可靠
  for (const sig of CHROME_ERROR_SIGNATURES) {
    if (sig.pattern.test(info.bodyText)
      || sig.pattern.test(info.outerHtml)) {
      return { status: sig.status, message: tfn(sig.key) };
    }
  }

  // HTTP 错误页（403/404/5xx 等）：正常文章可能提及「403 Forbidden」
  // （代码示例、安全说明等），必须限制为内容极少且几乎无链接的典型错误页
  const smallPage = info.bodyText.length < 2000 && info.linkCount < 10;
  if (smallPage) {
    for (const sig of HTTP_ERROR_SIGNATURES) {
      if (sig.pattern.test(info.bodyText)
        || sig.pattern.test(info.outerHtml)) {
        return { status: sig.status, message: tfn(sig.key) };
      }
    }
  }

  return null;
}

/**
 * net 错误码 → 可读诊断。
 * fetch 失败时只会抛含糊的 TypeError('Failed to fetch')，且 webRequest
 * 不会为扩展自身请求触发，具体错误码（DNS/连接/SSL）靠
 * chrome.webNavigation.onErrorOccurred 从标签页导航侧捕获
 */
const NET_ERROR_RULES = [
  { pattern: /ERR_NAME_NOT_RESOLVED/, status: 'network_error', key: 'errDns' },
  { pattern: /ERR_CONNECTION_REFUSED/, status: 'network_error', key: 'errConnRefused' },
  { pattern: /ERR_CONNECTION_TIMED_OUT|ERR_TIMED_OUT/, status: 'timeout', key: 'errConnTimeout' },
  { pattern: /ERR_CONNECTION_RESET/, status: 'network_error', key: 'errConnReset' },
  { pattern: /ERR_CONNECTION_CLOSED/, status: 'network_error', key: 'errConnClosed' },
  { pattern: /ERR_INTERNET_DISCONNECTED/, status: 'network_error', key: 'errOffline' },
  { pattern: /ERR_ADDRESS_UNREACHABLE/, status: 'network_error', key: 'errUnreachable' },
  { pattern: /ERR_SSL_|ERR_CERT_/, status: 'network_error', key: 'errSsl' },
  { pattern: /ERR_PROXY_/, status: 'network_error', key: 'errProxy' },
  { pattern: /ERR_BLOCKED_BY_CLIENT/, status: 'network_error', key: 'errBlocked' },
  { pattern: /ERR_EMPTY_RESPONSE/, status: 'network_error', key: 'errEmptyResponse' },
  { pattern: /ERR_TOO_MANY_REDIRECTS/, status: 'network_error', key: 'errRedirects' },
];

/**
 * 把 net 错误码映射为 { status, text }，text 为「文案（错误码）」
 * @param {Function} tfn i18n 翻译函数
 */
function classifyNetError(netErr, tfn) {
  const code = String(netErr).replace(/^net::/, '');
  for (const rule of NET_ERROR_RULES) {
    if (rule.pattern.test(netErr)) {
      return { status: rule.status, text: `${tfn(rule.key)}（${code}）` };
    }
  }
  return { status: 'network_error', text: code };
}

/**
 * 缓存可用性单一规则（读写两侧共用）：
 * 超时/人机验证/未知错误不缓存（环境性瞬时故障，重扫成本低）；
 * 目录页不缓存（每次重查才能追踪最新章节）；
 * 显式标记 noCache 的结果不缓存（如静态抓取的非目录结论）
 */
function isCacheable(result) {
  return !!result
    && result.status !== SCAN_STATUS.TIMEOUT
    && result.status !== SCAN_STATUS.CF_CHALLENGE
    && result.status !== SCAN_STATUS.ERROR
    && !result.isDirectory
    && !result.noCache;
}

// 缓存键归一化：与重复检测一致忽略末尾斜杠
function cacheKey(url) {
  return String(url || '').replace(/\/+$/, '');
}
