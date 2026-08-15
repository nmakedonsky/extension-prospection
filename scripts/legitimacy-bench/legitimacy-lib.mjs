/**
 * Shared Gemini + Google Search legitimacy probe (bench + backfill).
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(__dirname, '../..');

export const MODEL = process.env.LEGITIMACY_MODEL || 'gemini-2.5-flash';
export const BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
export const DELAY_MS = Number(process.env.LEGITIMACY_DELAY_MS || 1200);

export const VERDICTS = new Set(['real', 'recruiter', 'shell', 'uncertain']);

export const SYSTEM_PROMPT = `You are investigating whether a LinkedIn job employer is a real company a freelancer should spend time applying to.

Search the public web: official website, LinkedIn company page, legal/privacy/"mentions légales"/imprint, company registries (SIREN/SIRET, Companies House, Handelsregister, MCA India), news.

Return ONLY valid JSON (no markdown) with this shape:
{
  "verdict": "real" | "recruiter" | "shell" | "uncertain",
  "hq_country": "ISO 3166-1 alpha-2 or null",
  "has_eu_legal_entity": true | false | null,
  "official_website": "string|null",
  "legal_page_quality": "named_officers" | "generic_template" | "missing" | "unknown",
  "india_bodyshop_pattern": true | false,
  "reasons": ["short factual bullets"],
  "confidence": 0-100
}

Definitions:
- real: operating employer that hires for ITS OWN product/service (including large Indian IT majors like Infosys, TCS, HCL — those are real, not shells).
- recruiter: staffing agency, ESN/SSII, executive search, freelance marketplace, job board/aggregator, HR-tech matching platform, AI-training gig mill. If they post roles that are actually at client companies, or they only place/match talent, verdict is recruiter EVEN IF they are a legally registered company with a named director.
- shell: tiny/no real footprint, cloned brochure site, no named officers, no registry hit, or obvious CV-harvest front with no identifiable legal entity.
- uncertain: not enough public evidence.

Job boards, "talent platforms", "we match you with companies", and aggregators (e.g. Jobgether, Free-Work, Kicklox) are recruiter, not real.

india_bodyshop_pattern = true ONLY if ALL are plausible:
1) HQ or operating entity appears India-based (or only Indian directors/phones),
2) they post EU/UK/US remote roles,
3) no credible EU/UK legal entity or office,
4) website looks generic (template legal pages, no named people, thin content).
Large listed Indian IT (Infosys, TCS, Wipro, HCLTech, Cognizant, Tech Mahindra) => india_bodyshop_pattern MUST be false.

Do not invent registry numbers or URLs you did not see. Prefer uncertain over a wrong shell.`;

export function loadGeminiKey() {
  const env = String(process.env.GEMINI_API_KEY || '').trim();
  if (env) return env;
  const raw = readFileSync(join(ROOT, 'local-config.js'), 'utf8');
  const m = raw.match(/geminiApiKey:\s*'([^']+)'/);
  if (!m?.[1]) throw new Error('Pas de clé Gemini (GEMINI_API_KEY ou local-config.js)');
  return m[1];
}

export function loadLocalConfig() {
  const raw = readFileSync(join(ROOT, 'local-config.js'), 'utf8');
  const pick = (key) => {
    const m = raw.match(new RegExp(`${key}:\\s*'([^']*)'`));
    return m?.[1] ? String(m[1]).trim() : '';
  };
  return {
    geminiApiKey: pick('geminiApiKey') || String(process.env.GEMINI_API_KEY || '').trim(),
    supabaseUrl: (pick('supabaseUrl') || String(process.env.SUPABASE_URL || '').trim()).replace(/\/$/, ''),
    supabaseAnonKey:
      pick('supabaseAnonKey') ||
      pick('supabaseKey') ||
      String(process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY || '').trim()
  };
}

export function parseJsonFromModel(text) {
  const cleaned = String(text || '')
    .replace(/```json/gi, '')
    .replace(/```/g, '')
    .trim();
  const first = cleaned.indexOf('{');
  const last = cleaned.lastIndexOf('}');
  if (first < 0 || last <= first) throw new Error('JSON introuvable dans la réponse');
  return JSON.parse(cleaned.slice(first, last + 1));
}

export function extractCandidateText(data) {
  const cand = data?.candidates?.[0] || {};
  const parts = cand?.content?.parts || [];
  const text = parts
    .map((p) => (typeof p.text === 'string' ? p.text : ''))
    .join('\n')
    .trim();
  return {
    text,
    finishReason: cand.finishReason || data?.promptFeedback?.blockReason || null
  };
}

export function userPrompt(c) {
  const loc = c.job_location ? `\nJob location: ${c.job_location}` : '';
  const title = c.job_title ? `\nJob title: ${c.job_title}` : '';
  const li = c.linkedin_company_url ? `\nLinkedIn company URL: ${c.linkedin_company_url}` : '';
  return `Employer name as shown on LinkedIn: "${c.company_name}"${title}${loc}${li}

Investigate this employer and return the JSON.`;
}

export function buildRequest(companyCase, { retryJson } = {}) {
  const userText = retryJson
    ? `${userPrompt(companyCase)}\n\nIMPORTANT: Your previous reply had no JSON. Reply with the JSON object only, no prose.`
    : userPrompt(companyCase);
  return {
    systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
    contents: [{ role: 'user', parts: [{ text: userText }] }],
    tools: [{ google_search: {} }],
    generationConfig: {
      temperature: 0.1,
      maxOutputTokens: 4096,
      thinkingConfig: { thinkingBudget: 0 }
    }
  };
}

export async function callGemini(apiKey, companyCase) {
  const url = `${BASE}/${MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`;
  let lastErr = null;
  for (const retryJson of [false, true]) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildRequest(companyCase, { retryJson }))
    });
    const raw = await res.text();
    if (!res.ok) {
      lastErr = new Error(`HTTP ${res.status}: ${raw.slice(0, 280)}`);
      continue;
    }
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      lastErr = new Error('Réponse HTTP non JSON');
      continue;
    }
    const { text, finishReason } = extractCandidateText(data);
    try {
      const parsed = parseJsonFromModel(text);
      const queries = data?.candidates?.[0]?.groundingMetadata?.webSearchQueries || [];
      return { parsed, searchQueries: queries, model: MODEL, finishReason };
    } catch (e) {
      lastErr = new Error(`${e.message} (finish=${finishReason || '?'})`);
    }
  }
  throw lastErr || new Error('Gemini a échoué');
}

export function normalizeVerdict(v) {
  const s = String(v || '')
    .trim()
    .toLowerCase();
  return VERDICTS.has(s) ? s : null;
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export function pad(s, n) {
  const t = String(s ?? '');
  return t.length >= n ? t.slice(0, n) : t + ' '.repeat(n - t.length);
}
