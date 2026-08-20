import { CoreConnection } from './connection.js';
import { MirrorApp } from './app.js';

const params = new URLSearchParams(window.location.search);
const coreUrl = params.get('core') ?? 'http://127.0.0.1:8080';
const appVersion = params.get('version') ?? '0.0.0';

const stage = document.querySelector('#stage') as HTMLElement;

const connection = new CoreConnection({
  coreUrl,
  appVersion,
  onMessage: (message) => app.handle(message),
  onStateChange: (state) => app.setConnectionState(state),
});

const app = new MirrorApp(stage, connection, coreUrl);
connection.connect();
