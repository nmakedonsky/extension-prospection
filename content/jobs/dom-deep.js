/** Parcours DOM incluant shadow roots. */

function querySelectorAllDeep(root, selector) {
  if (!root?.querySelectorAll) return [];
  const out = [];
  function searchInRoot(r) {
    try {
      r.querySelectorAll(selector).forEach((el) => out.push(el));
    } catch (_) {}
    let hosts;
    try {
      hosts = r.querySelectorAll('*');
    } catch (_) {
      return;
    }
    hosts.forEach((host) => {
      if (host.shadowRoot) searchInRoot(host.shadowRoot);
    });
  }
  searchInRoot(root);
  return out;
}

function getScanRoots() {
  const roots = [];
  const main = document.querySelector('main');
  const app = document.querySelector('#root');
  if (main) roots.push(main);
  if (app && app !== main) roots.push(app);
  if (!roots.length) roots.push(document.body);
  return roots;
}
