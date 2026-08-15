#!/usr/bin/env node
/**
 * Banc d'essai légitimité employeur (Gemini + Google Search).
 *
 *   node scripts/legitimacy-bench/run.mjs
 *   node scripts/legitimacy-bench/run.mjs --only hopper,hays,yoit
 *
 * Clé : GEMINI_API_KEY ou geminiApiKey dans local-config.js (non commité).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DELAY_MS,
  MODEL,
  callGemini,
  loadGeminiKey,
  pad,
  sleep
} from './legitimacy-lib.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function main() {
  const onlyArg = process.argv.find((a) => a.startsWith('--only=')) || '';
  const only = onlyArg
    ? onlyArg
        .slice('--only='.length)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : [];
  const fixture = JSON.parse(readFileSync(join(__dirname, 'cases.json'), 'utf8'));
  const cases = only.length ? fixture.cases.filter((c) => only.includes(c.id)) : fixture.cases;
  if (!cases.length) throw new Error('Aucun cas à jouer');

  const apiKey = loadGeminiKey();
  const rows = [];
  let i = 0;
  for (const c of cases) {
    i += 1;
    process.stderr.write(`[${i}/${cases.length}] ${c.company_name} … `);
    const started = Date.now();
    try {
      const { parsed, searchQueries } = await callGemini(apiKey, c);
      const verdictOk = parsed.verdict === c.expected_verdict;
      const indiaOk =
        typeof c.expected_india_bodyshop === 'boolean'
          ? !!parsed.india_bodyshop_pattern === c.expected_india_bodyshop
          : null;
      const falseRed = c.expected_verdict === 'real' && parsed.verdict === 'shell';
      rows.push({
        id: c.id,
        company_name: c.company_name,
        expected_verdict: c.expected_verdict,
        got_verdict: parsed.verdict,
        verdict_ok: verdictOk,
        expected_india_bodyshop: c.expected_india_bodyshop,
        got_india_bodyshop: !!parsed.india_bodyshop_pattern,
        india_ok: indiaOk,
        false_red: falseRed,
        hq_country: parsed.hq_country ?? null,
        has_eu_legal_entity: parsed.has_eu_legal_entity ?? null,
        legal_page_quality: parsed.legal_page_quality ?? null,
        official_website: parsed.official_website ?? null,
        confidence: parsed.confidence ?? null,
        reasons: parsed.reasons || [],
        searchQueries,
        ms: Date.now() - started,
        error: null
      });
      process.stderr.write(`${parsed.verdict}${verdictOk ? ' OK' : ' DIFF'} (${Date.now() - started}ms)\n`);
    } catch (e) {
      rows.push({
        id: c.id,
        company_name: c.company_name,
        expected_verdict: c.expected_verdict,
        got_verdict: null,
        verdict_ok: false,
        expected_india_bodyshop: c.expected_india_bodyshop,
        got_india_bodyshop: null,
        india_ok: false,
        false_red: false,
        error: String(e?.message || e).slice(0, 240),
        ms: Date.now() - started
      });
      process.stderr.write(`ERR ${String(e?.message || e).slice(0, 80)}\n`);
    }
    if (i < cases.length) await sleep(DELAY_MS);
  }

  const scored = rows.filter((r) => !r.error);
  const n = scored.length;
  const verdictHits = scored.filter((r) => r.verdict_ok).length;
  const indiaHits = scored.filter((r) => r.india_ok === true).length;
  const indiaN = scored.filter((r) => typeof r.expected_india_bodyshop === 'boolean').length;
  const falseReds = scored.filter((r) => r.false_red).length;

  const summary = {
    model: MODEL,
    ran_at: new Date().toISOString(),
    n_attempted: cases.length,
    n_ok: n,
    verdict_accuracy: n ? Math.round((1000 * verdictHits) / n) / 10 : null,
    india_accuracy: indiaN ? Math.round((1000 * indiaHits) / indiaN) / 10 : null,
    false_red_count: falseReds,
    rows
  };

  const outPath = join(__dirname, 'last-run.json');
  writeFileSync(outPath, JSON.stringify(summary, null, 2));

  console.log('\n=== Banc d’essai légitimité ===');
  console.log(`Modèle: ${MODEL}`);
  console.log(
    `Verdict: ${verdictHits}/${n} (${summary.verdict_accuracy}%)  |  Inde bodyshop: ${indiaHits}/${indiaN} (${summary.india_accuracy}%)  |  Faux rouges (real→shell): ${falseReds}`
  );
  console.log('');
  console.log(
    `${pad('id', 14)}${pad('company', 28)}${pad('expected', 12)}${pad('got', 12)}${pad('IN exp', 8)}${pad('IN got', 8)}${pad('ok', 6)}`
  );
  for (const r of rows) {
    const mark = r.error ? 'ERR' : r.verdict_ok ? 'OK' : 'DIFF';
    console.log(
      `${pad(r.id, 14)}${pad(r.company_name, 28)}${pad(r.expected_verdict, 12)}${pad(r.got_verdict || r.error, 12)}${pad(r.expected_india_bodyshop, 8)}${pad(r.got_india_bodyshop, 8)}${pad(mark, 6)}`
    );
  }
  const diffs = rows.filter((r) => !r.error && !r.verdict_ok);
  if (diffs.length) {
    console.log('\nÉcarts:');
    for (const r of diffs) {
      console.log(`- ${r.company_name}: attendu ${r.expected_verdict}, obtenu ${r.got_verdict} (${(r.reasons || []).slice(0, 2).join('; ')})`);
    }
  }
  console.log(`\nDétail: ${outPath}`);
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
