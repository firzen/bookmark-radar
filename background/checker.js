// background/checker.js
// 单个书签的检查管道：静态抓取 → 标签页导航 → 注入提取 → 验证重试 →
// 兜底决策表。各阶段产出归一化结果，阶段之间不互相嵌套。
// 依赖全局：loadTimeoutMs / humanVerifyEnabled（service-worker 定义），
// shared/i18n.js 与 shared/classifier.js 中的函数。

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 导航到目标 URL 并等待该次导航的页面加载完成。
 *
 * 复用标签页时，上一页的 `complete` 事件可能会在下一次 `tabs.update()` 后才
 * 到达。不能只按 tabId 判断，否则会把上一页的 DOM 当作当前书签来提取。
 * 这里先注册监听器，再发起导航，并要求本次导航至少出现过目标 URL，才接受
 * complete/readyState 信号；目标 URL 后的重定向仍会被允许。
 *
 * 除标签 status=complete 外，还会轮询 document.readyState：
 * 部分页面因广告/统计脚本挂起导致 load 永不触发（标签一直 loading），
 * 但 DOM 已解析完毕（readyState=interactive），此时内容已可提取，不应判为超时
 * @param {string} expectedUrl - 本次导航请求的目标 URL
 */
function navigateAndWaitForTabComplete(tabId, expectedUrl, timeoutMs = 30000) {
  return new Promise((resolve) => {
    let resolved = false;

    // 忽略 hash 差异：Chrome 有时会在导航过程中省略或单独处理 fragment。
    const isExpectedUrl = (url) => {
      if (!url) return false;
      try {
        const actual = new URL(url);
        const expected = new URL(expectedUrl);
        actual.hash = '';
        expected.hash = '';
        return actual.href === expected.href;
      } catch (e) {
        return url === expectedUrl;
      }
    };

    let sawTargetUrl = false;
    let targetDocumentStarted = false;

    const listener = async (updatedTabId, changeInfo) => {
      if (updatedTabId !== tabId) return;

      // 看到目标 URL 表明后续即使跳转到其他地址，仍属于本次导航。
      if (changeInfo.url && isExpectedUrl(changeInfo.url)) {
        sawTargetUrl = true;
        targetDocumentStarted = true;
      }

      if (changeInfo.status === 'loading') {
        try {
          const tab = await chrome.tabs.get(tabId);
          if (isExpectedUrl(tab.url) || isExpectedUrl(tab.pendingUrl)) {
            sawTargetUrl = true;
            targetDocumentStarted = true;
          }
        } catch (e) {
          // 标签页可能已关闭，超时逻辑会负责结束等待。
        }
      }

      if (changeInfo.status === 'complete' && sawTargetUrl && targetDocumentStarted) {
        cleanup();
        resolve(true);
      }
    };

    const cleanup = () => {
      if (resolved) return;
      resolved = true;
      chrome.tabs.onUpdated.removeListener(listener);
      clearInterval(readyStatePoller);
      clearTimeout(timer);
    };

    // 轮询 readyState：导航未提交/跨源重定向中注入会失败，忽略继续
    const readyStatePoller = setInterval(async () => {
      try {
        // 新导航尚未提交时，不能对上一份文档的 readyState 做出反应。
        if (!targetDocumentStarted) return;
        const tab = await chrome.tabs.get(tabId);
        if (!/^https?:/.test(tab.url)) return;
        const [res] = await chrome.scripting.executeScript({
          target: { tabId },
          func: () => document.readyState,
        });
        if (res && (res.result === 'interactive' || res.result === 'complete')) {
          cleanup();
          resolve(true);
        }
      } catch (e) {
        // 页面尚未提交导航或已关闭，下一轮再试
      }
    }, 1000);

    const timer = setTimeout(() => {
      cleanup();
      resolve(false);
    }, timeoutMs);

    chrome.tabs.onUpdated.addListener(listener);

    // 必须在监听器注册完成后才发起导航，避免漏掉极快页面的 URL/loading 事件。
    chrome.tabs.update(tabId, { url: expectedUrl }).catch(() => {
      if (!resolved) {
        cleanup();
        resolve(false);
      }
    });
  });
}

/**
 * 注入提取脚本（带超时保护）。
 * 页面导航卡住未提交时 executeScript 会无限等待，这里兑底返回 null。
 * classifier 需在 extractor 之前注入（extractor 调用其分类函数）
 */
