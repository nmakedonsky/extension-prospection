#!/usr/bin/env node
/**
 * Backfill légitimité → companies (sociétés présentes dans saved_jobs).
 *
 *   node scripts/legitimacy-bench/backfill-companies.mjs
 *   node scripts/legitimacy-bench/backfill-companies.mjs --limit=5
 *   node scripts/legitimacy-bench/backfill-companies.mjs --only=Hopper,Hays
 *   node scripts/legitimacy-bench/backfill-companies.mjs --dry-run
 *   node scripts/legitimacy-bench/backfill-companies.mjs --force
 *
 * Clés : local-config.js (geminiApiKey, supabaseUrl, supabaseAnonKey) ou env.
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DELAY_MS,
  MODEL,
  ROOT,
  callGemini,
  loadLocalConfig,
  normalizeVerdict,
  sleep
} from './legitimacy-lib.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_PATH = join(__dirname, 'last-backfill.json');
const PAGE = 500;

function argFlag(name) {
  return process.argv.includes(name);
}

function argValue(prefix) {
  const a = process.argv.find((x) => x.startsWith(prefix));
  return a ? a.slice(prefix.length) : '';
}

function supabaseHeaders(key) {
  return {
    apikey: key,
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json'
  };
}

async function sbFetch(baseUrl, key, path, opts = {}) {
  const res = await fetch(`${baseUrl}/rest/v1/${path}`, {
    ...opts,
    headers: { ...supabaseHeaders(key), ...(opts.headers || {}) }
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${text.slice(0, 280)}`);
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * Sociétés de saved_jobs ∩ companies, optionnellement sans legitimacy_at.
 */
async function loadTargets(baseUrl, key, { force, onlyNames, limit }) {
  const byName = new Map();

  // 1) Noms distincts depuis saved_jobs (paginé via companies join is harder in REST —
  //    on charge companies candidates puis on filtre via un set de noms job).
  const jobNames = new Set();
  let from = 0;
  for (;;) {
    const rows = await sbFetch(
      baseUrl,
      key,
      `saved_jobs?select=company_name&company_name=not.is.null&order=company_name&offset=${from}&limit=${PAGE}`,
      { headers: { Range: `${from}-${from + PAGE - 1}` } }
    );
    const list = Array.isArray(rows) ? rows : [];
    if (!list.length) break;
    for (const r of list) {
      const n = String(r?.company_name || '').trim();
      if (n) jobNames.add(n.toLowerCase());
    }
    if (list.length < PAGE) break;
    from += PAGE;
  }

  from = 0;
  for (;;) {
    const filter = force ? '' : '&legitimacy_at=is.null';
    const rows = await sbFetch(
      baseUrl,
      key,
      `companies?select=id,company_name,linkedin_company_url,legitimacy_at&order=company_name&offset=${from}&limit=${PAGE}${filter}`,
      { headers: { Range: `${from}-${from + PAGE - 1}` } }
    );
    const list = Array.isArray(rows) ? rows : [];
    if (!list.length) break;
    for (const r of list) {
      const n = String(r?.company_name || '').trim();
      if (!n || !jobNames.has(n.toLowerCase())) continue;
      if (onlyNames.length && !onlyNames.some((o) => o.toLowerCase() === n.toLowerCase())) continue;
      if (!byName.has(n.toLowerCase())) byName.set(n.toLowerCase(), r);
    }
    if (list.length < PAGE) break;
    from += PAGE;
  }

  let targets = [...byName.values()];
  if (limit > 0) targets = targets.slice(0, limit);
  return targets;
}

async function loadSampleJob(baseUrl, key, companyName) {
  const enc = encodeURIComponent(companyName);
  const rows = await sbFetch(
    baseUrl,
    key,
    `saved_jobs?company_name=eq.${enc}&select=job_title,location&order=last_seen_at.desc&limit=1`
  );
  const row = Array.isArray(rows) ? rows[0] : null;
  return {
    job_title: row?.job_title || null,
    job_location: row?.location || null
  };
}

