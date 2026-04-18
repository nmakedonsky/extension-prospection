(() => {
  function detectMode(input) {
    const hasTicker = !!input?.ticker;
    const profileValid = !!input?.profileValid;
    const hasWebEvidence = (input?.articlesCount || 0) > 0;
    const numericFields = input?.numericFieldsCount || 0;
    const fundingLike = !!input?.fundingLikeSignals;

    if (hasTicker && profileValid) return 'A';
    if (!hasTicker && hasWebEvidence) return 'B';
    if (numericFields <= 1 && (fundingLike || hasWebEvidence)) return 'C';
    if (!hasTicker) return 'B';
    return 'A';
  }

  self.modeDetector = { detectMode };
})();
