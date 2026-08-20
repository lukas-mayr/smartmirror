import './styles.css';
import './components/app.js';
import { store } from './store.js';

store.connect();

// `import.meta.hot` ist nur im Vite-Entwicklungsserver gesetzt – im Build
// faellt der Zweig weg.
// Service Worker macht die App installierbar und laesst sie starten, auch wenn
// der Pi gerade neu startet – die Oberflaeche zeigt dann "keine Verbindung"
// statt einer Fehlerseite des Browsers.
if ('serviceWorker' in navigator && !import.meta.hot) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('./sw.js');
  });
}
