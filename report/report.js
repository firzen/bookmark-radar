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
const rescanConcurrency = document.getElementById('rescanConcurrency');
const rescanTimeout = document.getElementById('rescanTimeout');
const analysisTab = document.getElementById('analysisTab');
const cleanupTab = document.getElementById('cleanupTab');

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

// 标签页切换
document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    const tab = btn.dataset.tab;
    analysisTab.classList.toggle('hidden', tab !== 'analysis');
    cleanupTab.classList.toggle('hidden', tab !== 'cleanup');
  });
});

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

function updateRescanBtn() {
  const n = document.querySelectorAll('.rescan-check:checked').length;
  rescanBtn.disabled = rescanning || n === 0;
  rescanConcurrency.disabled = rescanning;
  rescanTimeout.disabled = rescanning;
  rescanBtn.textContent = n > 0 ? t('rescanCount', [String(n)]) : t('rescanSelected');
}

rescanBtn.addEventListener('click', async () => {
  const urls = Array.from(document.querySelectorAll('.rescan-check:checked'))
    .map((cb) => cb.dataset.url);
  if (urls.length === 0 || rescanning) return;
  rescanning = true;
  updateRescanBtn();
  const concurrency = parseInt(rescanConcurrency.value, 10) || 3;
  const timeout = parseInt(rescanTimeout.value, 10) || 30;
  await chrome.runtime.sendMessage({ action: 'rescanBookmarks', urls, concurrency, timeout });
});
