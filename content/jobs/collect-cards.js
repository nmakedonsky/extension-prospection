/** Collecte des cartes offre (search-results vs collections). */

function collectJobCardsSearchResults() {
  const roots = getScanRoots();
  const seen = new Set();
  const cards = [];
  for (const root of roots) {
    for (const sel of JOB_CARD_SELECTORS) {
      for (const el of querySelectorAllDeep(root, sel)) {
        if (seen.has(el)) continue;
        if (isNodeInJobDetailsComposed(el)) continue;
        if (!isLikelyLeftColumnJobCard(el)) continue;
        seen.add(el);
        cards.push(el);
      }
    }
  }
  return cards;
}

function collectJobCardsCollections() {
  const roots = getScanRoots();
  const seen = new Set();
  const cards = [];

  function pushCard(el) {
    if (!el || seen.has(el)) return;
    if (isNodeInJobDetailsComposed(el)) return;
    if (!isLikelyCollectionsListCard(el)) return;
    seen.add(el);
    cards.push(el);
  }

  const custom = pageConfig.linkedinCollectionsCardCss;
  if (custom) {
    for (const root of roots) {
      try {
        querySelectorAllDeep(root, custom).forEach(pushCard);
      } catch (_) {}
    }
    if (cards.length) return cards;
  }

  for (const root of roots) {
    for (const sel of JOB_CARD_SELECTORS) {
      try {
        for (const el of querySelectorAllDeep(root, sel)) {
          pushCard(el);
        }
      } catch (_) {}
    }
  }

  const vw = window.innerWidth || 1200;
  for (const root of roots) {
    for (const a of querySelectorAllDeep(root, JOB_VIEW_LINK_SELECTOR)) {
      if (isNodeInJobDetailsComposed(a)) continue;
      const r = a.getBoundingClientRect?.();
      if (!r) continue;
      const inList =
        r.right < vw * 0.58 || r.left + r.width / 2 <= vw * 0.72;
      if (!inList) continue;
      const card = inferCardWrapperFromJobLink(a);
      pushCard(card);
    }
  }

  return cards;
}

function collectJobCards() {
  return isJobsCollectionsPath() ? collectJobCardsCollections() : collectJobCardsSearchResults();
}
