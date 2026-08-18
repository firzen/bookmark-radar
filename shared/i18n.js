// shared/i18n.js
// 国际化工具：文案定义在 _locales/<locale>/messages.json，
// 语言自动跟随浏览器 UI 语言（chrome.i18n）

// 取文案，subs 为 $1/$2 占位替换值
function t(key, subs) {
  return chrome.i18n.getMessage(key, subs) || key;
}

// 填充 DOM 静态文案：data-i18n → textContent，data-i18n-title → title
function applyI18n(root) {
  root = root || document;
  root.querySelectorAll('[data-i18n]').forEach((node) => {
    node.textContent = t(node.getAttribute('data-i18n'));
  });
  root.querySelectorAll('[data-i18n-title]').forEach((node) => {
    node.setAttribute('title', t(node.getAttribute('data-i18n-title')));
  });
}

// 当前 UI 语言与日期格式 locale
const UI_LANG = (chrome.i18n.getUILanguage() || 'en').toLowerCase();
const DATE_LOCALE = UI_LANG.startsWith('zh') ? 'zh-CN' : 'en-US';
