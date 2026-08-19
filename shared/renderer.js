// shared/renderer.js
// 报告 / 书签清理 的共享渲染逻辑，popup 与完整报告页共用
// 通过 el() 按需取元素，避免与页面脚本的全局变量冲突

function el(id) {
  return document.getElementById(id);
}

function escapeHtml(str) {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function renderReport(data, options) {
  el('reportSection').classList.remove('hidden');
  el('emptyState').classList.add('hidden');

  const selectable = !!(options && options.selectable);

  // 渲染摘要
  renderSummary(data.summary);

  // 按状态分组，并并入清理项（重复副本/空文件夹作为附加分组）
  const groups = groupResults(data.results);
  appendCleanupGroups(groups, data.cleanup);

  // 渲染分组
  const groupContainer = el('groupContainer');
  groupContainer.innerHTML = '';
  for (const group of groups) {
    groupContainer.appendChild(createGroupElement(group, selectable));
  }
}

/**
 * 清理项并入分组视图：重复副本（每组保留第一份）与空文件夹
 * 渲染为附加分组，复用同一套勾选框，由顶栏「删除选中」统一删除
 */
function appendCleanupGroups(groups, cleanup) {
  if (!cleanup) return;

  const dupItems = [];
  for (const group of cleanup.duplicates || []) {
    for (let i = 1; i < group.length; i++) {
      dupItems.push({
        bookmarkId: group[i].id,
        bookmarkName: group[i].title,
        url: group[i].url,
        pageTitle: '',
        lastChapter: null,
        message: t('dupCopies', [String(group.length)]),
      });
    }
  }
  if (dupItems.length > 0) {
    groups.push({ key: 'duplicates', title: t('cleanDup'), dotClass: 'dot-access', items: dupItems });
  }

  const emptyItems = (cleanup.emptyFolders || []).map((f) => ({
    bookmarkId: f.id,
    bookmarkName: f.title,
    url: '',
    pageTitle: '',
    lastChapter: null,
    message: t('cleanEmpty'),
  }));
  if (emptyItems.length > 0) {
    groups.push({ key: 'emptyFolders', title: t('cleanEmpty'), dotClass: 'dot-access', items: emptyItems });
  }
}

function renderSummary(summary) {
  const cards = [
    { num: summary.total, lbl: t('sumTotal'), cls: 's-total' },
    { num: summary.successWithDirectory, lbl: t('sumDir'), cls: 's-dir' },
    { num: summary.success - summary.successWithDirectory, lbl: t('sumNonDir'), cls: 's-success' },
    { num: summary.networkError + summary.timeout, lbl: t('sumNetErr'), cls: 's-neterr' },
    { num: summary.accessError + summary.serverError + summary.parseError, lbl: t('sumOther'), cls: 's-fail' },
    { num: summary.cfChallenge || 0, lbl: t('sumCf'), cls: 's-cf' },
  ];

  el('summaryBar').innerHTML = cards.map(c => `
    <div class="summary-card ${c.cls}">
      <span class="num">${c.num}</span>
      <span class="lbl">${c.lbl}</span>
    </div>
  `).join('');
}

// 状态分组定义
const STATUS_GROUPS = [
  { key: 'success_dir', title: t('groupSuccessDir'), dotClass: 'dot-success' },
  { key: 'success_nondir', title: t('groupSuccessNonDir'), dotClass: 'dot-success' },
  { key: 'network_error', title: t('groupNetErr'), dotClass: 'dot-neterr' },
  { key: 'access_denied', title: t('groupAccess'), dotClass: 'dot-access' },
  { key: 'not_found', title: t('groupNotFound'), dotClass: 'dot-access' },
  { key: 'server_error', title: t('groupServer'), dotClass: 'dot-server' },
  { key: 'timeout', title: t('groupTimeout'), dotClass: 'dot-timeout' },
  { key: 'cf_challenge', title: t('groupCf'), dotClass: 'dot-cf' },
  { key: 'parse_error', title: t('groupParse'), dotClass: 'dot-parse' },
  { key: 'error', title: t('groupError'), dotClass: 'dot-parse' },
];

function groupResults(results) {
  const map = {};

  for (const r of results) {
    let key;
    if (r.status === 'success' && r.isDirectory) key = 'success_dir';
    else if (r.status === 'success') key = 'success_nondir';
    else key = r.status;

    if (!map[key]) map[key] = [];
    map[key].push(r);
  }

  return STATUS_GROUPS
    .filter(g => map[g.key] && map[g.key].length > 0)
    .map(g => ({ ...g, items: map[g.key] }));
}

function createGroupElement(group, selectable) {
  const section = document.createElement('div');
  section.className = 'group-section';

  const header = document.createElement('div');
  header.className = 'group-header';
  header.innerHTML = `
    <span class="arrow">▼</span>
    <span class="status-dot ${group.dotClass}"></span>
    <span class="group-title">${group.title}</span>
    <span class="group-count">${t('itemsCount', [String(group.items.length)])}</span>
  `;

  const body = document.createElement('div');
  body.className = 'group-body';

  const table = document.createElement('table');
  table.className = 'result-table';
  table.innerHTML = `
    <thead>
      <tr>
        ${selectable ? `<th class="cell-check" title="${t('tipShiftSelect')}"></th>` : ''}
        <th>${t('thBookmark')}</th>
        <th>${t('thPageTitle')}</th>
        <th>${t('thLastChapter')}</th>
      </tr>
    </thead>
    <tbody>
      ${group.items.map(item => `
        <tr>
          ${selectable ? `
          <td class="cell-check">
            <input type="checkbox" class="rescan-check" data-id="${escapeHtml(item.bookmarkId)}"${item.url ? ` data-url="${escapeHtml(item.url)}"` : ''}>
          </td>` : ''}
          <td class="cell-bookmark">
            ${item.url ? `<a href="${escapeHtml(item.url)}" target="_blank" title="${escapeHtml(item.bookmarkName)}">
              ${escapeHtml(item.bookmarkName)}
            </a>` : escapeHtml(item.bookmarkName)}
          </td>
          <td class="cell-title" title="${escapeHtml(item.pageTitle)}">
            ${escapeHtml(item.pageTitle) || '—'}
          </td>
          <td class="cell-chapter ${item.lastChapter ? '' : 'na'}">
            ${item.lastChapter ? escapeHtml(item.lastChapter) : escapeHtml(item.message || '—')}
          </td>
        </tr>
      `).join('')}
    </tbody>
  `;

  body.appendChild(table);
  section.appendChild(header);
  section.appendChild(body);

  // 折叠/展开
  header.addEventListener('click', () => {
    header.classList.toggle('collapsed');
    body.classList.toggle('collapsed');
  });

  return section;
}

function generateTextReport(data) {
  const lines = [];
  lines.push(`${t('reportTitle')}`);
  lines.push(t('scanTime', [new Date(data.timestamp).toLocaleString(DATE_LOCALE)]));
  lines.push(t('totalBookmarks', [String(data.total)]));
  lines.push(t('duration', [String(Math.round(data.duration / 1000))]));
  lines.push('');
  lines.push('='.repeat(60));

  const groups = groupResults(data.results);
  for (const group of groups) {
    lines.push('');
    lines.push(`【${group.title}】(${t('itemsCount', [String(group.items.length)])})`);
    lines.push('-'.repeat(40));
    for (const item of group.items) {
      lines.push(`  ${t('txtBookmark', [item.bookmarkName])}`);
      lines.push(`  ${t('txtTitle', [item.pageTitle || '—'])}`);
      lines.push(`  ${t('txtLast', [item.lastChapter || item.message || '—'])}`);
      lines.push('');
    }
  }

  // 清理部分
  if (data.cleanup) {
    lines.push('');
    lines.push('='.repeat(60));
    lines.push(t('cleanupTitle'));
    lines.push('='.repeat(60));
    if ((data.cleanup.deadLinks || []).length > 0) {
      lines.push(`\n【${t('cleanDead')}】(${t('itemsCount', [String(data.cleanup.deadLinks.length)])})`);
      for (const item of data.cleanup.deadLinks) {
        lines.push(`  ${item.bookmarkName} — ${item.message}`);
      }
    }
    if ((data.cleanup.timeouts || []).length > 0) {
      lines.push(`\n【${t('cleanTimeout')}】(${t('itemsCount', [String(data.cleanup.timeouts.length)])})`);
      for (const item of data.cleanup.timeouts) {
        lines.push(`  ${item.bookmarkName} — ${item.url}`);
      }
    }
    if ((data.cleanup.duplicates || []).length > 0) {
      lines.push(`\n【${t('cleanDup')}】(${t('itemsCount', [String(data.cleanup.duplicates.length)])})`);
      for (const group of data.cleanup.duplicates) {
        lines.push(`  URL: ${group[0].url}`);
        for (const bm of group) {
          lines.push(`    - ${bm.title}`);
        }
      }
    }
    if ((data.cleanup.emptyFolders || []).length > 0) {
      lines.push(`\n【${t('cleanEmpty')}】(${t('itemsCount', [String(data.cleanup.emptyFolders.length)])})`);
      for (const f of data.cleanup.emptyFolders) {
        lines.push(`  ${f.title}`);
      }
    }
  }

  return lines.join('\n');
}

