/**
 * MAIN world — capture profil via URL *ou* body requête GraphQL.
 * Ne clone la réponse que si la requête semble liée au profil (évite de casser l’UI).
 */
(function pnProfilePageHook() {
  if (window.__pnProfileHookV2) return;
  window.__pnProfileHookV2 = true;

  const MAX_TEXT = 1_500_000;
  /** @type {{ kind: string, url: string, data: object, t: number }[]} */
  const buf = [];
  window.__pnProfileBuf = buf;

  function post(kind, url, data) {
    const msg = {
      source: 'pn-linkedin-profile',
      kind: kind || 'voyager',
      url: String(url || '').slice(0, 2000),
      data: data,
      t: Date.now()
    };
    try {
      if (kind === 'voyager' && data) {
        buf.push({ kind: 'voyager', url: msg.url, data, t: msg.t });
        if (buf.length > 20) buf.splice(0, buf.length - 16);
      }
    } catch (_) {}
    try {
      window.postMessage(msg, '*');
    } catch (_) {}
  }

  function resolveUrl(input) {
    try {
      if (!input) return '';
      if (typeof input === 'string') return new URL(input, location.href).href;
      if (typeof input.url === 'string') return new URL(input.url, location.href).href;
      return String(input);
    } catch (_) {
      return String(input || '');
    }
  }

  function bodyToString(body) {
    if (body == null) return '';
    if (typeof body === 'string') return body;
    try {
      if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) {
        return body.toString();
      }
    } catch (_) {}
    // FormData / Blob / ReadableStream : on ne lit pas (trop risqué)
    return '';
  }

  /** Mots-clés profil dans URL ou body — assez précis pour éviter le flood GraphQL UI. */
  function looksLikeProfileRequest(url, bodyStr) {
    const u = String(url || '');
    const b = String(bodyStr || '');
    const hay = u + '\n' + b;

    // Endpoints identité classiques
    if (/\/voyager\/api\/identity\//i.test(u)) return true;
    if (/\/voyager\/api\/.*dash\/profiles/i.test(u)) return true;

    // Hors voyager/graphql → ignorer
    if (!/\/voyager\/api\//i.test(u) && !/\/graphql/i.test(u)) return false;

    // Signaux profil (URL + body POST GraphQL)
    if (
      /publicIdentifier|vanityName|fsd_profile|fs_miniProfile|ProfileUrn|profileUrn|ProfileWithTier|ProfileTopCard|ProfilePagedListComponent|ProfileTreatments|ProfileActions|ProfileInterestGroups|ProfileSkills|ProfileExperience|ProfileEducation|ProfileLanguages|ProfileCertifications|com\.linkedin\.voyager\.dash\.identity\.profile|IdentityDashProfile|VoyagerIdentityDashProfiles/i.test(
        hay
      )
    ) {
      return true;
    }

    // Variables GraphQL typiques : vanityName / publicIdentifier en clair
    if (/"vanityName"\s*:\s*"/i.test(b) || /"publicIdentifier"\s*:\s*"/i.test(b)) return true;

    // queryId / operation souvent présents avec le slug du profil courant
    try {
      const slug = (location.pathname.match(/\/in\/([^/]+)/i) || [])[1];
      if (slug && slug.length > 2 && hay.includes(decodeURIComponent(slug))) {
        // Ne matcher le slug seul que sur graphql (évite bruit)
        if (/\/graphql/i.test(u) || /\/voyager\/api\/graphql/i.test(u)) return true;
      }
    } catch (_) {}

    return false;
  }

  function payloadInteresting(data) {
    try {
      const s = JSON.stringify(data);
      if (s.length < 80) return false;
      return /publicIdentifier|fsd_profile|fs_miniProfile|"firstName"|vanityName|headline|geoLocation|Profile|Experience|Education|companyName/i.test(
        s
      );
    } catch (_) {
      return false;
    }
  }

  function maybeCapture(url, text) {
    if (!text || text.length < 40) return;
    if (text.length > MAX_TEXT) text = text.slice(0, MAX_TEXT);
    setTimeout(() => {
      try {
        const data = JSON.parse(text);
        if (!payloadInteresting(data)) return;
        post('voyager', url, data);
      } catch (_) {}
    }, 0);
  }

  function extractBodyFromArgs(input, init) {
    // fetch(url, { body })
    if (init && init.body != null) return bodyToString(init.body);
    // fetch(Request)
    try {
      if (input && typeof input === 'object' && typeof input.clone === 'function') {
        // Request.body est un stream — souvent déjà consommé ; LinkedIn passe souvent init.body
        return '';
      }
    } catch (_) {}
    return '';
  }

  const nativeFetch = window.fetch.bind(window);

  window.fetch = function pnFetch(input, init) {
    const url = resolveUrl(input);
    const bodyStr = extractBodyFromArgs(input, init);
    const watch = looksLikeProfileRequest(url, bodyStr);
    const p = nativeFetch(input, init);
    if (!watch) return p;
    return p.then((res) => {
      try {
        if (res && typeof res.clone === 'function') {
          res
            .clone()
            .text()
            .then((t) => maybeCapture(url, t))
            .catch(() => {});
        }
      } catch (_) {}
      return res;
    });
  };

  const XHR = window.XMLHttpRequest;
  if (XHR && XHR.prototype && !XHR.prototype.__pnHooked) {
    const open = XHR.prototype.open;
    const send = XHR.prototype.send;
    XHR.prototype.open = function (method, url, ...rest) {
      try {
        this.__pnUrl = resolveUrl(url);
      } catch (_) {}
      return open.call(this, method, url, ...rest);
    };
    XHR.prototype.send = function (body) {
      try {
        this.__pnBody = bodyToString(body);
        this.addEventListener('load', function () {
          try {
            const rt = this.responseType;
            if (rt && rt !== '' && rt !== 'text' && rt !== 'json') return;
            if (!looksLikeProfileRequest(this.__pnUrl, this.__pnBody)) return;
            const text =
              typeof this.response === 'string'
                ? this.response
                : typeof this.responseText === 'string'
                  ? this.responseText
                  : '';
            maybeCapture(this.__pnUrl, text);
          } catch (_) {}
        });
      } catch (_) {}
      return send.call(this, body);
    };
    XHR.prototype.__pnHooked = true;
  }

  window.addEventListener('message', (ev) => {
    if (ev.source !== window) return;
    const d = ev.data;
    if (!d || d.source !== 'pn-linkedin-profile-req') return;
    if (d.kind === 'drain') {
      try {
        window.postMessage(
          {
            source: 'pn-linkedin-profile',
            kind: 'drain',
            url: location.href,
            data: { hook: true, items: buf.slice() },
            t: Date.now()
          },
          '*'
        );
      } catch (_) {}
    }
  });

  post('hook_ready', location.href, { ok: true, path: location.pathname, mode: 'body+url' });
})();
