import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const script = join(repoRoot, 'deploy/mirror-bootlook.sh');

/*
 * Dieses Skript schreibt an der Datei, mit der der Pi bootet. Geht dabei etwas
 * schief, startet ein Geraet nicht mehr, an das per Annahme gerade niemand
 * herankommt - das ist der ganze Grund, warum es existiert. Die Tests hier
 * pruefen deshalb vor allem, was es *nicht* tut.
 *
 * Alles Aeussere kommt aus dem PATH: systemctl, apt-get und Plymouth sind
 * Attrappen im Testverzeichnis. Kein Test fasst das System an, auf dem er
 * laeuft.
 */

const CMDLINE_PI = 'console=serial0,115200 console=tty1 root=PARTUUID=abc123-02 rootfstype=ext4 fsck.repair=yes rootwait';
const CONFIG_PI = '[cm4]\notg_mode=1\n\n[all]\ndtoverlay=vc4-kms-v3d\n';

async function umgebung({ cmdline = CMDLINE_PI, config = CONFIG_PI, rotation = 0, plymouth = true } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'mirror-bootlook-'));
  const boot = join(dir, 'boot');
  const data = join(dir, 'data');
  const bin = join(dir, 'bin');
  const theme = join(dir, 'theme');
  for (const pfad of [boot, data, bin, theme]) await mkdir(pfad, { recursive: true });

  await writeFile(join(boot, 'cmdline.txt'), `${cmdline}\n`);
  await writeFile(join(boot, 'config.txt'), config);
  await writeFile(join(data, 'config.json'), JSON.stringify({ display: { rotation } }));

  const protokoll = join(dir, 'aufrufe.log');
  const attrappe = (name, body) =>
    writeFile(join(bin, name), `#!/usr/bin/env bash\nprintf '${name} %s\\n' "$*" >> ${protokoll}\n${body}\n`).then(
      () => chmod(join(bin, name), 0o755),
    );

  /*
   * systemctl merkt sich, was eingeschaltet ist.
   *
   * Eine Attrappe, die auf "is-enabled" immer 0 sagt, sieht harmlos aus und
   * verfaelscht genau das, worauf es hier ankommt: das Skript haelt getty@tty1
   * dann bei jedem Lauf fuer eingeschaltet, schaltet es wieder ab und meldet
   * jedes Mal eine Aenderung. Der Hinweis auf einen ausstehenden Neustart
   * verschwaende damit nie.
   */
  const zustand = join(dir, 'systemd.state');
  await writeFile(zustand, 'getty@tty1.service\n');
  await attrappe(
    'systemctl',
    [
      `state=${zustand}`,
      'unit="${@: -1}"',
      'case "$1" in',
      '  is-enabled) grep -qxF "$unit" "$state" ;;',
      '  enable) grep -qxF "$unit" "$state" || printf "%s\\n" "$unit" >> "$state" ;;',
      '  disable) grep -vxF "$unit" "$state" > "$state.neu" || true; mv "$state.neu" "$state" ;;',
      '  *) exit 0 ;;',
      'esac',
    ].join('\n'),
  );
  // apt-get darf in einem Test niemals wirklich etwas installieren.
  await attrappe('apt-get', 'exit 1');
  if (plymouth) await attrappe('plymouth-set-default-theme', 'printf "smartmirror"\nexit 0');

  return {
    dir,
    boot,
    data,
    theme,
    cmdlineDatei: join(boot, 'cmdline.txt'),
    configDatei: join(boot, 'config.txt'),
    statusDatei: join(data, 'bootlook-status.json'),
    async cmdline() {
      return (await readFile(join(boot, 'cmdline.txt'), 'utf8')).trim();
    },
    async status() {
      return JSON.parse(await readFile(join(data, 'bootlook-status.json'), 'utf8'));
    },
    async aufrufe() {
      return existsSync(protokoll) ? (await readFile(protokoll, 'utf8')).trim().split('\n') : [];
    },
    async ausfuehren(bootId = 'sitzung-1') {
      const { stdout } = await run('bash', [script], {
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          MIRROR_BOOT_DIR: boot,
          MIRROR_DATA_DIR: data,
          MIRROR_THEME_DIR: theme,
          MIRROR_THEME_SOURCE: join(repoRoot, 'deploy/plymouth'),
          MIRROR_DROPIN_DIR: join(dir, 'systemd'),
          MIRROR_SERVICE_USER: String(process.getuid?.() ?? 'root'),
          MIRROR_BOOT_ID: bootId,
        },
      });
      return stdout;
    },
  };
}

