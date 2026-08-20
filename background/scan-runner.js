// background/scan-runner.js
// 扫描调度与书签树操作：全量扫描与条目级重扫共用的 worker 调度，
// 以及书签树遍历、进度角标、缓存读取等。单项检查逻辑见 checker.js。

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
  const allBookmarks = flattenBookmarks(nodes);

  // 按 URL 分组（归一化键与缓存键一致，忽略末尾斜杠）
  const urlMap = {};
  for (const bm of allBookmarks) {
    const key = cacheKey(bm.url);
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
function notifyScanComplete() {
  chrome.runtime.sendMessage({
    type: 'scanComplete',
    results: scanState.results,
  }).catch(() => {
    // popup 可能已关闭，忽略
  });
}

/**
 * 向 popup 发送扫描错误通知
 */
function notifyScanError(message) {
  chrome.runtime.sendMessage({
    type: 'scanError',
    error: message,
  }).catch(() => {
    // popup 可能已关闭，忽略
  });
}

/**
 * 创建工作标签页并收进折叠标签组（失败时降级为无组模式）
 */
async function createWorkerTabs(count) {
  const workerTabs = [];
  if (count <= 0) return workerTabs;

  const tabIds = [];
  for (let i = 0; i < count; i++) {
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

  return workerTabs;
}

const CACHE_TTL = 30 * 24 * 60 * 60 * 1000; // 缓存有效期 30 天

/**
 * 加载可用缓存（归一化 URL → 结果）。
 * 强制模式不清空 storage 中的旧缓存，只返回空 map 使全部书签进入重扫；
 * 旧数据保留作为中断兜底——finalizePartialReport 可从缓存补齐未轮到的条目，
 * 避免停止扫描后丢失「非目录」等已知状态。新结果会随扫描自然覆写旧缓存。
 */
async function loadCacheMap(force) {
  if (force) {
    // 不清空 resultCache，仅返回空 map 让所有书签都走实际扫描
    return {};
  }

  const cachedData = await chrome.storage.local.get('resultCache');
  const resultCache = cachedData.resultCache || {}; // { url: { result, checkedAt } }
  const cacheMap = {};
  const now = Date.now();
  for (const [url, entry] of Object.entries(resultCache)) {
    // 旧版可能把验证页误缓存为成功：标题命中验证页特征则作废，重新扫描
    if (isChallengeTitle(entry.result.pageTitle)) continue;
    if (now - entry.checkedAt >= CACHE_TTL) continue;
    // 可用性规则与写侧一致（见 classifier.isCacheable）：
    // 超时/人机验证/错误多为环境性瞬时故障，目录页需每次重查追踪最新章节
    if (!isCacheable(entry.result)) continue;
    cacheMap[cacheKey(url)] = entry.result;
  }
  return cacheMap;
}

/**
 * 并发扫描队列（全量扫描与条目级重扫共用）：
 * 工作标签 + 标签组、轮询分队、进度角标、停止/标签关闭处理、
 * 缓存写入（单一规则 isCacheable）与请求间隔均只在此实现一份
 * @param {Array} bookmarks 待扫书签
 * @param {Object} opts { concurrency, onResult }
 * @returns {Promise<{results: Map, interrupted: string|null}>}
 *   results: url -> result；interrupted: 'SCAN_STOPPED' | 'TAB_CLOSED' | null
 */
async function runScanQueue(bookmarks, { concurrency, onResult }) {
  const workerCount = Math.min(concurrency, bookmarks.length);
  const workerTabs = await createWorkerTabs(workerCount);
  const results = new Map();
  let interrupted = null;

  try {
    // 将书签轮询分配给各 worker
    const workerQueues = Array.from({ length: workerCount }, () => []);
    bookmarks.forEach((bm, i) => {
      workerQueues[i % workerCount].push(bm);
    });

    const cachedData = await chrome.storage.local.get(['resultCache', 'directoryCache']);
    const resultCache = cachedData.resultCache || {};
    const directoryCache = cachedData.directoryCache || {};

    const workerPromises = workerTabs.map(async (worker) => {
      const queue = workerQueues[worker.index];

      for (const bookmark of queue) {
        // 检查是否被停止
        if (scanState.shouldStop) throw new Error('SCAN_STOPPED');

        // 检查标签页是否被关闭
        if (!(await isTabAlive(worker.id))) throw new Error('TAB_CLOSED');

        scanState.currentBookmark = bookmark.title;
        sendProgressUpdate();

        const result = await checkBookmark(bookmark, worker.id);

        // 缓存写入统一走 classifier.isCacheable
        if (isCacheable(result)) {
          resultCache[cacheKey(bookmark.url)] = { result, checkedAt: Date.now() };
          await chrome.storage.local.set({ resultCache });
        }
        // 目录页不写 resultCache（避免下次扫描跳过），但写入独立的
        // directoryCache 作为中断兜底，确保停止扫描不丢失已提取章节的状态
        if (result.isDirectory) {
          directoryCache[cacheKey(bookmark.url)] = { result, checkedAt: Date.now() };
          await chrome.storage.local.set({ directoryCache });
        }

        // 若在加载期间被停止：结果已缓存，立即退出不再更新进度
        if (scanState.shouldStop) throw new Error('SCAN_STOPPED');

        results.set(bookmark.url, result);
        scanState.progress++;
        sendProgressUpdate();
        if (onResult) onResult(result);

        // 请求间隔
        await delay(300);
      }
    });

    await Promise.all(workerPromises);
  } catch (error) {
    if (error.message === 'SCAN_STOPPED' || error.message === 'TAB_CLOSED') {
      interrupted = error.message;
    } else {
      throw error;
    }
  } finally {
    // 关闭所有工作标签
    for (const worker of workerTabs) {
      try {
        await chrome.tabs.remove(worker.id);
      } catch (e) {
        // 标签可能已被手动关闭
      }
    }
  }

  return { results, interrupted };
}

/**
 * 主扫描流程
 * @param {number} concurrency - 并发标签页数
 */
async function startScan(concurrency, force, humanVerify, timeoutSec) {
  scanState.isScanning = true;
  scanState.shouldStop = false;
  humanVerifyEnabled = !!humanVerify;
  loadTimeoutMs = clampTimeoutSec(timeoutSec);
  scanState.results = [];
  scanState.startTime = Date.now();

  // 角标样式
  chrome.action.setBadgeBackgroundColor({ color: '#3b82f6' });
  chrome.action.setBadgeText({ text: '0%' });

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
    const cacheMap = await loadCacheMap(force);
    console.log(`[Bookmark Radar] 缓存命中: ${Object.keys(cacheMap).length}, 并发数: ${concurrency}${force ? '（强制重扫）' : ''}`);

    // 分离缓存和未缓存书签
    const uncachedBookmarks = bookmarks.filter((b) => !cacheMap[cacheKey(b.url)]);

    // 缓存跳过的书签直接计入进度，避免进度条卡住
    scanState.progress = bookmarks.length - uncachedBookmarks.length;
    sendProgressUpdate();

    // 内存累积本次已完成结果：目录结果不进缓存，中断后
    // 部分报告靠它补齐，避免停止扫描丢失目录条目
    const completed = [];
    const { results: workerResults, interrupted } = await runScanQueue(uncachedBookmarks, {
      concurrency,
      onResult: (r) => completed.push(r),
    });

    if (interrupted === 'SCAN_STOPPED') {
      console.log('[Bookmark Radar] 扫描已手动停止');
      await finalizePartialReport(completed);
      return;
    }
    if (interrupted === 'TAB_CLOSED') {
      console.warn('[Bookmark Radar] 扫描中断：标签页被关闭');
      await finalizePartialReport(completed);
      notifyScanError(t('tabClosedError'));
      return;
    }

    // 按原始顺序组装结果（缓存 + 新扫描）
    for (const bookmark of bookmarks) {
      const cached = cacheMap[cacheKey(bookmark.url)];
      if (cached) {
        scanState.results.push({ ...cached });
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

    // 章节变更对比：与上次快照比较，标记有更新的目录条目
    const oldSnapshotData = await chrome.storage.local.get('chapterSnapshot');
    const oldSnapshot = oldSnapshotData.chapterSnapshot || {};
    const { results: markedResults, snapshot: newSnapshot } = buildChapterSnapshot(scanState.results, oldSnapshot);

    // 构建并保存报告数据
    const reportData = buildReportData(markedResults, {
      startTime: scanState.startTime,
      total: scanState.total,
      duplicates,
      emptyFolders,
    });
    await chrome.storage.local.set({ scanResults: reportData, chapterSnapshot: newSnapshot });
    notifyScanComplete();
  } catch (error) {
    console.error('[Bookmark Radar] 扫描过程出错:', error);
    notifyScanComplete();
  } finally {
    scanState.isScanning = false;
    // 清除角标
    chrome.action.setBadgeText({ text: '' });
  }
}


/**
 * 对比旧章节快照，标记本次扫描中章节发生变化的目录条目，
 * 并构建新快照。
 * @param {Array} results 本次扫描结果
 * @param {Object} oldSnapshot 上次的章节快照
 * @returns {{ results: Array, snapshot: Object }}
 */
function buildChapterSnapshot(results, oldSnapshot) {
  const newSnapshot = {};
  const updatedResults = results.map((r) => {
    if (!r.isDirectory || r.status !== 'success') return r;
    const url = cacheKey(r.url);
    const old = oldSnapshot[url];
    const updated = { ...r };
    if (old && old.lastChapter && old.lastChapter !== r.lastChapter) {
      updated.chapterChanged = true;
      updated.previousChapter = old.lastChapter;
    }
    newSnapshot[url] = { lastChapter: r.lastChapter, updatedAt: Date.now() };
    return updated;
  });
  return { results: updatedResults, snapshot: newSnapshot };
}

/**
 * 重扫后更新章节快照：对比并标记变更，保存新快照
 */
async function updateSnapshotForRescan(newResults) {
  const data = await chrome.storage.local.get(['chapterSnapshot', 'scanResults']);
  const snapshot = data.chapterSnapshot || {};
  let snapshotChanged = false;

  for (const [url, result] of newResults) {
    if (!result.isDirectory || result.status !== 'success') continue;
    const key = cacheKey(url);
    const old = snapshot[key];
    if (old && old.lastChapter && old.lastChapter !== result.lastChapter) {
      result.chapterChanged = true;
      result.previousChapter = old.lastChapter;
    }
    snapshot[key] = { lastChapter: result.lastChapter, updatedAt: Date.now() };
    snapshotChanged = true;
  }

  if (snapshotChanged) {
    await chrome.storage.local.set({ chapterSnapshot: snapshot });
    // 同步更新 scanResults 中的对应条目，使报告页刷新后能看到标记
    if (data.scanResults && Array.isArray(data.scanResults.results)) {
      data.scanResults.results = data.scanResults.results.map((r) => newResults.get(r.url) || r);
      data.scanResults.timestamp = new Date().toISOString();
      await chrome.storage.local.set({ scanResults: data.scanResults });
    }
  }
}

/**
 * 重扫指定书签（忽略缓存，用于纠正误判条目）
 * 复用统一调度与 checkBookmark 流程，新结果写回缓存并合并进现有报告
 * @param {string[]} urls - 勾选的书签 URL
 * @param {number} concurrency - 并发标签页数
 * @param {number} timeoutSec - 页面加载超时秒数
 * @param {boolean} humanVerify - 真人验证模式（验证页临时前台激活）
 */
async function rescanUrls(urls, concurrency, timeoutSec, humanVerify) {
  const uniqueUrls = Array.from(new Set(urls));
  if (uniqueUrls.length === 0) return { success: false };

  humanVerifyEnabled = !!humanVerify;
  loadTimeoutMs = clampTimeoutSec(timeoutSec);

  scanState.isScanning = true;
  scanState.shouldStop = false;
  scanState.results = [];
  scanState.startTime = Date.now();
  chrome.action.setBadgeBackgroundColor({ color: '#3b82f6' });
  chrome.action.setBadgeText({ text: '0%' });

  let tree = null;

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

    const { results: newResults, interrupted } = await runScanQueue(targets, {
      concurrency: concurrency || DEFAULT_CONCURRENCY,
    });

    if (interrupted === 'SCAN_STOPPED') {
      console.log('[Bookmark Radar] 重扫已手动停止');
      await mergeRescanResults(newResults, tree); // 保留已完成条目
      notifyScanComplete();
      return { success: false, stopped: true };
    }
    if (interrupted === 'TAB_CLOSED') {
      console.warn('[Bookmark Radar] 重扫中断：标签页被关闭');
      await mergeRescanResults(newResults, tree);
      notifyScanComplete();
      notifyScanError(t('tabClosedError'));
      return { success: false };
    }

    // 新结果合并进现有报告
    await mergeRescanResults(newResults, tree);
    notifyScanComplete();
    return { success: true };
  } catch (error) {
    console.error('[Bookmark Radar] 重扫出错:', error);
    notifyScanError(error.message || t('unknownError'));
    return { success: false };
  } finally {
    scanState.isScanning = false;
    chrome.action.setBadgeText({ text: '' });
  }
}
