// background/service-worker.js
// 入口：消息路由与全局配置。
// 单项检查管道见 checker.js，并发调度见 scan-runner.js，
// 报告存储见 report-store.js，分类规则见 shared/classifier.js

importScripts(
  '../shared/i18n.js',
  '../shared/classifier.js',
  '../content/extractor.js',
  'report-store.js',
  'checker.js',
  'scan-runner.js'
);

const DEFAULT_CONCURRENCY = 3; // 默认并发数

let humanVerifyEnabled = false; // 真人验证模式：验证页临时前台激活
let loadTimeoutMs = 30000; // 页面加载超时（默认 30 秒，popup 可配置）

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

// 超时秒数钳制：限制在 5~300 秒，非法值回退 30 秒，返回毫秒
function clampTimeoutSec(timeoutSec) {
  const sec = parseInt(timeoutSec, 10);
  return (Number.isFinite(sec) && sec >= 5 ? Math.min(sec, 300) : 30) * 1000;
}

// 监听来自 popup / 报告页的消息
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
    // 批量删除书签，并同步修剪存储中的报告（否则刷新后已删书签会重新出现）
    deleteBookmarks(message.ids).then(async () => {
      await pruneScanResults(message.ids);
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
    rescanUrls(message.urls || [], message.concurrency, message.timeout, message.humanVerify)
      .then((r) => sendResponse(r));
    return true; // 异步响应
  }
  return false;
});
