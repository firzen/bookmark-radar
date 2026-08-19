// report/report.js
// 完整报告页：读取已保存的扫描结果并渲染，扫描进行中实时显示进度
// 报告渲染逻辑见 shared/renderer.js

const reportMeta = document.getElementById('reportMeta');
const progressSection = document.getElementById('progressSection');
const progressText = document.getElementById('progressText');
const progressCount = document.getElementById('progressCount');
const progressFill = document.getElementById('progressFill');
const currentBookmark = document.getElementById('currentBookmark');
const copyBtn = document.getElementById('copyBtn');
const exportBtn = document.getElementById('exportBtn');
const refreshBtn = document.getElementById('refreshBtn');
const rescanBtn = document.getElementById('rescanBtn');
const deleteBtn = document.getElementById('deleteBtn');
const rescanConcurrency = document.getElementById('rescanConcurrency');
const rescanTimeout = document.getElementById('rescanTimeout');
const rescanHumanVerify = document.getElementById('rescanHumanVerify');

let currentResults = null;
let rescanning = false; // 重扫进行中，禁用重扫按钮

// 静态文案按浏览器语言填充
applyI18n();

init();

async function init() {
  // 若扫描正在进行，显示进度横幅
  const status = await chrome.runtime.sendMessage({ action: 'getScanStatus' });
  if (status && status.isScanning) {
    rescanning = true;
    showProgress(status.progress, status.total, status.currentBookmark);
  }

  load();
}

// 从 storage 读取最新报告并渲染
async function load() {
  const data = await chrome.storage.local.get('scanResults');
  if (!data.scanResults) return;

  currentResults = data.scanResults;
  const meta = [t('scanTime', [new Date(currentResults.timestamp).toLocaleString(DATE_LOCALE)]),
    t('totalBookmarks', [String(currentResults.total)])];
  if (currentResults.partial) meta.push(t('partialHint'));
  reportMeta.textContent = meta.join(' · ');

  renderReport(currentResults, { selectable: true });
  lastCheckIndex = -1; // 重渲染后旧锚点失效
  updateRescanBtn();
}

// 实时消息：进度 / 完成 / 出错
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'scanProgress') {
    rescanning = true;
    showProgress(message.progress, message.total, message.currentBookmark);
  } else if (message.type === 'scanComplete') {
    rescanning = false;
    hideProgress();
    load();
  } else if (message.type === 'scanError') {
    rescanning = false;
    hideProgress();
    load();
  }
});

function showProgress(progress, total, bookmark) {
  progressSection.classList.remove('hidden');
  const pct = total > 0 ? Math.round((progress / total) * 100) : 0;
  progressFill.style.width = `${pct}%`;
  progressCount.textContent = `${progress} / ${total}`;
  progressText.textContent = progress === 0 ? t('preparing') : t('scanningPct', [String(pct)]);
  currentBookmark.textContent = bookmark ? t('checking', [bookmark]) : '';
}

function hideProgress() {
  progressSection.classList.add('hidden');
}

// 复制文本
copyBtn.addEventListener('click', () => {
  if (!currentResults) return;
  const text = generateTextReport(currentResults);
  navigator.clipboard.writeText(text).then(() => {
    copyBtn.textContent = t('copied');
    setTimeout(() => { copyBtn.textContent = t('copyText'); }, 2000);
  });
});

