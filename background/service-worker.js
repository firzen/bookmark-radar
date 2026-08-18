// background/service-worker.js
// 核心扫描调度：获取书签 → 后台标签页加载 → 注入提取脚本 → 收集结果

importScripts('../shared/i18n.js');

const DEFAULT_CONCURRENCY = 3; // 默认并发数

let humanVerifyEnabled = false; // 真人验证模式：验证页临时前台激活
let loadTimeoutMs = 30000; // 页面加载超时（默认 30 秒，popup 可配置）

// Cloudflare 验证页标题特征（用于作废旧版误缓存的「成功」记录）
const CF_TITLE_MARKERS = [
  'just a moment',
  'checking your browser',
  'verify you are human',
  'performing security verification',
  '请稍候',
  '正在检查您的浏览器',
  '验证您是真人',
  '正在进行安全验证',
];

// 启动时清除可能残留的角标（上次扫描中浏览器被关闭等场景）
chrome.action.setBadgeText({ text: '' });

let scanState = {
  isScanning: false,
  shouldStop: false,
  progress: 0,
  total: 0,
  currentBookmark: '',
  results: [],
  startTime: null,
};

// 监听来自 popup 的消息
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'startScan') {
    if (scanState.isScanning) {
      sendResponse({ error: t('scanRunning') });
      return false;
    }
    startScan(message.concurrency || DEFAULT_CONCURRENCY, !!message.force, !!message.humanVerify, message.timeout);
    sendResponse({ started: true });
  } else if (message.action === 'getScanStatus') {
    sendResponse({ ...scanState });
  } else if (message.action === 'getResults') {
    chrome.storage.local.get('scanResults', (data) => {
      sendResponse(data.scanResults || null);
    });
    return true; // 异步响应
  } else if (message.action === 'deleteBookmarks') {
    // 批量删除书签
    deleteBookmarks(message.ids).then(() => {
      sendResponse({ success: true });
    }).catch((err) => {
      sendResponse({ success: false, error: err.message });
    });
    return true; // 异步响应
  } else if (message.action === 'stopScan') {
    scanState.shouldStop = true;
    sendResponse({ stopped: true });
  } else if (message.action === 'rescanBookmarks') {
    // 条目级重扫：忽略缓存，只扫勾选的 URL
    if (scanState.isScanning) {
      sendResponse({ error: t('scanRunning') });
      return false;
    }
    rescanUrls(message.urls || [], message.concurrency, message.timeout)
      .then((r) => sendResponse(r));
    return true; // 异步响应
  }
  return false;
});

/**
 * 递归获取所有书签（过滤掉文件夹和无效 URL）
 */
function flattenBookmarks(nodes) {
  const bookmarks = [];
  for (const node of nodes) {
    if (node.url && /^https?:\/\//i.test(node.url)) {
      bookmarks.push({ id: node.id, title: node.title, url: node.url });
    }
    if (node.children) {
      bookmarks.push(...flattenBookmarks(node.children));
    }
  }
  return bookmarks;
}

/**
 * 查找重复书签（相同 URL 出现多次）
 */
function findDuplicates(nodes) {
  const allBookmarks = [];

  function walk(items) {
    for (const node of items) {
      if (node.url && /^https?:\/\//i.test(node.url)) {
        allBookmarks.push({ id: node.id, title: node.title, url: node.url });
      }
      if (node.children) walk(node.children);
    }
  }
  walk(nodes);

  // 按 URL 分组
  const urlMap = {};
  for (const bm of allBookmarks) {
    const key = bm.url.replace(/\/+$/, ''); // 忽略末尾斜杠
    if (!urlMap[key]) urlMap[key] = [];
    urlMap[key].push(bm);
  }

  // 返回出现 2 次及以上的组
  return Object.values(urlMap).filter((group) => group.length >= 2);
}

/**
 * 查找空文件夹（无书签或仅含空子文件夹）
 */
function findEmptyFolders(nodes) {
  const emptyFolders = [];

  function hasBookmarks(node) {
    if (node.url) return true;
    if (!node.children || node.children.length === 0) return false;
    return node.children.some(hasBookmarks);
  }

  function walk(items) {
    for (const node of items) {
      if (node.children && node.title) { // 有 title 说明是用户文件夹
        if (!hasBookmarks(node)) {
          emptyFolders.push({ id: node.id, title: node.title });
        }
        walk(node.children);
      }
    }
  }
  walk(nodes);

  return emptyFolders;
}

/**
 * 批量删除书签
 */
