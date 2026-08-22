// popup/popup.js
// 弹窗交互逻辑：扫描控制 + 打开完整报告入口
// 报告渲染在 report/report.html（新标签页）中完成

const scanBtn = document.getElementById('scanBtn');
const stopBtn = document.getElementById('stopBtn');
const concurrencySelect = document.getElementById('concurrencySelect');
const timeoutInput = document.getElementById('timeoutInput');
const scanOptions = document.getElementById('scanOptions');
const forceScan = document.getElementById('forceScan');
const humanVerify = document.getElementById('humanVerify');
const progressSection = document.getElementById('progressSection');
const progressText = document.getElementById('progressText');
const progressCount = document.getElementById('progressCount');
const progressFill = document.getElementById('progressFill');
const currentBookmark = document.getElementById('currentBookmark');
const openReportSection = document.getElementById('openReportSection');
const scanMeta = document.getElementById('scanMeta');
const openFullBtn = document.getElementById('openFullBtn');
const chaptersSection = document.getElementById('chaptersSection');
const chaptersCount = document.getElementById('chaptersCount');
const chaptersBody = document.getElementById('chaptersBody');
const emptyState = document.getElementById('emptyState');

let scanFinished = true; // 忽略扫描结束后的残留进度消息

// 记住上次选择的并发数
concurrencySelect.addEventListener('change', () => {
  chrome.storage.local.set({ lastConcurrency: parseInt(concurrencySelect.value, 10) });
});
chrome.storage.local.get('lastConcurrency').then((data) => {
  if (data.lastConcurrency) concurrencySelect.value = String(data.lastConcurrency);
});

// 静态文案按浏览器语言填充
applyI18n();

// 初始化：检查是否有正在进行的扫描或已有结果
init();

async function init() {
  const status = await chrome.runtime.sendMessage({ action: 'getScanStatus' });
  if (status && status.isScanning) {
    scanFinished = false;
    enterScanningUI();
    showProgress(status.progress, status.total, status.currentBookmark);
    return;
  }

  // 有已保存的结果：显示打开报告入口
  const savedResults = await chrome.runtime.sendMessage({ action: 'getResults' });
  if (savedResults) {
    showOpenReport(savedResults);
  }
}

// 监听来自 service worker 的消息
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'scanProgress') {
    if (scanFinished) return; // 扫描已结束，忽略残留进度
    showProgress(message.progress, message.total, message.currentBookmark);
  } else if (message.type === 'scanComplete') {
    scanFinished = true;
    hideProgress();
    chrome.runtime.sendMessage({ action: 'getResults' }).then((results) => {
      if (results) showOpenReport(results);
    });
  } else if (message.type === 'scanError') {
    scanFinished = true;
    hideProgress();
    showErrorMessage(message.error);
    chrome.runtime.sendMessage({ action: 'getResults' }).then((results) => {
      if (results) showOpenReport(results);
    });
  }
});

function showErrorMessage(text) {
  // 移除旧的错误提示
  const existing = document.querySelector('.error-toast');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.className = 'error-toast';
  toast.textContent = text;
  document.body.appendChild(toast);

  setTimeout(() => toast.remove(), 6000);
}

// 扫描按钮点击
scanBtn.addEventListener('click', async () => {
  scanFinished = false;
  enterScanningUI();

  const concurrency = parseInt(concurrencySelect.value, 10) || 1;
  chrome.storage.local.set({ lastConcurrency: concurrency });
  const timeout = parseInt(timeoutInput.value, 10) || 30;
  await chrome.runtime.sendMessage({ action: 'startScan', concurrency, force: forceScan.checked, humanVerify: humanVerify.checked, timeout });
});

// 停止按钮点击
stopBtn.addEventListener('click', async () => {
  stopBtn.textContent = t('stopping');
  stopBtn.disabled = true;
  await chrome.runtime.sendMessage({ action: 'stopScan' });
});

// 在新标签页打开完整报告
openFullBtn.addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('report/report.html') });
});

// --- UI 状态切换 ---

// 进入扫描中界面：隐藏入口/空状态，显示停止按钮
function enterScanningUI() {
  scanBtn.classList.add('hidden');
  scanOptions.classList.add('hidden');
  stopBtn.classList.remove('hidden');
  emptyState.classList.add('hidden');
  openReportSection.classList.add('hidden');
  chaptersSection.classList.add('hidden');
  progressSection.classList.remove('hidden');
}

function showProgress(progress, total, bookmark) {
  progressSection.classList.remove('hidden');
  emptyState.classList.add('hidden');
  openReportSection.classList.add('hidden');

  const pct = total > 0 ? Math.round((progress / total) * 100) : 0;
  progressFill.style.width = `${pct}%`;
  progressCount.textContent = `${progress} / ${total}`;
  progressText.textContent = progress === 0 ? t('preparing') : t('scanningPct', [String(pct)]);
  currentBookmark.textContent = bookmark ? t('checking', [bookmark]) : '';
}

function hideProgress() {
  progressSection.classList.add('hidden');
  scanBtn.classList.remove('hidden');
  scanOptions.classList.remove('hidden');
  stopBtn.classList.add('hidden');
  stopBtn.textContent = t('stop');
  stopBtn.disabled = false;
}

// 显示「打开完整报告」入口
function showOpenReport(data) {
  emptyState.classList.add('hidden');
  openReportSection.classList.remove('hidden');

  const parts = [t('scannedCount', [String(data.results.length), String(data.total)])];
  if (data.summary) {
    parts.push(t('chaptersExtracted', [String(data.summary.successWithDirectory)]));
    const dead = (data.cleanup && data.cleanup.deadLinks || []).length;
    if (dead > 0) parts.push(t('deadLinksCount', [String(dead)]));
  }
  if (data.partial) parts.push(t('partial'));
  scanMeta.textContent = parts.join(' · ');

  showChapters(data);
}

// 已提取章节快捷列表
function showChapters(data) {
  const items = (data.results || []).filter((r) => r.status === 'success' && r.isDirectory);
  if (items.length === 0) {
    chaptersSection.classList.add('hidden');
    return;
  }
  chaptersSection.classList.remove('hidden');
  const updatedCount = items.filter((item) => item.chapterChanged).length;
  chaptersCount.textContent = t('itemsCount', [String(items.length)])
    + (updatedCount > 0 ? ` \u00b7 ${t('updatedCount', [String(updatedCount)])}` : '');
  chaptersBody.innerHTML = items.map((item) => `
    <tr${item.chapterChanged ? ' class="chapter-updated"' : ''}>
      <td class="cell-bookmark">
        <a href="${escapeHtml(item.url)}" target="_blank" title="${escapeHtml(item.bookmarkName)}">${escapeHtml(item.bookmarkName)}</a>
      </td>
      <td class="cell-chapter">
        ${escapeHtml(item.lastChapter || '\u2014')}
        ${item.chapterChanged ? `<span class="chapter-new-badge" title="${escapeHtml(item.previousChapter || '')}">${t('chapterNew')}</span>` : ''}
      </td>
    </tr>
  `).join('');
}

function escapeHtml(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