test('legt die Konsole auf tty3 und ergaenzt die fehlenden Parameter', async () => {
  const u = await umgebung();
  await u.ausfuehren();

  const zeile = await u.cmdline();
  assert.match(zeile, /(^| )console=tty3( |$)/, 'Konsole muss auf tty3 liegen');
  assert.doesNotMatch(zeile, /console=tty1/);
  for (const param of ['logo.nologo', 'vt.global_cursor_default=0', 'consoleblank=0', 'quiet', 'splash']) {
    assert.ok(zeile.split(' ').includes(param), `${param} fehlt`);
  }
  // Was schon dastand, bleibt stehen – hier haengt der Start des Geraets dran.
  assert.match(zeile, /root=PARTUUID=abc123-02/);
  assert.match(zeile, /console=serial0,115200/);
  assert.match(zeile, /rootwait/);
});

test('legt einmalig eine Sicherung der urspruenglichen Kernel-Zeile an', async () => {
  const u = await umgebung();
  await u.ausfuehren();
  assert.equal((await readFile(`${u.cmdlineDatei}.smartmirror-orig`, 'utf8')).trim(), CMDLINE_PI);
});

test('ein zweiter Lauf aendert nichts mehr', async () => {
  const u = await umgebung();
  await u.ausfuehren('sitzung-1');
  const nachErstemLauf = await u.cmdline();
  const configNachErstemLauf = await readFile(u.configDatei, 'utf8');

  await u.ausfuehren('sitzung-1');
  assert.equal(await u.cmdline(), nachErstemLauf);
  assert.equal(await readFile(u.configDatei, 'utf8'), configNachErstemLauf);
});

test('schaltet das Regenbogenquadrat ab, und zwar in einem [all]-Abschnitt', async () => {
  const u = await umgebung();
  await u.ausfuehren();
  const config = await readFile(u.configDatei, 'utf8');
  assert.match(config, /\[all\]\ndisable_splash=1/);
  // Sonst gaelte die Zeile nur fuer das Modell, dessen Filter zufaellig zuletzt
  // in der Datei stand.
  assert.equal(config.match(/disable_splash=1/g).length, 1);
});

test('laesst eine von Hand auf ein anderes Terminal gelegte Konsole in Ruhe', async () => {
  const u = await umgebung({ cmdline: 'console=serial0,115200 console=tty2 root=PARTUUID=abc rootwait' });
  await u.ausfuehren();
  assert.match(await u.cmdline(), /console=tty2/);
  assert.doesNotMatch(await u.cmdline(), /console=tty3/);
});

test('schreibt nichts, wenn die Zeile danach nicht mehr nach einer Kernel-Zeile aussieht', async () => {
  // Ohne root= koennte der Kernel sein Dateisystem nicht finden. Eine solche
  // Zeile war schon vorher unbrauchbar – aber sie zu ergaenzen und dann zu
  // speichern hiesse, ein kaputtes Geraet als repariert zu hinterlassen.
  const u = await umgebung({ cmdline: 'console=tty1 rootwait' });
  const ausgabe = await u.ausfuehren();
  assert.equal(await u.cmdline(), 'console=tty1 rootwait');
  assert.equal(existsSync(`${u.cmdlineDatei}.smartmirror-orig`), false);
  assert.match(ausgabe, /nichts geaendert/);
});

