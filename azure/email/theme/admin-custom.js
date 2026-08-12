/* Tab title + favicon — CSS can't reach these. Vue rewrites title per route. */
(function () {
  var NAME = 'EAGLE Mail';
  function fix() {
    if (document.title.indexOf('listmonk') !== -1) {
      document.title = document.title.replace(/listmonk/g, NAME);
    }
  }
  fix();
  new MutationObserver(fix).observe(document.querySelector('title'), { childList: true });

  var icon = document.querySelector('link[rel="icon"]');
  if (!icon) {
    icon = document.createElement('link');
    icon.rel = 'icon';
    document.head.appendChild(icon);
  }
  icon.href = '/uploads/bcgov-header-vert-SM.png';
})();
