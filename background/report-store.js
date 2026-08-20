// background/report-store.js
// 报告数据的组装与存储：摘要统计、报告构建、删除修剪、重扫合并、
// 中断时的部分报告。死链状态清单与构建逻辑只在本文件维护一份。

// 归入「死链 / 无法访问」清理组的状态
const DEAD_LINK_STATUSES = ['network_error', 'server_error', 'access_denied', 'not_found'];

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
 * 构建清理项（死链 / 超时 / 重复 / 空文件夹）
 */
function buildCleanup(results, duplicates, emptyFolders) {
  return {
    deadLinks: results.filter((r) => DEAD_LINK_STATUSES.includes(r.status)),
    timeouts: results.filter((r) => r.status === 'timeout'),
    duplicates: duplicates || [],
    emptyFolders: emptyFolders || [],
  };
}

/**
 * 构建完整报告数据
 * @param {Array} results 结果条目
 * @param {Object} opts { startTime, total, duplicates, emptyFolders, partial }
 */
function buildReportData(results, opts) {
  const data = {
    timestamp: new Date().toISOString(),
    duration: Date.now() - (opts.startTime || Date.now()),
    total: opts.total != null ? opts.total : results.length,
    results,
    summary: buildSummary(results),
    cleanup: buildCleanup(results, opts.duplicates, opts.emptyFolders),
  };
  if (opts.partial) data.partial = true; // 标记为部分结果
  return data;
}

/**
 * 删除书签后同步修剪存储中的报告：移除对应结果条目，
 * 重建摘要与清理列表，并清除对应 URL 的扫描缓存。
 * 不做这一步的话，报告页刷新后已删除的书签会重新出现。
 */
async function pruneScanResults(ids) {
  const idSet = new Set(ids);
  const data = await chrome.storage.local.get(['scanResults', 'resultCache']);
  const scanResults = data.scanResults;
  if (!scanResults || !Array.isArray(scanResults.results)) return;

  const removed = scanResults.results.filter((r) => idSet.has(r.bookmarkId));
  if (removed.length === 0) return;

  const results = scanResults.results.filter((r) => !idSet.has(r.bookmarkId));
  scanResults.results = results;
  scanResults.total = results.length;
  scanResults.summary = buildSummary(results);

  // 清理列表同步：重复组删到只剩 1 份时不再算重复
  const cleanup = scanResults.cleanup || {};
  cleanup.deadLinks = (cleanup.deadLinks || []).filter((i) => !idSet.has(i.bookmarkId));
  cleanup.timeouts = (cleanup.timeouts || []).filter((i) => !idSet.has(i.bookmarkId));
  cleanup.duplicates = (cleanup.duplicates || [])
    .map((g) => g.filter((bm) => !idSet.has(bm.id)))
    .filter((g) => g.length > 1);
  cleanup.emptyFolders = (cleanup.emptyFolders || []).filter((f) => !idSet.has(f.id));
  scanResults.cleanup = cleanup;

  const updates = { scanResults };

  // 已删 URL 的缓存一并清除（重新添加书签后重扫不会命中旧结果）
  const resultCache = data.resultCache || {};
  let cacheChanged = false;
  for (const r of removed) {
    if (!r.url) continue;
    // 归一化键与旧版原始 URL 键都清掉
    for (const key of [cacheKey(r.url), r.url]) {
      if (resultCache[key]) {
        delete resultCache[key];
        cacheChanged = true;
      }
    }
  }
  if (cacheChanged) updates.resultCache = resultCache;

  // 同步清除章节快照中已删书签的条目
  const snapshotData = await chrome.storage.local.get('chapterSnapshot');
  const snapshot = snapshotData.chapterSnapshot || {};
  let snapshotChanged = false;
  for (const r of removed) {
    if (!r.url) continue;
    const key = cacheKey(r.url);
    if (snapshot[key]) {
      delete snapshot[key];
      snapshotChanged = true;
    }
  }
  if (snapshotChanged) updates.chapterSnapshot = snapshot;

  await chrome.storage.local.set(updates);
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
      deadLinks: results.filter((r) => DEAD_LINK_STATUSES.includes(r.status)),
      timeouts: results.filter((r) => r.status === 'timeout'),
      duplicates: old.cleanup ? old.cleanup.duplicates : (tree ? findDuplicates(tree) : []),
      emptyFolders: old.cleanup ? old.cleanup.emptyFolders : (tree ? findEmptyFolders(tree) : []),
    },
  };
  await chrome.storage.local.set({ scanResults: reportData });

  // 同步更新章节快照（对比标记变更）
  await updateSnapshotForRescan(newResults);
}

/**
 * 从「本次运行已完成结果 ∪ 缓存」构建部分报告（扫描中断/停止时用）。
 * 目录结果按缓存规则不写缓存，只靠缓存重建会在停止后丢失本次
 * 已扫出的目录条目，因此优先采用调用方传入的内存结果。
 * @param {Array} completedResults 本次运行已完成的结果（可为空）
 */
async function finalizePartialReport(completedResults) {
  try {
    const tree = await chrome.bookmarks.getTree();
    const bookmarks = flattenBookmarks(tree);
    const duplicates = findDuplicates(tree);
    const emptyFolders = findEmptyFolders(tree);

    // 本次运行的内存结果按 URL 索引（含不缓存的目录条目）
    const byUrl = new Map();
    for (const r of (completedResults || [])) {
      if (r && r.url) byUrl.set(r.url, r);
    }

    // 尚未轮到的书签用缓存补齐
    const cachedData = await chrome.storage.local.get('resultCache');
    const resultCache = cachedData.resultCache || {};

    const results = [];
    for (const bookmark of bookmarks) {
      const finished = byUrl.get(bookmark.url);
      if (finished) {
        results.push(finished);
        continue;
      }
      // 兼容旧版以原始 URL 为键的缓存
      const cached = resultCache[cacheKey(bookmark.url)] || resultCache[bookmark.url];
      if (cached) results.push(cached.result);
    }

    const reportData = buildReportData(results, {
      startTime: scanState.startTime,
      total: bookmarks.length,
      duplicates,
      emptyFolders,
      partial: true,
    });

    await chrome.storage.local.set({ scanResults: reportData });
    notifyScanComplete();
  } catch (e) {
    console.error('生成部分报告失败:', e);
    notifyScanComplete();
  }
}