test('verlegt die Anmeldeaufforderung von tty1 auf tty3', async () => {
  const u = await umgebung();
  await u.ausfuehren();
  const aufrufe = await u.aufrufe();
  assert.ok(aufrufe.some((zeile) => zeile.includes('disable --now getty@tty1.service')));
  assert.ok(aufrufe.some((zeile) => zeile.includes('enable --now getty@tty3.service')));
});

test('waehlt das Bild passend zur Drehung des Spiegels', async () => {
  for (const rotation of [0, 90, 180, 270]) {
    const u = await umgebung({ rotation });
    await u.ausfuehren();
    const gewaehlt = await readFile(join(u.theme, 'splash.png'));
    const erwartet = await readFile(join(repoRoot, `deploy/plymouth/splash-${rotation}.png`));
    assert.deepEqual(gewaehlt, erwartet, `Drehung ${rotation}° bekommt das falsche Bild`);
  }
});

test('meldet den ausstehenden Neustart – und nimmt ihn nach einem Start zurueck', async () => {
  const u = await umgebung();

  await u.ausfuehren('sitzung-1');
  const nachAenderung = await u.status();
  assert.equal(nachAenderung.pendingReboot, true);
  assert.ok(nachAenderung.changed.includes('cmdline.txt'));

  // Noch derselbe Start: die Aenderung wirkt weiterhin erst beim naechsten.
  await u.ausfuehren('sitzung-1');
  assert.equal((await u.status()).pendingReboot, true);

  // Neuer Start: jetzt ist alles wirksam, der Hinweis in der App verschwindet.
  await u.ausfuehren('sitzung-2');
  const nachNeustart = await u.status();
  assert.equal(nachNeustart.pendingReboot, false);
  assert.deepEqual(nachNeustart.changed, []);
});

test(
  'lehnt ab, wenn sich das Boot-Verzeichnis nicht beschreiben laesst',
  // Als root ist alles beschreibbar – die Eigenschaft laesst sich dann nicht
  // pruefen. In der CI laeuft der Test, dort ist der Benutzer ein gewoehnlicher.
  { skip: process.getuid?.() === 0 ? 'als root ist jedes Verzeichnis beschreibbar' : false },
  async () => {
    const u = await umgebung();
    await chmod(u.boot, 0o555);
    try {
      // Frueher stand hier eine Pruefung auf die Benutzerkennung. Die sperrte
      // auch Laeufe aus, die gar nichts am System anfassen – und damit diese
      // Tests. Geprueft wird jetzt, worauf es ankommt.
      await assert.rejects(() => u.ausfuehren(), /Command failed/);
      assert.equal((await readFile(u.cmdlineDatei, 'utf8')).trim(), CMDLINE_PI);
    } finally {
      await chmod(u.boot, 0o755);
    }
  },
);

test('laeuft ohne Plymouth durch und sagt es', async () => {
  const u = await umgebung({ plymouth: false });
  await u.ausfuehren();

  const status = await u.status();
  assert.equal(status.plymouth, 'missing');
  // Der Rest muss trotzdem passiert sein: ohne Wortzeichen bleibt der Start
  // schwarz, und schwarz ist hinter einem Spiegel immer noch richtig.
  assert.match(await u.cmdline(), /console=tty3/);
});

test('installiert Plymouth hoechstens dreimal erfolglos nach', async () => {
  const u = await umgebung({ plymouth: false });
  for (const sitzung of ['s1', 's2', 's3', 's4', 's5']) await u.ausfuehren(sitzung);
  const versuche = (await u.aufrufe()).filter((zeile) => zeile.startsWith('apt-get install'));
  // Ein Pi ohne Netz soll nicht bei jedem Start aufs Neue apt bemuehen.
  assert.ok(versuche.length <= 3, `zu viele Versuche: ${versuche.length}`);
});