// 导出 JSON
exportBtn.addEventListener('click', () => {
  if (!currentResults) return;
  const json = JSON.stringify(currentResults, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `bookmark-report-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
});

// 刷新
refreshBtn.addEventListener('click', load);

// --- 勾选重扫：忽略缓存重新扫描勾选的书签 ---

// 勾选变化时更新按钮文案/状态（事件委托，重渲染后依然有效）
document.addEventListener('change', (e) => {
  if (e.target.classList.contains('rescan-check')) updateRescanBtn();
});

// Shift + 点击：区间勾选（从上一次点击的复选框到当前，状态跟随锚点）
let lastCheckIndex = -1;
document.addEventListener('click', (e) => {
  const cb = e.target.closest('.rescan-check');
  if (!cb) return;
  const boxes = Array.from(document.querySelectorAll('.rescan-check'));
  const idx = boxes.indexOf(cb);

  if (e.shiftKey) {
    e.preventDefault(); // 阻止单次切换与文本选中
    const anchor = lastCheckIndex >= 0 && lastCheckIndex < boxes.length ? lastCheckIndex : idx;
    const [a, b] = anchor <= idx ? [anchor, idx] : [idx, anchor];
    const state = boxes[anchor].checked; // 区间状态跟随锚点（锚点未勾则区间取消勾选）
    for (let i = a; i <= b; i++) boxes[i].checked = state;
    updateRescanBtn();
  }
  lastCheckIndex = idx;
});

function updateRescanBtn() {
  const n = document.querySelectorAll('.rescan-check:checked').length;
  rescanBtn.disabled = rescanning || n === 0;
  deleteBtn.disabled = rescanning || n === 0;
  rescanConcurrency.disabled = rescanning;
  rescanTimeout.disabled = rescanning;
  rescanHumanVerify.disabled = rescanning;
  rescanBtn.textContent = n > 0 ? t('rescanCount', [String(n)]) : t('rescanSelected');
  deleteBtn.textContent = n > 0 ? t('deleteCount', [String(n)]) : t('deleteSelected');
}

rescanBtn.addEventListener('click', async () => {
  const urls = Array.from(document.querySelectorAll('.rescan-check:checked'))
    .map((cb) => cb.dataset.url)
    .filter(Boolean); // 空文件夹无 URL，不参与重扫
  if (urls.length === 0 || rescanning) return;
  rescanning = true;
  updateRescanBtn();
  const concurrency = parseInt(rescanConcurrency.value, 10) || 3;
  const timeout = parseInt(rescanTimeout.value, 10) || 30;
  await chrome.runtime.sendMessage({ action: 'rescanBookmarks', urls, concurrency, timeout, humanVerify: rescanHumanVerify.checked });
});

// --- 删除选中：复用同一套勾选框，弹层确认后批量删除书签/空文件夹 ---
const confirmOverlay = document.getElementById('confirmOverlay');
const confirmMsg = document.getElementById('confirmMsg');
const confirmCancel = document.getElementById('confirmCancel');
const confirmOk = document.getElementById('confirmOk');
let pendingDeleteIds = []; // 待确认删除的书签 id

deleteBtn.addEventListener('click', () => {
  const ids = Array.from(document.querySelectorAll('.rescan-check:checked'))
    .map((cb) => cb.dataset.id).filter(Boolean);
  if (ids.length === 0 || rescanning) return;
  pendingDeleteIds = ids;
  confirmMsg.textContent = t('confirmDelete', [String(ids.length)]);
  confirmOverlay.classList.remove('hidden');
});

confirmCancel.addEventListener('click', () => {
  pendingDeleteIds = [];
  confirmOverlay.classList.add('hidden');
});

// 点击遮罩空白处同样取消
confirmOverlay.addEventListener('click', (e) => {
  if (e.target === confirmOverlay) confirmCancel.click();
});

confirmOk.addEventListener('click', async () => {
  const ids = pendingDeleteIds;
  pendingDeleteIds = [];
  confirmOverlay.classList.add('hidden');
  if (ids.length === 0 || rescanning) return;

  deleteBtn.disabled = true;
  deleteBtn.textContent = t('deleting');

  const result = await chrome.runtime.sendMessage({ action: 'deleteBookmarks', ids });
  if (result && result.success) {
    // SW 已同步修剪存储中的报告；重新加载渲染，
    // 摘要卡片/分组计数/已删条目一次性全部同步
    await load();
  } else {
    deleteBtn.textContent = t('deleteFailed');
    deleteBtn.disabled = false;
  }
});
