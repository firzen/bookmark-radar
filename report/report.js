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
const analysisTab = document.getElementById('analysisTab');
const cleanupTab = document.getElementById('cleanupTab');

let currentResults = null;

// 静态文案按浏览器语言填充
applyI18n();

init();

async function init() {
  // 若扫描正在进行，显示进度横幅
  const status = await chrome.runtime.sendMessage({ action: 'getScanStatus' });
  if (status && status.isScanning) {
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

  renderReport(currentResults);
}

// 实时消息：进度 / 完成 / 出错
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'scanProgress') {
    showProgress(message.progress, message.total, message.currentBookmark);
  } else if (message.type === 'scanComplete') {
    hideProgress();
    load();
  } else if (message.type === 'scanError') {
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