function injectExtractor(tabId, timeoutMs = 15000) {
  return Promise.race([
    chrome.scripting.executeScript({
      target: { tabId },
      files: ['shared/i18n.js', 'shared/classifier.js', 'content/extractor.js'],
    }),
    new Promise((resolve) => setTimeout(() => resolve(null), timeoutMs)),
  ]);
}

/**
 * 临时把标签切到前台：Cloudflare 质询依赖 rAF，后台标签被暂停无法通过
 */
async function activateTabForChallenge(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    await chrome.tabs.update(tabId, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
  } catch (e) {
    console.warn('[Bookmark Radar] 激活标签失败:', e.message);
  }
}

/**
 * 后台抓取静态分析：http 书签的首选路径（不受 HTTPS 优先拦截页影响，且更快），
 * 也是 https 标签页路径不可用（注入失败/超时）时的回退。
 * 直接在 SW 里 fetch HTML 并用 DOMParser 分析；静态分析不执行 JS，
 * 对服务端渲染的页面有效，JS 渲染的列表识别不出（调用方会视情况用标签页复核）
 */
async function fetchAndAnalyze(bookmark) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(loadTimeoutMs, 30000));
    const resp = await fetch(bookmark.url, {
      redirect: 'follow',
      credentials: 'omit',
      signal: controller.signal,
      // SW 默认 UA 含 ServiceWorker 字样，会被部分站点的反爬直接拒绝（如 51cto 返回 567）
      headers: { 'User-Agent': navigator.userAgent.replace(/ServiceWorker/g, '') },
    });
    clearTimeout(timer);

    if (!resp.ok) {
      if (resp.status === 404) return { status: 'not_found', message: t('err404') };
      if (resp.status === 403) return { status: 'access_denied', message: t('err403') };
      if (resp.status >= 500) return { status: 'server_error', message: t('errServerGeneric', [String(resp.status)]) };
      return { status: 'access_denied', message: t('errAccessGeneric', [String(resp.status)]) };
    }

    const buf = await resp.arrayBuffer();
    // 先用 latin1 无损解码嗅探 charset，再按真实 charset 重新解码（老 http 站点常用 gbk 等）
    const raw = new TextDecoder('latin1').decode(buf);
    const charsetMatch = /charset=["']?([\w-]+)/i.exec(
      (resp.headers.get('content-type') || '') + '|' + raw.slice(0, 2000)
    );
    let html = raw;
    if (charsetMatch && !/^utf-?8$/i.test(charsetMatch[1])) {
      try {
        html = new TextDecoder(charsetMatch[1]).decode(buf);
      } catch (e) {
        // 遇到不认识的 charset 时保持 latin1 结果
      }
    }

    const parsed = new DOMParser().parseFromString(html, 'text/html');
    // 补 base 让相对链接按原地址解析，保证同页锚点判断正确
    const base = parsed.createElement('base');
    base.href = bookmark.url;
    (parsed.head || parsed.documentElement).appendChild(base);

    const analyzed = analyzeBookmarkDocument(parsed, bookmark.url, t);
    return {
      pageTitle: analyzed.title,
      isDirectory: analyzed.isDirectory,
      lastChapter: analyzed.lastChapter,
      status: analyzed.status,
      message: `${analyzed.message}${t('staticFetchSuffix')}`,
      // 静态分析不执行 JS，非目录结论可能不准，不缓存避免污染 30 天
      noCache: !analyzed.isDirectory,
    };
  } catch (e) {
    console.warn('[Bookmark Radar] 后台抓取回退失败:', bookmark.url, e.message);
    // 网络层失败不吞掉：转成具体诊断。
    // fetchFailed 标记区分「拿到 HTTP 响应的结论」与「纯网络层失败」，
    // 后者仅在标签页确实落在错误页时才可定论（避免误伤注入失败但网络可达的页面）
    if (e.name === 'AbortError') {
      return { status: 'timeout', fetchFailed: true, message: `${t('loadTimeoutMsg')}${t('staticFetchSuffix')}` };
    }
    // 优先用标签页导航侧捕获的具体 net 错误码（由调用方传入的 message 覆盖），
    // 拿不到才用 fetch 的含糊报错
    return { status: 'network_error', fetchFailed: true, message: `${t('netErrorPrefix')}${t('staticFetchSuffix')}：${e.message || 'Failed to fetch'}` };
  }
}

/**
 * 标签页是否落在浏览器错误页（DNS 失败/SSL 错误等导致 chrome-error://）。
 * 错误页是特权页，注入必然失败；此时后台 fetch 的网络诊断可作为定论依据。
 */
async function isTabOnErrorPage(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    return /^chrome-error:/.test(tab.url || '');
  } catch (e) {
    return false;
  }
}