async function updateCompanyLegitimacy(baseUrl, key, companyId, fields) {
  await sbFetch(baseUrl, key, `companies?id=eq.${encodeURIComponent(companyId)}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify(fields)
  });
}

async function main() {
  const dryRun = argFlag('--dry-run');
  const force = argFlag('--force');
  const limit = Number(argValue('--limit=') || '0') || 0;
  const onlyArg = argValue('--only=');
  const onlyNames = onlyArg
    ? onlyArg
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : [];

  const cfg = loadLocalConfig();
  if (!cfg.supabaseUrl || !cfg.supabaseAnonKey) {
    throw new Error('supabaseUrl / supabaseAnonKey manquants (local-config.js)');
  }
  if (!cfg.geminiApiKey && !dryRun) {
    throw new Error('geminiApiKey manquant');
  }

  process.stderr.write('Chargement des cibles (saved_jobs ∩ companies)…\n');
  const targets = await loadTargets(cfg.supabaseUrl, cfg.supabaseAnonKey, {
    force,
    onlyNames,
    limit
  });
  process.stderr.write(`${targets.length} société(s) à traiter${dryRun ? ' (dry-run)' : ''}\n`);

  if (!targets.length) {
    writeFileSync(
      OUT_PATH,
      JSON.stringify({ model: MODEL, ran_at: new Date().toISOString(), n: 0, rows: [] }, null, 2)
    );
    console.log('Rien à faire.');
    return;
  }

  const rows = [];
  let i = 0;
  for (const t of targets) {
    i += 1;
    const name = t.company_name;
    process.stderr.write(`[${i}/${targets.length}] ${name} … `);
    const started = Date.now();
    try {
      const sample = await loadSampleJob(cfg.supabaseUrl, cfg.supabaseAnonKey, name);
      const companyCase = {
        company_name: name,
        job_title: sample.job_title,
        job_location: sample.job_location,
        linkedin_company_url: t.linkedin_company_url || null
      };

      if (dryRun) {
        process.stderr.write(`dry (${sample.job_title || 'no title'})\n`);
        rows.push({
          company_name: name,
          company_id: t.id,
          dry_run: true,
          sample,
          linkedin_company_url: t.linkedin_company_url || null,
          ms: Date.now() - started
        });
        continue;
      }

      const { parsed, searchQueries, model } = await callGemini(cfg.geminiApiKey, companyCase);
      const verdict = normalizeVerdict(parsed.verdict);
      if (!verdict) throw new Error(`Verdict invalide: ${parsed.verdict}`);

      const now = new Date().toISOString();
      const india = !!parsed.india_bodyshop_pattern;
      const confidence =
        typeof parsed.confidence === 'number' && Number.isFinite(parsed.confidence)
          ? parsed.confidence
          : null;
      const payload = {
        verdict,
        hq_country: parsed.hq_country ?? null,
        has_eu_legal_entity: parsed.has_eu_legal_entity ?? null,
        official_website: parsed.official_website ?? null,
        legal_page_quality: parsed.legal_page_quality ?? null,
        india_bodyshop_pattern: india,
        reasons: Array.isArray(parsed.reasons) ? parsed.reasons.slice(0, 12) : [],
        confidence,
        model: model || MODEL,
        searchQueries: Array.isArray(searchQueries) ? searchQueries.slice(0, 20) : [],
        job_title: sample.job_title,
        job_location: sample.job_location,
        linkedin_company_url: t.linkedin_company_url || null
      };

      await updateCompanyLegitimacy(cfg.supabaseUrl, cfg.supabaseAnonKey, t.id, {
        legitimacy_verdict: verdict,
        legitimacy_india_bodyshop: india,
        legitimacy_confidence: confidence,
        legitimacy_payload: payload,
        legitimacy_at: now,
        updated_at: now
      });

      rows.push({
        company_name: name,
        company_id: t.id,
        verdict,
        india_bodyshop: india,
        confidence,
        hq_country: payload.hq_country,
        ms: Date.now() - started,
        error: null
      });
      process.stderr.write(`${verdict}${india ? ' IN' : ''} (${Date.now() - started}ms)\n`);
    } catch (e) {
      const err = String(e?.message || e).slice(0, 280);
      rows.push({
        company_name: name,
        company_id: t.id,
        verdict: null,
        error: err,
        ms: Date.now() - started
      });
      process.stderr.write(`ERR ${err.slice(0, 80)}\n`);
    }
    if (i < targets.length) await sleep(DELAY_MS);
    if (i % 25 === 0) {
      writeFileSync(
        OUT_PATH,
        JSON.stringify(
          {
            model: MODEL,
            ran_at: new Date().toISOString(),
            partial: true,
            n_attempted: i,
            n_total: targets.length,
            rows
          },
          null,
          2
        )
      );
    }
  }

  const ok = rows.filter((r) => r.verdict).length;
  const summary = {
    model: MODEL,
    ran_at: new Date().toISOString(),
    dry_run: dryRun,
    force,
    n_attempted: targets.length,
    n_ok: ok,
    n_err: rows.filter((r) => r.error).length,
    rows
  };
  writeFileSync(OUT_PATH, JSON.stringify(summary, null, 2));

  console.log('\n=== Backfill légitimité ===');
  console.log(`Modèle: ${MODEL}`);
  console.log(`OK: ${ok}/${targets.length}  |  erreurs: ${summary.n_err}`);
  console.log(`Détail: ${OUT_PATH}`);
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
