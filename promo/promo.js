// promo/promo.js
// 宣传页文案按 ?lang=zh|en 切换（默认 zh）

function applyPromoI18n(dict) {
  const lang = new URLSearchParams(location.search).get('lang') === 'en' ? 'en' : 'zh';
  const strings = dict[lang];
  document.querySelectorAll('[data-i18n]').forEach((node) => {
    const key = node.getAttribute('data-i18n');
    if (strings[key] !== undefined) node.textContent = strings[key];
  });
  document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
}