/**
 * 验证页重试：按配置轮询重注入，直到质询通过或次数用尽
 */
async function retryChallenge(tabId, extracted, attempts, intervalMs) {
  let final = extracted;
  for (let attempt = 0; final.status === 'cf_challenge' && attempt < attempts; attempt++) {
    await delay(intervalMs);
    try {
      const retry = await injectExtractor(tabId);
      const retryResult = retry && retry[0] && retry[0].result;
      if (!retryResult) break;
      final = retryResult;
    } catch (e) {
      break; // 页面正在跳转或标签已关闭，退出重试
    }
  }
  return final;
}

/**
 * 人机验证处理：真人验证模式与默认后台等待仅重试参数不同
 */
async function resolveChallenge(tabId, extracted) {
  if (extracted.status !== 'cf_challenge') return extracted;
  if (humanVerifyEnabled) {
    // 后台标签 rAF 被暂停、质询跑不完：临时把该标签切到前台等质询通过
    await activateTabForChallenge(tabId);
    return retryChallenge(tabId, extracted, 10, 2000);
  }
  // 默认路径：后台等待重试（JS 质询在后台通常跑不完，最终记为人机验证）
  return retryChallenge(tabId, extracted, 3, 4000);
}

/**
 * 单地址检查管道（不负责创建/关闭标签页）：
 * 1. 静态抓取（http 首选）：仅「确认目录」直接定论，其余交标签页复核
 * 2. 标签页导航 + 注入提取
 * 3. 验证页重试
 * 4. 兜底决策表：静态结果可信则采用；纯网络失败仅在错误页确认时定论
 * @param {string} target 实际导航/抓取的地址（http 升级重试时可能与书签 URL 不同）
 */
