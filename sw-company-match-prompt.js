/**
 * Bloc d’identification unique pour tous les appels Gemini (financier + résumé).
 * Validation du contexte avant pipeline / appels LLM.
 */

const SW_MATCH_CONTEXT_VERSION = 1;

function swIsValidLinkedinCompanyUrl(u) {
  const s = String(u || '').trim();
  if (!s) return false;
  try {
    const p = new URL(s);
    const h = p.hostname.toLowerCase();
    if (!h.endsWith('linkedin.com')) return false;
    return /\/company\//i.test(p.pathname);
  } catch {
    return false;
  }
}

/**
 * @returns {{ ok: boolean, missing: string[] }}
 */
function swValidateMatchContext(ctx) {
  const missing = [];
  if (!ctx || typeof ctx !== 'object') {
    return { ok: false, missing: ['context'] };
  }
  if (!swIsValidLinkedinCompanyUrl(ctx.companyLinkedinUrl)) {
    missing.push('companyLinkedinUrl');
  }
  const logo = String(ctx.logoUrl || '').trim();
  if (!logo || !/^https?:\/\//i.test(logo)) {
    missing.push('logoUrl');
  }
  const jt = String(ctx.jobTitle || '').trim();
  if (jt.length < 2) {
    missing.push('jobTitle');
  }
  return { ok: missing.length === 0, missing };
}

function swBuildCompanyMatchContextBlock(companyName, ctx) {
  const c = ctx || {};
  const hasImg = !!(c.logoInlineData && c.logoInlineData.dataBase64 && c.logoInlineData.mimeType);
  return `=== Contexte d'identification entreprise (matching — v${SW_MATCH_CONTEXT_VERSION}) ===
Nom affiché (carte LinkedIn) : ${String(companyName || '').trim()}
Titre de l'offre : ${c.jobTitle || '(non fourni)'}
Lieu (indication) : ${c.jobLocation || '(non fourni)'}
URL de l'offre (si connue) : ${c.jobUrl || '(non fournie)'}
URL page entreprise LinkedIn : ${c.companyLinkedinUrl || '(manquant)'}
URL source du logo : ${c.logoUrl || '(manquant)'}
Texte alt du logo : ${c.logoAlt || '(non fourni)'}
Image logo jointe : ${hasImg ? 'oui (voir 1re partie multimodale avant ce texte).' : 'non — s’appuyer sur les URLs et le nom.'}
${c.logoInlineSkipped ? "Note : l'image n'a pas pu être téléchargée (CORS/taille) ; utiliser le texte et les URLs." : ''}
=== Fin contexte identification ===`;
}

/**
 * @param {string} textAfterBlock — instructions spécifiques (financier ou résumé), sans dupliquer le bloc ci-dessus
 * @returns {Array<{ text?: string, inlineData?: { mimeType: string, data: string } }>}
 */
function swBuildGeminiPartsWithMatchContext(companyName, companyContext, textAfterBlock) {
  const ctx = companyContext || {};
  const block = swBuildCompanyMatchContextBlock(companyName, ctx);
  const fullText = `${block}\n\n${textAfterBlock}`;
  const parts = [];
  const inline = ctx.logoInlineData;
  if (inline && inline.dataBase64 && inline.mimeType) {
    parts.push({
      inlineData: {
        mimeType: inline.mimeType,
        data: inline.dataBase64
      }
    });
  }
  parts.push({ text: fullText });
  return parts;
}
