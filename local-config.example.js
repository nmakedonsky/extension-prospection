/**
 * Configuration locale optionnelle (clés API) — non lue comme .env par Chrome.
 *
 * 1. Copier ce fichier :  cp local-config.example.js local-config.js
 * 2. Renseigner les clés dans local-config.js
 * 3. Recharger l’extension dans chrome://extensions
 *
 * `local-config.js` est listé dans .gitignore pour ne pas être poussé sur git.
 * Les valeurs sont injectées une seule fois dans chrome.storage tant qu’aucune
 * clé principale n’y figure encore (nouvelle install ou stockage effacé).
 * Ensuite le popup reste la source de vérité ; pour réimporter depuis le fichier,
 * vide le stockage de l’extension (DevTools → Application) ou les champs du popup.
 */
self.__PN_LOCAL_DEV_CONFIG = {
  geminiApiKey: '',
  supabaseUrl: '',
  supabaseAnonKey: '',
  hubspotApiKey: '',
  hubspotRegion: 'eu',
  sendPilotApiKey: ''
};
