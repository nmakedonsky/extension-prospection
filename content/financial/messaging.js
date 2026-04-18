/** Envoi runtime vers le service worker (gestion contexte invalidé). */

function sendRuntimeMessageSafe(payload, callback) {
  try {
    if (!chrome?.runtime?.id || typeof chrome.runtime.sendMessage !== 'function') {
      callback?.(null, new Error('Extension context invalidated'));
      return;
    }
    chrome.runtime.sendMessage(payload, (response) => {
      const err = chrome.runtime?.lastError ? new Error(chrome.runtime.lastError.message) : null;
      callback?.(response, err);
    });
  } catch (e) {
    callback?.(null, e);
  }
}
