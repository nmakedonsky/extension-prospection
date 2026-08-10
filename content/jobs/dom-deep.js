/**
 * Parcours DOM incluant shadow roots.
 *
 * Perf : la détection des shadow hosts (`querySelectorAll('*')` sur tout le sous-arbre)
 * est très coûteuse et cette fonction est appelée des dizaines de fois par tick
 * (déclenché par MutationObserver à chaque frame pendant les transitions Jobdesk).
 * On met donc en cache la liste globale des shadow roots (TTL court) au lieu de
 * refaire un scan complet du DOM à chaque appel.
 */

let __pnShadowRootsCache = { at: 0, list: [] };
const PN_SHADOW_CACHE_TTL_MS = 200;

function pnCollectAllShadowRoots() {
  const found = [];
  function walk(r) {
    let hosts;
    try {
      hosts = r.querySelectorAll('*');
    } catch (_) {
      return;
    }
    hosts.forEach((host) => {
      if (host.shadowRoot) {
        found.push({ host, shadowRoot: host.shadowRoot });
        walk(host.shadowRoot);
      }
    });
  }
  try {
    walk(document);
  } catch (_) {}
  return found;
}

function pnGetShadowRootsCached() {
  const now = Date.now();
  if (now - __pnShadowRootsCache.at > PN_SHADOW_CACHE_TTL_MS) {
    __pnShadowRootsCache = { at: now, list: pnCollectAllShadowRoots() };
  }
  return __pnShadowRootsCache.list;
}

function querySelectorAllDeep(root, selector) {
  if (!root?.querySelectorAll) return [];
  const out = [];
  try {
    root.querySelectorAll(selector).forEach((el) => out.push(el));
  } catch (_) {
    return out;
  }
  const shadowRoots = pnGetShadowRootsCached();
  if (!shadowRoots.length) return out;
  const isDocRoot = root === document;
  for (const { host, shadowRoot } of shadowRoots) {
    if (!isDocRoot) {
      try {
        if (!root.contains || !root.contains(host)) continue;
      } catch (_) {
        continue;
      }
    }
    try {
      shadowRoot.querySelectorAll(selector).forEach((el) => out.push(el));
    } catch (_) {}
  }
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
