/** Badges SS2I / Client + appel background CLASSIFY_COMPANY. */

function createBadge(kind) {
  const span = document.createElement('span');
  span.className =
    'pn-badge ' +
    (kind === 'loading'
      ? 'pn-badge--loading'
      : kind === 'Client'
        ? 'pn-badge--client'
        : 'pn-badge--ss2i');
  span.textContent = kind === 'loading' ? '…' : kind === 'Client' ? 'Client' : 'SS2I';
  span.setAttribute('data-prospection-badge', '1');
  return span;
}

function sendClassify(companyName) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage({ type: 'CLASSIFY_COMPANY', companyName }, (res) => {
        if (chrome.runtime.lastError) {
          resolve(null);
          return;
        }
        resolve(res === 'Client' || res === 'SS2I' ? res : null);
      });
    } catch (_) {
      resolve(null);
    }
  });
}

async function processCard(card) {
  if (!isClassificationTargetPage()) return;
  const cel = findCompanyElementInCard(card);
  const companyName = extractCompanyName(cel);
  if (!companyName || companyName.length < 2) return;
  if (card.hasAttribute(DATA_PROCESSED)) return;
  if (card.hasAttribute(DATA_LOADING)) return;
  const failedAt = Number(card.getAttribute(DATA_FAILED) || '0');
  if (failedAt && Date.now() - failedAt < 15000) return;

  const hostEl = cel;
  if (!hostEl || isNodeInJobDetailsComposed(card)) return;

  card.setAttribute(DATA_LOADING, 'true');
  hostEl.querySelectorAll('.pn-badge').forEach((b) => b.remove());
  const placeholder = createBadge('loading');
  hostEl.appendChild(placeholder);

  try {
    const type = await sendClassify(companyName);
    if (placeholder.isConnected) placeholder.remove();
    card.removeAttribute(DATA_LOADING);
    if (!type) {
      card.setAttribute(DATA_FAILED, String(Date.now()));
      return;
    }
    card.setAttribute(DATA_PROCESSED, 'true');
    card.setAttribute(DATA_TYPE, type);
    card.removeAttribute(DATA_FAILED);
    if (type === 'Client') {
      prefetchFinancialDataForClient(card, companyName);
    }
    const el = findCompanyElementInCard(card);
    if (el && !isNodeInJobDetailsComposed(el)) {
      el.querySelectorAll('.pn-badge').forEach((b) => b.remove());
      el.appendChild(createBadge(type));
    }
  } catch (_) {
    if (placeholder.isConnected) placeholder.remove();
    card.removeAttribute(DATA_LOADING);
    card.setAttribute(DATA_FAILED, String(Date.now()));
  }
}

let classifyDebounce = null;

async function runClassificationPass() {
  if (!isClassificationTargetPage()) return;

  const passStarted = performance.now();
  const cards = collectJobCards();
  const todo = [];
  for (const card of cards) {
    if (card.hasAttribute(DATA_PROCESSED)) continue;
    if (card.hasAttribute(DATA_LOADING)) continue;
    const failedAt = Number(card.getAttribute(DATA_FAILED) || '0');
    if (failedAt && Date.now() - failedAt < 15000) continue;
    const cel = findCompanyElementInCard(card);
    const name = extractCompanyName(cel);
    if (!name || name.length < 2) continue;
    todo.push(card);
  }

  const concurrency = 3;
  let wi = 0;
  async function worker() {
    while (true) {
      const idx = wi++;
      if (idx >= todo.length) return;
      const card = todo[idx];
      if (card?.isConnected) await processCard(card);
    }
  }
  const n = Math.min(concurrency, Math.max(1, todo.length));
  await Promise.all(Array.from({ length: n }, () => worker()));

  const passMs = Math.round(performance.now() - passStarted);
  if (typeof pnRecordClassificationPass === 'function') {
    pnRecordClassificationPass(passMs, todo.length);
  }
}

function scheduleClassification() {
  if (!isClassificationTargetPage()) return;
  if (classifyDebounce) clearTimeout(classifyDebounce);
  classifyDebounce = setTimeout(() => {
    classifyDebounce = null;
    void runClassificationPass();
  }, 140);
}
