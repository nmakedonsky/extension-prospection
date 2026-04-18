/** Construction du panneau : actions en tête, score, métriques compactes, HubSpot. */

let lastFinancialCardJobWrapper = null;

function populateFinancialPanel(companyName, jobInfo = {}) {
  const { type, jobTitle, jobUrl, companyContext, jobWrapper } = jobInfo;
  lastFinancialCardJobWrapper = jobWrapper && jobWrapper.isConnected ? jobWrapper : null;

  ensureFinancialDock();
  const body = getDockBody();
  body.querySelector('.lph-financial-dock__placeholder')?.remove();

  const card = getFinancialCardMount();
  card.classList.add('lph-financial-card--compact');
  while (card.firstChild) card.removeChild(card.firstChild);

  if (jobUrl) {
    card.dataset.lphJobUrl = jobUrl;
    card.classList.add('lph-financial-card--clickable');
    card.title = 'Cliquer pour ouvrir l’offre';
  } else {
    delete card.dataset.lphJobUrl;
    card.classList.remove('lph-financial-card--clickable');
    card.removeAttribute('title');
  }

  const title = document.createElement('div');
  title.className = 'lph-financial-card__title';
  title.textContent = companyName;
  card.appendChild(title);

  const actionsRow = document.createElement('div');
  actionsRow.className =
    'lph-financial-card__actions' + (!type ? ' lph-financial-card__actions--solo' : '');

  const financialBtn = document.createElement('button');
  financialBtn.type = 'button';
  financialBtn.className = 'lph-financial-card__financial-btn lph-financial-card__action-btn';
  financialBtn.textContent = 'Charger';
  financialBtn.title = 'Charger les données financières';

  const hubspotBtn = document.createElement('button');
  hubspotBtn.type = 'button';
  hubspotBtn.className = 'lph-financial-card__hubspot-btn lph-financial-card__action-btn';
  hubspotBtn.textContent = 'HubSpot';
  hubspotBtn.title = 'Ajouter ou mettre à jour dans HubSpot';
  if (!type) hubspotBtn.style.display = 'none';

  actionsRow.appendChild(financialBtn);
  actionsRow.appendChild(hubspotBtn);
  card.appendChild(actionsRow);

  const hubspotStatus = document.createElement('div');
  hubspotStatus.className = 'lph-financial-card__hubspot-status';
  hubspotStatus.textContent = type ? 'HubSpot…' : '';
  if (!type) hubspotStatus.style.display = 'none';
  card.appendChild(hubspotStatus);

  const scoreRow = document.createElement('div');
  scoreRow.className = 'lph-financial-card__score-row';

  const scoreEl = document.createElement('div');
  scoreEl.className = 'lph-financial-card__score';
  scoreEl.textContent = '—';

  const confidenceEl = document.createElement('div');
  confidenceEl.className = 'lph-financial-card__confidence';
  confidenceEl.hidden = true;

  scoreRow.appendChild(scoreEl);
  scoreRow.appendChild(confidenceEl);
  card.appendChild(scoreRow);

  const summaryEl = document.createElement('div');
  summaryEl.className = 'lph-financial-card__summary';
  summaryEl.setAttribute('aria-live', 'polite');
  summaryEl.hidden = true;
  card.appendChild(summaryEl);

  const metricsWrap = document.createElement('div');
  metricsWrap.className = 'lph-financial-card__metrics-wrap';

  const metricsPanel = document.createElement('div');
  metricsPanel.className = 'lph-financial-card__metrics-panel';
  metricsPanel.setAttribute('aria-hidden', 'false');

  const list = document.createElement('ul');
  list.className = 'lph-financial-card__list lph-financial-card__list--compact';
  list.id = `lph-financial-metrics-${Date.now()}`;

  const financialStatus = document.createElement('div');
  financialStatus.className = 'lph-financial-card__financial-status';

  metricsPanel.appendChild(list);
  metricsPanel.appendChild(financialStatus);

  metricsWrap.appendChild(metricsPanel);
  card.appendChild(metricsWrap);

  const updateSummary = (response) => {
    const st = response?.companySummary && String(response.companySummary).trim();
    if (st) {
      summaryEl.textContent = st;
      summaryEl.hidden = false;
    } else {
      summaryEl.textContent = '';
      summaryEl.hidden = true;
    }

    if (!response?.ok || !response.unified) return;
    const score = response.score ?? response.unified?.score;
    const confRaw = response.unified?.confidence ?? response.confidence;
    if (score != null && Number.isFinite(Number(score))) {
      const n = Math.round(Number(score));
      scoreEl.textContent = `${n} / 100`;
      scoreEl.className =
        'lph-financial-card__score ' +
        (n >= 58 ? 'lph-financial-card__score--ok' : n >= 38 ? 'lph-financial-card__score--warn' : 'lph-financial-card__score--low');
    } else {
      scoreEl.textContent = '—';
      scoreEl.className = 'lph-financial-card__score';
    }
    if (confRaw != null && Number.isFinite(Number(confRaw))) {
      const p = Math.round(Number(confRaw) * 100);
      confidenceEl.textContent = `Confiance ${p} %`;
      confidenceEl.hidden = false;
      confidenceEl.className =
        'lph-financial-card__confidence ' +
        (p >= 80
          ? 'lph-financial-card__confidence--ok'
          : p >= 50
            ? 'lph-financial-card__confidence--mid'
            : 'lph-financial-card__confidence--low');
    } else {
      confidenceEl.textContent = '';
      confidenceEl.hidden = true;
      confidenceEl.className = 'lph-financial-card__confidence';
    }
  };

  const applyFinancialResponse = (response) => {
    if (!response?.ok || !response.data) return false;
    renderFinancialMetrics(list, response);
    updateSummary(response);

    financialBtn.textContent = 'Rafraîchir';
    financialBtn.title = 'Rafraîchir les données financières';
    if (response?.supabase?.ok === false) {
      financialStatus.textContent = 'Supabase indisponible';
      financialStatus.classList.add('lph-financial-card__financial-status--warn');
    } else if (response.partial) {
      financialStatus.textContent = 'Données partielles';
      financialStatus.classList.add('lph-financial-card__financial-status--warn');
    } else {
      financialStatus.textContent = '';
      financialStatus.classList.remove('lph-financial-card__financial-status--warn');
    }
    return true;
  };

  financialBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    financialBtn.disabled = true;
    financialBtn.textContent = '…';
    financialStatus.textContent = '';
    sendRuntimeMessageSafe(
      { action: 'getFinancialData', companyName, forceRefresh: true, companyContext: companyContext || null },
      (response, error) => {
        if (error) {
          financialBtn.disabled = false;
          financialBtn.textContent = 'Réessayer';
          financialStatus.textContent = 'Erreur de communication';
          financialStatus.classList.add('lph-financial-card__financial-status--warn');
          return;
        }
        if (!response?.ok || !response.data) {
          financialBtn.disabled = false;
          financialBtn.textContent = 'Réessayer';
          financialStatus.textContent = response?.error || 'Données indisponibles';
          financialStatus.classList.add('lph-financial-card__financial-status--warn');
          return;
        }
        financialBtn.disabled = false;
        applyFinancialResponse(response);
      }
    );
  });

  hubspotBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!type) return;
    hubspotBtn.disabled = true;
    hubspotBtn.textContent = '…';
    sendRuntimeMessageSafe(
      { action: 'addToHubSpot', companyName, type, jobTitle, jobUrl },
      (response, error) => {
        if (error) {
          hubspotBtn.textContent = 'Erreur';
          hubspotBtn.disabled = false;
          return;
        }
        if (response?.ok) {
          hubspotBtn.textContent = response.updated ? 'Mis à jour ✓' : 'Ajouté ✓';
          hubspotStatus.textContent = 'Déjà dans HubSpot';
          hubspotStatus.classList.remove('lph-financial-card__hubspot-status--new');
          hubspotStatus.classList.add('lph-financial-card__hubspot-status--exists');
        } else {
          hubspotBtn.textContent = response?.error ? `Erreur: ${String(response.error).slice(0, 80)}` : 'Erreur';
          hubspotBtn.disabled = false;
        }
      }
    );
  });

  sendRuntimeMessageSafe(
    { action: 'getFinancialData', companyName, forceRefresh: false, companyContext: companyContext || null },
    (response, error) => {
      if (error || !financialStatus.isConnected) return;
      if (applyFinancialResponse(response)) {
        financialStatus.classList.remove('lph-financial-card__financial-status--warn');
      }
    }
  );

  if (type) {
    sendRuntimeMessageSafe({ action: 'checkHubSpotCompany', companyName }, (hs, error) => {
      if (error || !hubspotStatus.isConnected) return;
      if (!hs?.configured) {
        hubspotStatus.textContent = 'Configure la clé HubSpot dans la popup';
        return;
      }
      if (hs.exists) {
        hubspotStatus.textContent = 'Déjà dans HubSpot';
        hubspotStatus.classList.add('lph-financial-card__hubspot-status--exists');
        hubspotBtn.textContent = 'Mettre à jour';
        hubspotBtn.title = 'Mettre à jour dans HubSpot';
      } else {
        hubspotStatus.textContent = 'Pas encore dans HubSpot';
        hubspotStatus.classList.add('lph-financial-card__hubspot-status--new');
      }
    });
  }

  card.style.display = 'block';
}
