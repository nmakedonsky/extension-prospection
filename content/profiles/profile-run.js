/**
 * Aspiration profil LinkedIn → Supabase saved_prospects.
 * Accumule Voyager + BPR (`<code>`) + DOM ; ré-upsert quand le JSON s’enrichit.
 */
(function pnProfileRun() {
  if (window.__pnProfileRunInstalled) return;
  window.__pnProfileRunInstalled = true;

  /** @type {string|null} */
  let lastUpsertKey = null;
  let lastUpsertMs = 0;
  let pendingTimer = null;
  /** @type {{ kind: string, url: string, at: number, data: object }[]} */
  let captures = [];
  let hookSeen = false;
  let attemptCount = 0;

  function log(event, data, level) {
    try {
      chrome.runtime.sendMessage({
        type: 'EXTENSION_LOG',
        event,
        level: level || 'info',
        data: { ...(data || {}), pageUrl: location.href }
      });
    } catch (_) {}
  }

  function currentProfileUrl() {
    return typeof pnNormalizeLinkedInProfileUrl === 'function'
      ? pnNormalizeLinkedInProfileUrl(location.href)
      : null;
  }

  function captureScore(c) {
    try {
      return JSON.stringify(c.data || {}).length;
    } catch (_) {
      return 0;
    }
  }

  function addCapture(kind, url, data) {
    if (!data || typeof data !== 'object') return;
    // Évite les doublons exacts trop gros : compare taille + url
    const score = (() => {
      try {
        return JSON.stringify(data).length;
      } catch (_) {
        return 0;
      }
    })();
    if (score < 80) return;
    const dup = captures.find(
      (c) => c.url === url && Math.abs(captureScore(c) - score) < 32
    );
    if (dup) return;
    captures.push({ kind: kind || 'voyager', url: url || '', at: Date.now(), data });
    if (captures.length > 16) {
      captures.sort((a, b) => captureScore(b) - captureScore(a));
      captures = captures.slice(0, 12);
    }
  }

  function ingestBpr() {
    if (typeof pnCollectBprCodePayloads !== 'function') return 0;
    const list = pnCollectBprCodePayloads();
    let n = 0;
    for (const item of list) {
      addCapture('bpr', item.id || 'bpr', item.data);
      n += 1;
    }
    return n;
  }

  function mergedPayload() {
    if (!captures.length) return null;
    if (captures.length === 1) return captures[0].data;
    // Fusion légère : objet racine + included concat
    const root = { _pn_merged: true, parts: [] };
    for (const c of captures) {
      root.parts.push(c.data);
    }
    return root;
  }

  function onPathMaybe() {
    if (typeof pnIsProfilePath === 'function' && !pnIsProfilePath(location.pathname)) {
      captures = [];
      lastUpsertKey = null;
      return;
    }
    scheduleUpsert('nav');
  }

  function scheduleUpsert(reason) {
    if (typeof pnIsProfilePath === 'function' && !pnIsProfilePath(location.pathname)) return;
    if (pendingTimer) clearTimeout(pendingTimer);
    pendingTimer = setTimeout(() => {
      pendingTimer = null;
      void doUpsert(reason);
    }, reason === 'voyager' || reason === 'bpr' ? 500 : 900);
  }

  function mergeFields(a, b) {
    const out = { ...(a || {}) };
    for (const [k, v] of Object.entries(b || {})) {
      if (k === 'profile_entity' || k === 'linkedin_profile_json') continue;
      if (v != null && String(v).trim() !== '') out[k] = v;
    }
    return out;
  }

  function fieldsFromJsonLd(pageUrl) {
    try {
      const nodes = document.querySelectorAll('script[type="application/ld+json"]');
      for (const node of nodes) {
        let data;
        try {
          data = JSON.parse(node.textContent || '');
        } catch (_) {
          continue;
        }
        const list = Array.isArray(data) ? data : [data];
        for (const item of list) {
          if (!item || typeof item !== 'object') continue;
          const type = item['@type'];
          const isPerson =
            type === 'Person' || (Array.isArray(type) && type.includes('Person'));
          if (!isPerson) continue;
          const name = String(item.name || '').replace(/\s+/g, ' ').trim();
          const parts = name.split(/\s+/).filter(Boolean);
          return {
            linkedin_url: pageUrl,
            linkedin_slug:
              typeof pnLinkedInSlugFromUrl === 'function' ? pnLinkedInSlugFromUrl(pageUrl) : null,
            first_name: parts[0] || null,
            last_name: parts.slice(1).join(' ') || null,
            full_name: name || null,
            job_title: item.jobTitle ? String(item.jobTitle).trim() : null,
            company_name: item.worksFor?.name ? String(item.worksFor.name).trim() : null,
            location: item.address?.addressLocality
              ? String(item.address.addressLocality).trim()
              : null,
            source: 'extension'
          };
        }
      }
    } catch (_) {}
    return null;
  }

  function minimalFields(pageUrl) {
    const slug =
      typeof pnLinkedInSlugFromUrl === 'function' ? pnLinkedInSlugFromUrl(pageUrl) : null;
    let full = '';
    let job = '';
    const title = String(document.title || '')
      .replace(/\s*\|\s*LinkedIn\s*$/i, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (title) {
      const parts = title.split(/\s[-–—]\s/);
      full = (parts[0] || '').trim();
      job = (parts.slice(1).join(' - ') || '').trim();
    }
    const nameParts = full.split(/\s+/).filter(Boolean);
    return {
      linkedin_url: pageUrl,
      linkedin_slug: slug,
      first_name: nameParts[0] || null,
      last_name: nameParts.slice(1).join(' ') || null,
      full_name: full || null,
      job_title: job || null,
      company_name: null,
      location: null,
      source: 'extension'
    };
  }

  async function doUpsert(reason) {
    const pageUrl = currentProfileUrl();
    if (!pageUrl) {
      log('prospect_capture_skip', { reason, why: 'bad_url' }, 'warn');
      return;
    }

    attemptCount += 1;
    ingestBpr();

    let fields = null;
    let from = [];
    const merged = mergedPayload();

    if (merged && typeof pnFieldsFromVoyagerPayload === 'function') {
      // Parser chaque capture puis merger les champs (expérience peut être dans un autre call)
      for (const c of captures) {
        const v = pnFieldsFromVoyagerPayload(c.data, pageUrl);
        if (v) {
          fields = fields ? mergeFields(fields, v) : v;
          from.push(c.kind);
        }
      }
    }

    if (typeof pnFieldsFromDom === 'function') {
      const dom = pnFieldsFromDom(pageUrl);
      if (dom) {
        fields = fields ? mergeFields(fields, dom) : dom;
        from.push('dom');
      }
    }

    const ld = fieldsFromJsonLd(pageUrl);
    if (ld) {
      fields = fields ? mergeFields(fields, ld) : ld;
      from.push('jsonld');
    }

    if (!fields) {
      fields = minimalFields(pageUrl);
      from.push('minimal');
    } else {
      fields = mergeFields(minimalFields(pageUrl), fields);
    }

    if (!fields.linkedin_url) return;

    // Toujours un JSON (DOM riche ± Voyager) pour enrichissement ultérieur
    const profileJson =
      typeof pnBuildProfileSnapshot === 'function'
        ? pnBuildProfileSnapshot(captures, pageUrl)
        : null;

    const jsonScore = profileJson
      ? Math.min(
          9,
          Math.floor(
            (JSON.stringify(profileJson).length +
              (profileJson.about ? 2000 : 0) +
              ((profileJson.experience || []).length || 0) * 400) /
              8000
          )
        )
      : 0;

    const richness = [
      fields.full_name ? 'n' : '',
      fields.job_title ? 't' : '',
      fields.company_name ? 'c' : '',
      fields.location ? 'l' : '',
      profileJson?.about ? 'a' : '',
      (profileJson?.experience || []).length ? `e${Math.min(9, profileJson.experience.length)}` : '',
      jsonScore ? `j${jsonScore}` : '',
      captures.length ? `v${Math.min(9, captures.length)}` : ''
    ].join('');

    const key = `${fields.linkedin_url}|${richness}`;
    const now = Date.now();
    // Re-upsert si plus riche, sinon debounce 12s
    const richer =
      lastUpsertKey &&
      key !== lastUpsertKey &&
      richness.length > String(lastUpsertKey.split('|')[1] || '').length;
    if (key === lastUpsertKey && now - lastUpsertMs < 12000) return;
    if (!richer && lastUpsertKey && lastUpsertKey.startsWith(fields.linkedin_url) && now - lastUpsertMs < 5000) {
      // laisse passer si même URL mais on vient d’upsert ; sauf si vraiment plus riche
      if (!richer && key === lastUpsertKey) return;
    }
    lastUpsertKey = key;
    lastUpsertMs = now;

    const payload = {
      ...fields,
      linkedin_profile_json: profileJson,
      capture_reason: reason,
      capture_api_url: captures[0]?.url || null,
      page_url: location.href,
      capture_from: [...new Set(from)].join('+'),
      capture_count: captures.length,
      hook_seen: hookSeen
    };
    delete payload.profile_entity;

    log('prospect_capture_attempt', {
      reason,
      from: payload.capture_from,
      slug: fields.linkedin_slug,
      has_json: !!profileJson,
      capture_count: captures.length,
      full_name: fields.full_name || null,
      job_title: fields.job_title || null,
      company_name: fields.company_name || null,
      hook_seen: hookSeen,
      attempt: attemptCount
    });

    try {
      const r = await chrome.runtime.sendMessage({ type: 'UPSERT_LINKEDIN_PROSPECT', payload });
      if (!r || !r.ok) {
        log(
          'prospect_capture_fail',
          { error: r?.error || 'no_response', detail: r?.detail || null, slug: fields.linkedin_slug },
          'error'
        );
      }
    } catch (e) {
      log(
        'prospect_capture_fail',
        { error: String(e && e.message ? e.message : e), slug: fields.linkedin_slug },
        'error'
      );
    }
  }

  window.addEventListener('message', (ev) => {
    if (ev.source !== window) return;
    const d = ev.data;
    if (!d || d.source !== 'pn-linkedin-profile') return;
    if (d.kind === 'hook_ready') {
      hookSeen = true;
      log('prospect_hook_ready', { path: location.pathname });
      // Demander le buffer immédiatement
      try {
        window.postMessage({ source: 'pn-linkedin-profile-req', kind: 'drain' }, '*');
      } catch (_) {}
      return;
    }
    if (d.kind === 'drain' && d.data && Array.isArray(d.data.items)) {
      hookSeen = true;
      for (const item of d.data.items) {
        if (item && item.data) addCapture(item.kind || 'voyager', item.url || '', item.data);
      }
      if (d.data.items.length) scheduleUpsert('drain');
      return;
    }
    if (!d.data) return;
    addCapture(d.kind || 'voyager', d.url || '', d.data);
    scheduleUpsert('voyager');
  });

  // Drain proactif (race)
  try {
    window.postMessage({ source: 'pn-linkedin-profile-req', kind: 'drain' }, '*');
  } catch (_) {}
  [100, 400, 1200, 3000].forEach((ms) => {
    setTimeout(() => {
      try {
        window.postMessage({ source: 'pn-linkedin-profile-req', kind: 'drain' }, '*');
      } catch (_) {}
    }, ms);
  });

  // SPA
  let lastPath = location.pathname + location.search;
  setInterval(() => {
    const p = location.pathname + location.search;
    if (p !== lastPath) {
      lastPath = p;
      captures = [];
      attemptCount = 0;
      hookSeen = false;
      onPathMaybe();
    }
  }, 800);

  // Scan BPR léger (pas de MutationObserver subtree — concurrençait le rendu LinkedIn)
  let lastBprScan = 0;
  function maybeScanBpr() {
    const now = Date.now();
    if (now - lastBprScan < 1500) return;
    lastBprScan = now;
    if (typeof pnIsProfilePath === 'function' && !pnIsProfilePath(location.pathname)) return;
    if (ingestBpr() > 0) scheduleUpsert('bpr');
  }

  if (document.readyState === 'complete') onPathMaybe();
  else window.addEventListener('load', () => onPathMaybe(), { once: true });

  [400, 1200, 2500, 5000, 9000, 15000].forEach((ms) => {
    setTimeout(() => {
      maybeScanBpr();
      scheduleUpsert('retry_' + ms);
    }, ms);
  });
})();
