(() => {
  function nowIso() {
    return new Date().toISOString();
  }

  async function runAdaptiveFinancialPipeline(companyName, deps, context = null) {
    const { llmExtractor, modeDetector, merger, scoring } = self;

    let llm = null;
    let llmError = null;
    try {
      llm = await llmExtractor.extractFromCompanyContext(companyName, context, deps);
    } catch (e) {
      llmError = e?.message || 'llm_extraction_failed';
      llm = null;
    }

    const financials = merger.mergeFinancials(null, llm?.financials);
    const signals = merger.inferSignals(financials, llm?.signals);
    const numericFieldsCount = Object.values(financials).filter((v) => v != null).length;

    const mode = modeDetector.detectMode({
      ticker: null,
      profileValid: false,
      articlesCount: 0,
      numericFieldsCount,
      fundingLikeSignals: !!signals?.funding_detected
    });

    const identified = llm?.raw?.identified_company_name || null;

    const basePayload = {
      mode,
      financials,
      signals,
      profile: null,
      llm_raw: llm?.raw || null,
      score: 0,
      confidence: 0,
      sources: [{ type: 'llm', company: companyName, identified: identified || undefined }],
      partial: false,
      score_breakdown: null
    };

    const breakdown = scoring.computeScoreBreakdown(basePayload);
    basePayload.score = breakdown.score;
    basePayload.score_breakdown = breakdown;
    basePayload.confidence = scoring.computeConfidence(basePayload);
    basePayload.partial = scoring.isPartialDataset(financials);
    basePayload.generated_at = nowIso();

    return {
      unified: basePayload,
      raw: {
        companyContext: context || null,
        llm: llm?.raw || null,
        debug: {
          llmAttempted: !!deps?.geminiApiKey,
          llmError,
          pipeline: 'gemini_context_only'
        }
      }
    };
  }

  self.financialPipeline = { runAdaptiveFinancialPipeline };
})();
