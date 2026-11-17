/* Счётчик игровых постов: в постах и в профиле.
   Числа берутся из файла postcount.json в GitHub (обновляется раз в час).
   К API форума скрипт не обращается. Файл кэшируется в браузере на CACHE_MS. */
(function () {
  if (window.__gamePostsInit) return;
  window.__gamePostsInit = true;

  var DATA_URL = 'https://raw.githubusercontent.com/OWNER/REPO/data/postcount.json';
  var LABEL = 'Игровых постов:';
  var CACHE_MS = 60 * 60 * 1000;
  var KEY = 'gamePosts_v1';

  var postEls = document.querySelectorAll('.post[data-user-id]');
  var profileId = /\/profile\.php$/.test(location.pathname) && !/section=/.test(location.search)
    ? (location.search.match(/[?&]id=(\d+)/) || [])[1] : null;
  if (!postEls.length && !profileId) return;

  function put(ul, html, afterSel) {
    var li = ul.querySelector('.pa-gameposts');
    if (!li) {
      li = document.createElement('li');
      li.className = 'pa-gameposts';
      var after = afterSel && ul.querySelector(afterSel);
      if (after && after.nextSibling) ul.insertBefore(li, after.nextSibling); else ul.appendChild(li);
    }
    li.innerHTML = html;
  }

  function render(totals) {
    Array.prototype.forEach.call(postEls, function (post) {
      var ul = post.querySelector('.post-author ul');
      if (ul) put(ul, '<span>' + LABEL + '</span> ' + (totals[post.getAttribute('data-user-id')] || 0), '.pa-posts');
    });
    if (profileId) {
      var pul = document.querySelector('#viewprofile #profile-right ul');
      if (pul) put(pul, '<span>' + LABEL + '</span> <strong>' + (totals[profileId] || 0) + '</strong>');
    }
  }

  var cache = null;
  try { cache = JSON.parse(localStorage.getItem(KEY)); } catch (e) {}
  if (cache && cache.totals) render(cache.totals);
  if (cache && Date.now() - cache.at < CACHE_MS) return;

  fetch(DATA_URL + '?t=' + Math.floor(Date.now() / CACHE_MS))
    .then(function (r) { return r.json(); })
    .then(function (d) {
      if (!d || !d.totals) return;
      try { localStorage.setItem(KEY, JSON.stringify({ at: Date.now(), totals: d.totals })); } catch (e) {}
      render(d.totals);
    })
    .catch(function () {});
})();