async function deleteBookmarks(ids) {
  for (const id of ids) {
    await chrome.bookmarks.removeTree(id);
  }
}

/**
 * 检查标签页是否仍然存在
 */
async function isTabAlive(tabId) {
  try {
    await chrome.tabs.get(tabId);
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * 等待标签页加载完成
 * 除标签 status=complete 外，还会轮询 document.readyState：
 * 部分页面因广告/统计脚本挂起导致 load 永不触发（标签一直 loading），
 * 但 DOM 已解析完毕（readyState=interactive），此时内容已可提取，不应判为超时
 * @param {string} [expectedUrl] - 目标 URL，立即检查时需匹配，避免读到上一轮的 complete 状态
 */
function waitForTabComplete(tabId, timeoutMs = 30000, expectedUrl = null) {
  return new Promise((resolve) => {
    let resolved = false;

    const listener = (updatedTabId, changeInfo) => {
      if (updatedTabId === tabId && changeInfo.status === 'complete') {
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
        // 守卫：新导航还没提交时读到的是上一份文档（如 about:blank）
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

    // 检查是否已经加载完成（必须匹配目标 URL，防止误读上一轮状态）
    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime.lastError || !tab) {
        cleanup();
        resolve(false);
        return;
      }
      if (tab.status === 'complete' && (!expectedUrl || tab.url === expectedUrl)) {
        cleanup();
        resolve(true);
      }
    });
  });
}

/**
 * 注入提取脚本（带超时保护）
 * 页面导航卡住未提交时 executeScript 会无限等待，这里兑底返回 null
 */
function injectExtractor(tabId, timeoutMs = 15000) {
  return Promise.race([
    chrome.scripting.executeScript({
      target: { tabId },
      files: ['shared/i18n.js', 'content/extractor.js'],
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
 * 提取单个书签页面内容（不负责创建/关闭标签页）
 */
async function processBookmark(bookmark, tabId) {
  try {
    // 导航到目标 URL
    await chrome.tabs.update(tabId, { url: bookmark.url });

    // 短暂等待导航开始（避免读到上一轮的 complete 状态）
    await new Promise((r) => setTimeout(r, 200));

    // 等待加载完成
    const loaded = await waitForTabComplete(tabId, loadTimeoutMs, bookmark.url);

    if (!loaded) {
      return {
        bookmarkId: bookmark.id,
        bookmarkName: bookmark.title,
        url: bookmark.url,
        pageTitle: '',
        isDirectory: false,
        lastChapter: null,
        status: 'timeout',
        message: t('loadTimeoutMsg'),
      };
    }

    // 短暂延迟，确保 JS 渲染完成
    await new Promise((r) => setTimeout(r, 800));

    // 注入提取脚本（带超时保护）
    const results = await injectExtractor(tabId);

    if (results === null) {
      return {
        bookmarkId: bookmark.id,
        bookmarkName: bookmark.title,
        url: bookmark.url,
        pageTitle: '',
        isDirectory: false,
        lastChapter: null,
        status: 'timeout',
        message: t('injectTimeoutMsg'),
      };
    }

    const extracted = results && results[0] && results[0].result;

    if (!extracted) {
      return {
        bookmarkId: bookmark.id,
        bookmarkName: bookmark.title,
        url: bookmark.url,
        pageTitle: '',
        isDirectory: false,
        lastChapter: null,
        status: 'parse_error',
        message: t('parseErrorMsg'),
      };
    }

    // Cloudflare 人机验证处理
    let final = extracted;
    if (final.status === 'cf_challenge' && humanVerifyEnabled) {
      // 真人验证模式：后台标签 rAF 被暂停、质询跑不完，
      // 临时把该标签切到前台等质询通过，通过后继续
      await activateTabForChallenge(tabId);
      for (let attempt = 0; final.status === 'cf_challenge' && attempt < 10; attempt++) {
        await new Promise((r) => setTimeout(r, 2000));
        try {
          const retry = await injectExtractor(tabId);
          const retryResult = retry && retry[0] && retry[0].result;
          if (!retryResult) break;
          final = retryResult;
        } catch (e) {
          break; // 页面正在跳转或标签已关闭，退出重试
        }
      }
    } else {
      // 默认路径：后台等待重试（JS 质询在后台通常跑不完，最终记为人机验证）
      for (let attempt = 0; final.status === 'cf_challenge' && attempt < 3; attempt++) {
        await new Promise((r) => setTimeout(r, 4000));
        try {
          const retry = await injectExtractor(tabId);
          const retryResult = retry && retry[0] && retry[0].result;
          if (!retryResult) break;
          final = retryResult;
        } catch (e) {
          break; // 页面正在跳转或标签已关闭，退出重试
        }
      }
    }

    return {
      bookmarkId: bookmark.id,
      bookmarkName: bookmark.title,
      url: bookmark.url,
      pageTitle: final.title || '',
      isDirectory: final.isDirectory,
      lastChapter: final.lastChapter,
      status: final.status,
      message: final.message,
    };
  } catch (error) {
    return {
      bookmarkId: bookmark.id,
      bookmarkName: bookmark.title,
      url: bookmark.url,
      pageTitle: '',
      isDirectory: false,
      lastChapter: null,
      status: 'error',
      message: error.message || t('unknownError'),
    };
  }
}

/**
 * 向 popup 发送进度更新
 */
function sendProgressUpdate() {
  // 扫描已停止/结束后不再发送进度，避免残留 worker 覆盖 UI
  if (!scanState.isScanning) return;

  // 工具栏角标显示扫描百分比
  const pct = scanState.total > 0 ? Math.round((scanState.progress / scanState.total) * 100) : 0;
  chrome.action.setBadgeText({ text: `${pct}%` });

  chrome.runtime.sendMessage({
    type: 'scanProgress',
    progress: scanState.progress,
    total: scanState.total,
    currentBookmark: scanState.currentBookmark,
  }).catch(() => {
    // popup 可能已关闭，忽略
  });
}

/**
 * 向 popup 发送扫描完成通知
 */
function sendScanComplete() {
  chrome.runtime.sendMessage({
    type: 'scanComplete',
    results: scanState.results,
  }).catch(() => {
    // popup 可能已关闭，忽略
  });
}

/**
 * 主扫描流程
 * @param {number} concurrency - 并发标签页数
 */
async function startScan(concurrency, force, humanVerify, timeoutSec) {
  scanState.isScanning = true;
  scanState.shouldStop = false;
  humanVerifyEnabled = !!humanVerify;
  // 超时秒数：限制在 5~300 秒，非法值回退 30 秒
  const sec = parseInt(timeoutSec, 10);
  loadTimeoutMs = (Number.isFinite(sec) && sec >= 5 ? Math.min(sec, 300) : 30) * 1000;
  scanState.results = [];
  scanState.startTime = Date.now();

  // 角标样式
  chrome.action.setBadgeBackgroundColor({ color: '#3b82f6' });
  chrome.action.setBadgeText({ text: '0%' });

  let workerTabs = [];

  try {
    // 获取所有书签
    const tree = await chrome.bookmarks.getTree();
    const bookmarks = flattenBookmarks(tree);

    // 同时分析清理项（重复书签、空文件夹）
    const duplicates = findDuplicates(tree);
    const emptyFolders = findEmptyFolders(tree);

    scanState.total = bookmarks.length;
    scanState.progress = 0;
    sendProgressUpdate();

    // 加载缓存结果（每个书签独立缓存，30 天内有效）
    const CACHE_TTL = 30 * 24 * 60 * 60 * 1000; // 30 天
    const now = Date.now();
    const cachedData = await chrome.storage.local.get('resultCache');
    let resultCache = cachedData.resultCache || {}; // { url: { result, checkedAt } }
    const cacheMap = {};
    if (force) {
      // 强制模式：立即清除旧缓存，随扫描重建；
      // 即使中途停止，下次普通扫描也能从新进度继续
      resultCache = {};
      await chrome.storage.local.set({ resultCache });
    } else {
      for (const [url, entry] of Object.entries(resultCache)) {
        // 旧版可能把验证页误缓存为成功：标题命中验证页特征则作废，重新扫描
        const pageTitle = (entry.result.pageTitle || '').toLowerCase();
        const staleCf = CF_TITLE_MARKERS.some((m) => pageTitle.includes(m));
        // 未过期且非超时/人机验证/已提取章节的结果才视为有效缓存
        if (!staleCf
          && now - entry.checkedAt < CACHE_TTL
          && entry.result.status !== 'timeout'
          && entry.result.status !== 'cf_challenge'
          && !entry.result.isDirectory) {
          cacheMap[url] = entry.result;
        }
      }
    }
    const cachedCount = Object.keys(cacheMap).length;
    console.log(`[Bookmark Radar] 缓存命中: ${cachedCount}, 并发数: ${concurrency}${force ? '（强制重扫）' : ''}`);

    // 分离缓存和未缓存书签
    const uncachedBookmarks = bookmarks.filter((b) => !cacheMap[b.url]);

    // 缓存跳过的书签直接计入进度，避免进度条卡住
    scanState.progress = bookmarks.length - uncachedBookmarks.length;
    sendProgressUpdate();

    // 确定实际并发数（不超过未缓存书签数）
    const workerCount = Math.min(concurrency, uncachedBookmarks.length);
    let groupId = null;

    // 创建工作标签页
    if (workerCount > 0) {
      const tabIds = [];
      for (let i = 0; i < workerCount; i++) {
        const tab = await chrome.tabs.create({ url: 'about:blank', active: false });
        workerTabs.push({ id: tab.id, index: i });
        tabIds.push(tab.id);
      }

      // 创建折叠标签组
      try {
        groupId = await chrome.tabs.group({ tabIds });
        await chrome.tabGroups.update(groupId, {
          title: 'Bookmark Radar',
          color: 'blue',
          collapsed: true,
        });
      } catch (e) {
        console.warn('创建标签组失败，继续无组模式:', e);
      }
    }

    // 将未缓存书签轮询分配给各 worker
    const workerQueues = Array.from({ length: workerCount }, () => []);
    uncachedBookmarks.forEach((bm, i) => {
      workerQueues[i % workerCount].push(bm);
    });

    // 并发执行各 worker
    const workerResults = new Map(); // url -> result

    const workerPromises = workerTabs.map(async (worker) => {
      const queue = workerQueues[worker.index];

      for (const bookmark of queue) {
        // 检查是否被停止
        if (scanState.shouldStop) {
          throw new Error('SCAN_STOPPED');
        }

        // 检查标签页是否被关闭
        if (!(await isTabAlive(worker.id))) {
          throw new Error('TAB_CLOSED');
        }

        scanState.currentBookmark = bookmark.title;
        sendProgressUpdate();

        const result = await processBookmark(bookmark, worker.id);

        // 加载超时 / 人机验证 / 已提取章节的结果不缓存：
        // 目录页每次重查才能追踪到最新章节
        if (result.status !== 'timeout'
          && result.status !== 'cf_challenge'
          && !result.isDirectory) {
          resultCache[bookmark.url] = { result, checkedAt: Date.now() };
          await chrome.storage.local.set({ resultCache });
        }

        // 若在加载期间被停止：结果已缓存，立即退出不再更新进度
        if (scanState.shouldStop) {
          throw new Error('SCAN_STOPPED');
        }

        workerResults.set(bookmark.url, result);

        scanState.progress++;
        sendProgressUpdate();

        // 请求间隔
        await new Promise((r) => setTimeout(r, 300));
      }
    });

    await Promise.all(workerPromises);

    // 按原始顺序组装结果（缓存 + 新扫描）
    for (const bookmark of bookmarks) {
      if (cacheMap[bookmark.url]) {
        scanState.results.push({ ...cacheMap[bookmark.url] });
      } else if (workerResults.has(bookmark.url)) {
        scanState.results.push(workerResults.get(bookmark.url));
      } else {
        scanState.results.push({
          bookmarkId: bookmark.id, bookmarkName: bookmark.title, url: bookmark.url,
          pageTitle: '', isDirectory: false, lastChapter: null,
          status: 'error', message: t('unknownError'),
        });
      }
    }

    // 构建报告数据
    const reportData = {
      timestamp: new Date().toISOString(),
      duration: Date.now() - scanState.startTime,
      total: scanState.total,
      results: scanState.results,
      summary: buildSummary(scanState.results),
      cleanup: {
        deadLinks: scanState.results.filter(
          (r) => ['network_error', 'server_error', 'access_denied', 'not_found'].includes(r.status)
        ),
        timeouts: scanState.results.filter((r) => r.status === 'timeout'),
        duplicates,
        emptyFolders,
      },
    };

    // 保存结果
    await chrome.storage.local.set({ scanResults: reportData });
    sendScanComplete();
  } catch (error) {
    if (error.message === 'SCAN_STOPPED') {
      console.log('[Bookmark Radar] 扫描已手动停止');
      await finalizePartialReport();
    } else if (error.message === 'TAB_CLOSED') {
      console.warn('[Bookmark Radar] 扫描中断：标签页被关闭');
      await finalizePartialReport();
      chrome.runtime.sendMessage({
        type: 'scanError',
        error: t('tabClosedError'),
      }).catch(() => {});
    } else {
      console.error('扫描过程出错:', error);
      sendScanComplete();
    }
  } finally {
    scanState.isScanning = false;
    // 清除角标
    chrome.action.setBadgeText({ text: '' });
    // 关闭所有工作标签
    for (const worker of workerTabs) {
      try {
        await chrome.tabs.remove(worker.id);
      } catch (e) {
        // 标签可能已被手动关闭
      }
    }
  }
}

/**
 * 重扫指定书签（忽略缓存，用于纠正误判条目）
 * 复用 processBookmark 流程与并发调度，新结果写回缓存并合并进现有报告
 * @param {string[]} urls - 勾选的书签 URL
 * @param {number} concurrency - 并发标签页数
 * @param {number} timeoutSec - 页面加载超时秒数
 */
async function rescanUrls(urls, concurrency, timeoutSec) {
  const uniqueUrls = Array.from(new Set(urls));
  if (uniqueUrls.length === 0) return { success: false };

  // 超时秒数：与全量扫描相同的钳制规则
  const sec = parseInt(timeoutSec, 10);
  loadTimeoutMs = (Number.isFinite(sec) && sec >= 5 ? Math.min(sec, 300) : 30) * 1000;

  scanState.isScanning = true;
  scanState.shouldStop = false;
  scanState.results = [];
  scanState.startTime = Date.now();
  chrome.action.setBadgeBackgroundColor({ color: '#3b82f6' });
  chrome.action.setBadgeText({ text: '0%' });

  let workerTabs = [];
  let tree = null;
  const newResults = new Map();

  try {
    tree = await chrome.bookmarks.getTree();
    const urlMap = new Map();
    for (const bm of flattenBookmarks(tree)) {
      if (!urlMap.has(bm.url)) urlMap.set(bm.url, bm);
    }
    const targets = uniqueUrls.map((u) => urlMap.get(u)).filter(Boolean);

    scanState.total = targets.length;
    scanState.progress = 0;
    sendProgressUpdate();

    // 实际并发不超过待扫书签数
    const workerCount = Math.min(concurrency || DEFAULT_CONCURRENCY, targets.length);

    // 创建工作标签页 + 折叠标签组
    if (workerCount > 0) {
      const tabIds = [];
      for (let i = 0; i < workerCount; i++) {
        const tab = await chrome.tabs.create({ url: 'about:blank', active: false });
        workerTabs.push({ id: tab.id, index: i });
        tabIds.push(tab.id);
      }
      try {
        const groupId = await chrome.tabs.group({ tabIds });
        await chrome.tabGroups.update(groupId, {
          title: 'Bookmark Radar',
          color: 'blue',
          collapsed: true,
        });
      } catch (e) {
        console.warn('创建标签组失败，继续无组模式:', e);
      }
    }

    // 轮询分配给各 worker
    const workerQueues = Array.from({ length: workerCount }, () => []);
    targets.forEach((bm, i) => {
      workerQueues[i % workerCount].push(bm);
    });

    const cachedData = await chrome.storage.local.get('resultCache');
    const resultCache = cachedData.resultCache || {};

    const workerPromises = workerTabs.map(async (worker) => {
      for (const bookmark of workerQueues[worker.index]) {
        if (scanState.shouldStop) throw new Error('SCAN_STOPPED');
        if (!(await isTabAlive(worker.id))) throw new Error('TAB_CLOSED');

        scanState.currentBookmark = bookmark.title;
        sendProgressUpdate();

        const result = await processBookmark(bookmark, worker.id);

        // 缓存规则与全量扫描一致
        if (result.status !== 'timeout'
          && result.status !== 'cf_challenge'
          && !result.isDirectory) {
          resultCache[bookmark.url] = { result, checkedAt: Date.now() };
          await chrome.storage.local.set({ resultCache });
        }

        if (scanState.shouldStop) throw new Error('SCAN_STOPPED');

        newResults.set(bookmark.url, result);
        scanState.progress++;
        sendProgressUpdate();
        await new Promise((r) => setTimeout(r, 300));
      }
    });

    await Promise.all(workerPromises);

    // 新结果合并进现有报告
    await mergeRescanResults(newResults, tree);
    sendScanComplete();
    return { success: true };
  } catch (error) {
    if (error.message === 'SCAN_STOPPED') {
      console.log('[Bookmark Radar] 重扫已手动停止');
      await mergeRescanResults(newResults, tree); // 保留已完成条目
      sendScanComplete();
      return { success: false, stopped: true };
    } else if (error.message === 'TAB_CLOSED') {
      console.warn('[Bookmark Radar] 重扫中断：标签页被关闭');
      await mergeRescanResults(newResults, tree);
      sendScanComplete();
      chrome.runtime.sendMessage({
        type: 'scanError',
        error: t('tabClosedError'),
      }).catch(() => {});
      return { success: false };
    }
    console.error('[Bookmark Radar] 重扫出错:', error);
    chrome.runtime.sendMessage({
      type: 'scanError',
      error: error.message || t('unknownError'),
    }).catch(() => {});
    return { success: false };
  } finally {
    scanState.isScanning = false;
    chrome.action.setBadgeText({ text: '' });
    for (const worker of workerTabs) {
      try {
        await chrome.tabs.remove(worker.id);
      } catch (e) {
        // 标签可能已被手动关闭
      }
    }
  }
}

/**
 * 把重扫结果替换进 scanResults 对应 URL，重建 summary/cleanup
 */
async function mergeRescanResults(newResults, tree) {
  if (newResults.size === 0) return;
  const data = await chrome.storage.local.get('scanResults');
  const old = data.scanResults;
  if (!old) return;

  const results = old.results.map((r) => newResults.get(r.url) || r);
  // 旧报告里没有的书签（如部分报告遗漏）追加到末尾
  const known = new Set(old.results.map((r) => r.url));
  for (const [url, result] of newResults) {
    if (!known.has(url)) results.push(result);
  }

  const reportData = {
    ...old,
    timestamp: new Date().toISOString(),
    results,
    summary: buildSummary(results),
    cleanup: {
      deadLinks: results.filter(
        (r) => ['network_error', 'server_error', 'access_denied', 'not_found'].includes(r.status)
      ),
      timeouts: results.filter((r) => r.status === 'timeout'),
      duplicates: old.cleanup ? old.cleanup.duplicates : (tree ? findDuplicates(tree) : []),
      emptyFolders: old.cleanup ? old.cleanup.emptyFolders : (tree ? findEmptyFolders(tree) : []),
    },
  };
  await chrome.storage.local.set({ scanResults: reportData });
}

/**
 * 构建摘要统计
 */
function buildSummary(results) {
  const summary = {
    total: results.length,
    success: 0,
    successWithDirectory: 0,
    networkError: 0,
    accessError: 0,
    serverError: 0,
    timeout: 0,
    parseError: 0,
    cfChallenge: 0,
  };

  for (const r of results) {
    switch (r.status) {
      case 'success':
        summary.success++;
        if (r.isDirectory) summary.successWithDirectory++;
        break;
      case 'network_error':
        summary.networkError++;
        break;
      case 'access_denied':
      case 'not_found':
        summary.accessError++;
        break;
      case 'server_error':
        summary.serverError++;
        break;
      case 'timeout':
        summary.timeout++;
        break;
      case 'parse_error':
      case 'error':
        summary.parseError++;
        break;
      case 'cf_challenge':
        summary.cfChallenge++;
        break;
    }
  }

  return summary;
}

/**
 * 从缓存中构建部分报告（用于扫描中断/停止时）
 */
async function finalizePartialReport() {
  try {
    const tree = await chrome.bookmarks.getTree();
    const bookmarks = flattenBookmarks(tree);
    const duplicates = findDuplicates(tree);
    const emptyFolders = findEmptyFolders(tree);

    // 从缓存中读取已有结果
    const cachedData = await chrome.storage.local.get('resultCache');
    const resultCache = cachedData.resultCache || {};

    // 组装结果
    const results = [];
    for (const bookmark of bookmarks) {
      const cached = resultCache[bookmark.url];
      if (cached) {
        results.push(cached.result);
      }
    }

    const reportData = {
      timestamp: new Date().toISOString(),
      duration: Date.now() - (scanState.startTime || Date.now()),
      total: bookmarks.length,
      results,
      summary: buildSummary(results),
      cleanup: {
        deadLinks: results.filter(
          (r) => ['network_error', 'server_error', 'access_denied', 'not_found'].includes(r.status)
        ),
        timeouts: results.filter((r) => r.status === 'timeout'),
        duplicates,
        emptyFolders,
      },
      partial: true, // 标记为部分结果
    };

    await chrome.storage.local.set({ scanResults: reportData });
    sendScanComplete();
  } catch (e) {
    console.error('生成部分报告失败:', e);
    sendScanComplete();
  }
}