async function checkUrlPipeline(bookmark, target, tabId) {
  // 统一补齐结果外壳，避免各返回点重复字段（url 保留书签原地址）
  const done = (r) => ({
    bookmarkId: bookmark.id,
    bookmarkName: bookmark.title,
    url: bookmark.url,
    pageTitle: r.pageTitle || '',
    isDirectory: !!r.isDirectory,
    lastChapter: r.lastChapter || null,
    status: r.status,
    message: r.message,
    noCache: !!r.noCache,
  });

  // http 地址优先后台抓取：不受 HTTPS 优先拦截页影响，且更快。
  // 仅「静态确认目录」可直接定论（服务端渲染的列表静态/动态一致）；
  // 其余结论（非目录/HTTP 错误）一律交标签页复核——
  // 列表可能靠 JS 渲染，或站点反爬拒绝 fetch 但放行真实浏览器。
  const isHttp = /^http:/i.test(target);
  let staticResult = null;
  if (isHttp) {
    staticResult = await fetchAndAnalyze({ ...bookmark, url: target });
    if (staticResult && staticResult.isDirectory) return done(staticResult);
  }

  // 监听工作标签页导航的网络层错误：webNavigation.onErrorOccurred 会报告
  // 具体 net 错误码（DNS/连接/SSL）。webRequest 不会为扩展自身的 fetch 触发，
  // 只能从标签页导航侧捕获
  let navNetError = '';
  const navErrListener = (details) => {
    if (details.frameId === 0) navNetError = details.error || navNetError;
  };
  if (chrome.webNavigation && chrome.webNavigation.onErrorOccurred) {
    try {
      chrome.webNavigation.onErrorOccurred.addListener(navErrListener, { tabId });
    } catch (e) { /* 无 webNavigation 权限时退化为通用诊断 */ }
  }
  // 导航捕获到 net 错误时，给出带错误码的具体诊断
  const navDiag = () => {
    if (!navNetError) return null;
    const d = classifyNetError(navNetError, t);
    return { status: d.status, message: `${t('netErrorPrefix')}：${d.text}` };
  };

  // 兜底决策表（扁平）：
  // - 标签页路径不可用时复用已有 staticResult，避免重复抓取
  // - 拿到 HTTP 响应的结论可信，直接采用
  // - 纯网络层失败（fetchFailed）仅在标签页确实落在浏览器错误页时定论，
  //   否则返回 null 由调用方保留原错误
  // 注：无 tabs 权限且 <all_urls> 不覆盖 chrome-error:// 时 tab.url 读不到，
  // 调用方可通过注入异常文案（showing error page）传入判定结果
  const tryFetchFallback = async (tabShowsErrorPage = false) => {
    if (!staticResult) staticResult = await fetchAndAnalyze({ ...bookmark, url: target });
    if (!staticResult) return null;
    if (!staticResult.fetchFailed) return done(staticResult);
    if (tabShowsErrorPage || (await isTabOnErrorPage(tabId))) {
      // 优先用导航侧捕获的具体 net 错误码，拿不到才用 fetch 的含糊报错
      return done(navDiag() || staticResult);
    }
    return null;
  };

  try {
    // 导航并等待本次导航对应的文档完成，避免读取复用标签页中的上一页。
    const loaded = await navigateAndWaitForTabComplete(tabId, target, loadTimeoutMs);

    if (!loaded) {
      // 导航侧捕获到 net 错误时归为网络错误（带具体错误码），否则才是真超时
      return (await tryFetchFallback())
        || done(navDiag() || { status: 'timeout', message: t('loadTimeoutMsg') });
    }

    // 短暂延迟，确保 JS 渲染完成
    await delay(800);

    // 注入提取脚本（带超时保护）；
    // 特权拦截页（如 HTTPS 优先模式）注入会直接抛错，单独 catch。
    // 保留真实异常信息，避免用固定文案掩盖真实原因
    let results = null;
    let injectFailed = false;
    let injectErrMsg = '';
    try {
      results = await injectExtractor(tabId);
    } catch (e) {
      injectFailed = true;
      injectErrMsg = (e && e.message) || String(e);
    }

    if (results === null || injectFailed) {
      // 「Frame with ID 0 is showing error page」是 Chrome 的明确信号：
      // 标签正在显示错误页（DNS/SSL/连接失败），比读 tab.url 可靠
      // （无 tabs 权限时错误页的 url 读不到）
      const tabShowsErrorPage = /showing error page/i.test(injectErrMsg);
      const fb = await tryFetchFallback(tabShowsErrorPage);
      if (fb) return fb;
      if (!injectFailed) return done({ status: 'timeout', message: t('injectTimeoutMsg') });
      // 导航侧捕获到 net 错误时直接给出具体诊断（典型：DNS 失败导致的错误页）
      const nav = navDiag();
      if (nav) return done(nav);
      // 注入与后台抓取双双失败：合并两路诊断，
      // 不再用固定的「特权页」文案误导（真实原因多为网络不可达）
      const netHint = staticResult && staticResult.fetchFailed ? staticResult.message : '';
      return done({
        status: 'error',
        message: netHint
          ? t('extractFailMsg', [injectErrMsg, netHint])
          : `${t('injectErrorMsg')}: ${injectErrMsg}`,
      });
    }

    const extracted = results && results[0] && results[0].result;

    if (!extracted) {
      return (await tryFetchFallback()) || done({ status: 'parse_error', message: t('parseErrorMsg') });
    }

    const final = await resolveChallenge(tabId, extracted);

    return done({
      pageTitle: final.title,
      isDirectory: final.isDirectory,
      lastChapter: final.lastChapter,
      status: final.status,
      message: final.message,
    });
  } catch (error) {
    return done({ status: 'error', message: error.message || t('unknownError') });
  } finally {
    try { chrome.webNavigation.onErrorOccurred.removeListener(navErrListener); } catch (e) { /* 已移除 */ }
  }
}

/**
 * 单个书签检查入口（不负责创建/关闭标签页）。
 * http 书签在检查结论为网络层失败/超时（而非拿到 HTTP 响应的具体结论）时，
 * 升级成 https 重试一次：Chrome 全站 HTTPS 化后大量站点只保留 https 服务
 * （或强制跳转），用户手动打开时浏览器会自动升级协议所以能正常访问，
 * 而扩展按原 http 地址导航会直接拿到连接层错误（如 cnblogs 的
 * ERR_CONNECTION_CLOSED），不应误报为死链
 */
async function checkBookmark(bookmark, tabId) {
  const result = await checkUrlPipeline(bookmark, bookmark.url, tabId);

  if (!/^http:/i.test(bookmark.url)) return result;

  // 已拿到 HTTP 响应的具体结论（404/403/5xx/验证页/成功等）不做升级重试，
  // 说明 http 通道可用；仅连接层失败（network_error/timeout）才值得升级再试
  if (result.status !== 'network_error' && result.status !== 'timeout') return result;

  const upgraded = await checkUrlPipeline(bookmark, bookmark.url.replace(/^http:/i, 'https:'), tabId);
  if (upgraded.status === 'network_error' || upgraded.status === 'timeout') {
    // https 也不可达时保留 http 侧的原始诊断（更贴近书签本身的问题）
    return result;
  }
  return upgraded;
}
