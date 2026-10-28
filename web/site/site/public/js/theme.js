// Runs before first paint (an external file because the CSP blocks inline scripts).
// 1. Sets the saved theme, and wires the theme and language menus once the page is read.
// 2. Language: every page exists in English (/docs), Simplified Chinese (/zh/docs), Traditional
//    Chinese (/zh-tw/docs) and Japanese (/ja/docs). A saved choice wins; with none, an English URL
//    sends a browser set to one of the other languages to its page. The page is hidden while it is
//    replaced, so the other language never flashes. Picking a language in the switcher saves it.
// The 404 page is English; here it only sets <html lang> and the title.
// Keep the table below in step with LANG_INFO and SLUGS in site/src/lib/i18n.ts (a page's
// <html data-page> is its key: home, docs, stopped, overview, docsRoad, guide, road, about; a guide
// chapter also has <html data-sub>, its slug, the same in every language).
(function () {
  var LANGS = {
    en: { dir: '', html: 'en', notFound: 'Page not found' },
    zh: { dir: 'zh', html: 'zh-CN', notFound: '找不到这个页面' },
    tw: { dir: 'zh-tw', html: 'zh-Hant-TW', notFound: '找不到這個頁面' },
    ja: { dir: 'ja', html: 'ja', notFound: 'ページが見つかりません' },
  };
  var SLUGS = {
    home: '',
    how: 'how',
    docs: 'docs',
    stopped: 'docs/stopped',
    overview: 'docs/overview',
    docsRoad: 'docs/road',
    guide: 'docs/guide',
    road: 'road',
    about: 'about',
  };
  var html = document.documentElement;
  var theme = null;
  var saved = null;
  var store = function (key, value) {
    try {
      localStorage.setItem(key, value);
    } catch (e) {}
  };
  try {
    theme = localStorage.getItem('yokoten.theme');
    saved = localStorage.getItem('yokoten.lang');
  } catch (e) {}
  if (theme === 'light' || theme === 'dark') html.setAttribute('data-theme', theme);
  if (!Object.prototype.hasOwnProperty.call(LANGS, saved)) saved = null;

  document.addEventListener('DOMContentLoaded', function () {
    // The theme menu: system (no data-theme), light or dark; the choice is kept in the browser.
    var choices = document.querySelectorAll('[data-theme-choice]');
    var mark = function () {
      var now = html.getAttribute('data-theme') || 'system';
      for (var c = 0; c < choices.length; c++) choices[c].setAttribute('aria-checked', choices[c].getAttribute('data-theme-choice') === now ? 'true' : 'false');
    };
    mark();
    for (var i = 0; i < choices.length; i++) {
      choices[i].addEventListener('click', function (event) {
        var pick = event.currentTarget.getAttribute('data-theme-choice');
        if (pick === 'system') html.removeAttribute('data-theme');
        else html.setAttribute('data-theme', pick);
        store('yokoten.theme', pick);
        mark();
      });
    }
    // The menus (pages on a phone, theme, language): a button opens a list of items. Arrows, Home and End move,
    // Escape closes and gives the focus back, a click outside closes, and picking an item closes.
    var menus = document.querySelectorAll('[data-menu]');
    var closeAll = function (except) {
      for (var m = 0; m < menus.length; m++) if (menus[m] !== except) setOpen(menus[m], false, false);
    };
    var itemsOf = function (menu) {
      return menu.querySelectorAll('[role="menuitemradio"], [role="menuitem"]');
    };
    var setOpen = function (menu, open, focus) {
      var button = menu.querySelector('button[aria-haspopup]');
      var list = menu.querySelector('[role="menu"]');
      button.setAttribute('aria-expanded', open ? 'true' : 'false');
      list.hidden = !open;
      if (open) {
        var items = itemsOf(menu);
        var at = 0;
        for (var n = 0; n < items.length; n++) if (items[n].getAttribute('aria-checked') === 'true') at = n;
        if (items[at]) items[at].focus();
      } else if (focus) button.focus();
    };
    for (var mi = 0; mi < menus.length; mi++) {
      (function (menu) {
        var button = menu.querySelector('button[aria-haspopup]');
        button.addEventListener('click', function () {
          var open = button.getAttribute('aria-expanded') !== 'true';
          closeAll(menu);
          setOpen(menu, open, false);
        });
        button.addEventListener('keydown', function (event) {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            closeAll(menu);
            setOpen(menu, true, false);
          }
        });
        menu.querySelector('[role="menu"]').addEventListener('keydown', function (event) {
          var items = itemsOf(menu);
          var now = Array.prototype.indexOf.call(items, document.activeElement);
          var to = { ArrowDown: (now + 1) % items.length, ArrowUp: (now - 1 + items.length) % items.length, Home: 0, End: items.length - 1 }[event.key];
          if (to !== undefined) {
            event.preventDefault();
            items[to].focus();
          } else if (event.key === 'Escape') {
            event.preventDefault();
            setOpen(menu, false, true);
          } else if (event.key === 'Tab') setOpen(menu, false, false);
        });
        var items = itemsOf(menu);
        for (var it = 0; it < items.length; it++) items[it].addEventListener('click', function () {
          setOpen(menu, false, true);
        });
      })(menus[mi]);
    }
    document.addEventListener('pointerdown', function (event) {
      for (var m = 0; m < menus.length; m++) if (!menus[m].contains(event.target)) setOpen(menus[m], false, false);
    });
    // 3. The copy button beside `npx yokoten`: copies the command, says so for two seconds.
    var copies = document.querySelectorAll('[data-copy]');
    for (var k = 0; k < copies.length; k++) {
      copies[k].hidden = false;
      copies[k].addEventListener('click', function (event) {
        var button = event.currentTarget;
        var done = function () {
          button.setAttribute('data-done', '');
          setTimeout(function () {
            button.removeAttribute('data-done');
          }, 2000);
        };
        try {
          navigator.clipboard.writeText(button.getAttribute('data-copy')).then(done, function () {});
        } catch (e) {}
      });
    }
    var links = document.querySelectorAll('a[data-lang]');
    for (var j = 0; j < links.length; j++) {
      links[j].addEventListener('click', function (event) {
        store('yokoten.lang', event.currentTarget.getAttribute('data-lang'));
      });
    }
  });

  var nav = (navigator.language || '').toLowerCase();
  var browser = /^zh-(hant|tw|hk|mo)\b/.test(nav) ? 'tw' : /^zh\b/.test(nav) ? 'zh' : /^ja\b/.test(nav) ? 'ja' : 'en';

  var first = (location.pathname.split('/')[1] || '').toLowerCase();
  var current = 'en';
  for (var k in LANGS) if (LANGS[k].dir && LANGS[k].dir === first) current = k;
  var page = html.getAttribute('data-page');

  if (page === '404') {
    var lang = current !== 'en' ? current : saved || browser;
    if (lang !== 'en') {
      html.lang = LANGS[lang].html;
      document.title = LANGS[lang].notFound + ' · yokoten';
    }
    return;
  }
  if (!Object.prototype.hasOwnProperty.call(SLUGS, page)) return;
  // An English URL is also the default one, so only there does the browser's language count.
  var want = saved || (current !== 'en' ? current : browser);
  if (want === current) return;
  var dir = LANGS[want].dir;
  html.style.visibility = 'hidden';
  var sub = html.getAttribute('data-sub');
  location.replace((dir ? '/' + dir + '/' : '/') + SLUGS[page] + (sub ? '/' + sub : '') + location.search + location.hash);
})();

// How long this page was on screen, sent once to the Worker (POST /stay, worker/index.js) when the
// visitor first leaves the page or hides its tab. Time in a background tab does not count. It sends
// only the path and the seconds: no cookie, no id, nothing stored in the browser.
(function () {
  if (navigator.webdriver || typeof navigator.sendBeacon !== 'function') return;
  var shown = 0;
  var since = document.visibilityState === 'visible' ? performance.now() : -1;
  var sent = false;
  function send() {
    if (sent) return;
    if (since >= 0) shown += performance.now() - since;
    since = -1;
    sent = true;
    var path = location.pathname.toLowerCase().replace(/\/+$/, '') || '/';
    navigator.sendBeacon('/stay', JSON.stringify({ p: path, s: Math.round(shown / 1000) }));
  }
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') send();
    else if (!sent) since = performance.now();
  });
  // Some browsers close a page without a visibilitychange first.
  addEventListener('pagehide', send);
})();
