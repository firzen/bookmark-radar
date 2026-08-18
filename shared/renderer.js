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

  // 按状态分组
  const groups = groupResults(data.results);

  // 渲染分组
  const groupContainer = el('groupContainer');
  groupContainer.innerHTML = '';
  for (const group of groups) {
    groupContainer.appendChild(createGroupElement(group, selectable));
  }

  // 渲染清理标签
  if (data.cleanup) {
    renderCleanup(data.cleanup);
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
        ${selectable ? '<th class="cell-check"></th>' : ''}
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
            <input type="checkbox" class="rescan-check" data-url="${escapeHtml(item.url)}" title="${t('tipRescan')}">
          </td>` : ''}
          <td class="cell-bookmark">
            <a href="${escapeHtml(item.url)}" target="_blank" title="${escapeHtml(item.bookmarkName)}">
              ${escapeHtml(item.bookmarkName)}
            </a>
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

// --- 书签清理 ---

function renderCleanup(cleanup) {
  const deadLinks = cleanup.deadLinks || [];
  const timeouts = cleanup.timeouts || [];
  const duplicates = cleanup.duplicates || [];
  const emptyFolders = cleanup.emptyFolders || [];
  const total = deadLinks.length + timeouts.length + duplicates.reduce((sum, g) => sum + g.length - 1, 0) + emptyFolders.length;

  let html = `
    <div class="cleanup-summary">
      <div class="cleanup-stat dead">
        <span class="num">${deadLinks.length}</span>
        <span class="lbl">${t('cleanDead')}</span>
      </div>
      <div class="cleanup-stat timeout">
        <span class="num">${timeouts.length}</span>
        <span class="lbl">${t('cleanTimeout')}</span>
      </div>
      <div class="cleanup-stat dup">
        <span class="num">${duplicates.length}</span>
        <span class="lbl">${t('dupGroups')}</span>
      </div>
      <div class="cleanup-stat empty">
        <span class="num">${emptyFolders.length}</span>
        <span class="lbl">${t('cleanEmpty')}</span>
      </div>
    </div>
  `;

  if (total === 0) {
    html += `<div class="cleanup-empty">${t('cleanEmptyState')}</div>`;
  } else {
    // 死链
    if (deadLinks.length > 0) {
      html += createCleanupSection('deadLinks', t('cleanDead'), deadLinks.map(item => ({
        id: item.url + '|' + item.bookmarkName,
        bookmarkId: findBookmarkId(deadLinks, item),
        title: item.bookmarkName,
        subtitle: `${item.message || t('unreachable')} · ${item.url}`,
        url: item.url,
      })));
    }

    // 加载超时
    if (timeouts.length > 0) {
      html += createCleanupSection('timeouts', t('cleanTimeout'), timeouts.map(item => ({
        id: item.url + '|' + item.bookmarkName,
        bookmarkId: findBookmarkId(timeouts, item),
        title: item.bookmarkName,
        subtitle: `${item.message || t('loadTimeoutMsg')} · ${item.url}`,
        url: item.url,
      })));
    }

    // 重复书签
    if (duplicates.length > 0) {
      const dupItems = [];
      for (const group of duplicates) {
        // 保留第一个，其余标记为可删除
        for (let i = 1; i < group.length; i++) {
          dupItems.push({
            id: group[i].id,
            bookmarkId: group[i].id,
            title: group[i].title,
            subtitle: `${t('dupCopies', [String(group.length)])} · ${group[i].url}`,
            url: group[i].url,
          });
        }
      }
      html += createCleanupSection('duplicates', t('cleanDup'), dupItems);
    }

    // 空文件夹
    if (emptyFolders.length > 0) {
      html += createCleanupSection('emptyFolders', t('cleanEmpty'), emptyFolders.map(f => ({
        id: f.id,
        bookmarkId: f.id,
        title: f.title,
        subtitle: t('cleanEmpty'),
      })));
    }
  }

  el('cleanupContainer').innerHTML = html;

  // 绑定事件
  bindCleanupEvents();
}

function findBookmarkId(results, item) {
  // 结果对象自带 bookmarkId，删除时直接传给 removeTree
  return item.bookmarkId || item.url;
}

function createCleanupSection(key, title, items) {
  return `
    <div class="cleanup-section" data-key="${key}">
      <div class="cleanup-header">
        <span class="cleanup-title">${title}</span>
        <span class="cleanup-count">${t('itemsCount', [String(items.length)])}</span>
      </div>
      <ul class="cleanup-list">
        ${items.map(item => `
          <li class="cleanup-item">
            <input type="checkbox" data-id="${escapeHtml(item.bookmarkId)}" data-key="${key}">
            <div class="item-info">
              <div class="item-title">
                ${item.url
                  ? `<a href="${escapeHtml(item.url)}" target="_blank" rel="noopener" title="${t('openToConfirm')}">${escapeHtml(item.title)}</a>`
                  : escapeHtml(item.title)}
              </div>
              <div class="item-url">${escapeHtml(item.subtitle)}</div>
            </div>
          </li>
        `).join('')}
      </ul>
      <div class="cleanup-footer">
        <label class="select-all">
          <input type="checkbox" data-select-all="${key}"> ${t('selectAll')}
        </label>
        <button class="btn-danger" data-delete="${key}">${t('deleteSelected')}</button>
      </div>
    </div>
  `;
}

function bindCleanupEvents() {
  const cleanupContainer = el('cleanupContainer');

  // 全选
  cleanupContainer.querySelectorAll('[data-select-all]').forEach((cb) => {
    cb.addEventListener('change', () => {
      const key = cb.dataset.selectAll;
      cleanupContainer.querySelectorAll(`input[data-key="${key}"]`).forEach((item) => {
        item.checked = cb.checked;
      });
    });
  });

  // 删除按钮
  cleanupContainer.querySelectorAll('[data-delete]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const key = btn.dataset.delete;
      const checked = cleanupContainer.querySelectorAll(`input[data-key="${key}"]:checked`);
      if (checked.length === 0) {
        return;
      }

      const ids = Array.from(checked).map((cb) => cb.dataset.id);
      const confirmed = confirm(t('confirmDelete', [String(ids.length)]));
      if (!confirmed) return;

      btn.disabled = true;
      btn.textContent = t('deleting');

      const result = await chrome.runtime.sendMessage({
        action: 'deleteBookmarks',
        ids,
      });

      if (result && result.success) {
        // 从列表中移除对应项
        checked.forEach((cb) => {
          cb.closest('.cleanup-item').remove();
        });
        btn.textContent = t('deletedCount', [String(ids.length)]);
        setTimeout(() => {
          btn.textContent = t('deleteSelected');
          btn.disabled = false;
        }, 2000);
      } else {
        btn.textContent = t('deleteFailed');
        btn.disabled = false;
      }
    });
  });
}
