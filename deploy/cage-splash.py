#!/usr/bin/env python3
"""
Der Startbildschirm zwischen Plymouth und der Anzeige.

Zwischen dem Start von `cage` und dem ersten Bild von Electron gehoert der
Bildschirm dem Compositor, und der hat nichts zu zeichnen: gemessen auf einem
Pi mit SD-Karte sind das rund acht Sekunden Schwarz. Plymouth kommt da nicht
mehr hin - es musste die Grafikausgabe abgeben, damit `cage` sie bekommt -, und
die Anzeige ist genau das, worauf gewartet wird. Es bleibt einer uebrig, der
dort zeichnen kann: ein zweiter Wayland-Client unter `cage`. Das ist dieses
Programm.

Es zeigt dasselbe Bild wie Plymouth davor und die Anzeige danach: Wortzeichen
und drei atmende Punkte auf Schwarz. Dieselben Bilddateien
(deploy/plymouth/<ebene>-<grad>.png) und dieselbe Kurve wie in
smartmirror.script - damit man den Wechsel nicht sieht, sondern nur ein Bild,
das durchgehend steht.

Warum Python und kein fertiges Programm: ein Bildbetrachter wie `imv` zeigt ein
Standbild. Zwischen zwei atmenden Logos waere genau dort die Naht, die der
ganze Startbildschirm vermeiden soll. Und Python liegt auf Raspberry Pi OS
ohnehin, waehrend jedes zusaetzliche Paket ein Geraet an der Wand betrifft, an
das niemand kurzfristig herankommt.

Warum das Wayland-Protokoll von Hand: die Bindings dafuer sind nicht Teil der
Standardbibliothek. Gebraucht wird nur ein Bruchteil - eine Flaeche, ein
Speicherpuffer, ein Bild pro Takt -, und der steht hier ausgeschrieben.

Beendet wird es von der Anzeige, sobald deren erstes Bild steht (der
Hauptprozess kennt die Prozessnummer ueber MIRROR_SPLASH_PID). Faellt das aus,
beendet es sich selbst: nach MIRROR_SPLASH_MAX_S Sekunden, und ebenso, wenn der
Compositor endet. Ein Standbild, das ueber dem Spiegel haengen bleibt, waere
schlimmer als die Sekunden Schwarz, gegen die es hier geht.

Aufruf:  cage-splash.py <verzeichnis-mit-den-png> <drehung>
"""

import mmap
import os
import signal
import socket
import struct
import sys
import time
import zlib

# ---------------------------------------------------------------- Bilder lesen


def png_lesen(pfad):
    """Liest ein RGBA-PNG und gibt (breite, hoehe, pixel) zurueck.

    Von Hand und nicht mit einer Bibliothek: Pillow ist auf Raspberry Pi OS
    nicht vorinstalliert, und was hier gebraucht wird, ist ein Bruchteil des
    Formats - ein Bild, das dieses Projekt selbst erzeugt (scripts/
    generate-splash.mjs), also 8 Bit je Kanal, RGBA, ohne Interlace. zlib
    steht in der Standardbibliothek; der Rest sind die fuenf Filter, die
    jede PNG-Zeile einleiten.
    """
    with open(pfad, 'rb') as datei:
        rohdaten = datei.read()

    if rohdaten[:8] != b'\x89PNG\r\n\x1a\n':
        raise ValueError(f'{pfad}: kein PNG')

    breite = hoehe = None
    komprimiert = bytearray()
    stelle = 8
    while stelle < len(rohdaten):
        laenge, art = struct.unpack('>I4s', rohdaten[stelle:stelle + 8])
        inhalt = rohdaten[stelle + 8:stelle + 8 + laenge]
        stelle += 12 + laenge  # Laenge, Art, Inhalt, Pruefsumme
        if art == b'IHDR':
            breite, hoehe, tiefe, farbtyp, _, _, interlace = struct.unpack('>IIBBBBB', inhalt)
            if (tiefe, farbtyp, interlace) != (8, 6, 0):
                raise ValueError(f'{pfad}: erwartet 8-Bit-RGBA ohne Interlace')
        elif art == b'IDAT':
            komprimiert += inhalt
        elif art == b'IEND':
            break

    if breite is None:
        raise ValueError(f'{pfad}: kein IHDR')

    daten = zlib.decompress(bytes(komprimiert))
    zeilenlaenge = breite * 4
    pixel = bytearray(zeilenlaenge * hoehe)
    vorige = bytearray(zeilenlaenge)

    quelle = 0
    for y in range(hoehe):
        filter_art = daten[quelle]
        zeile = bytearray(daten[quelle + 1:quelle + 1 + zeilenlaenge])
        quelle += 1 + zeilenlaenge

        if filter_art == 0:
            pass
        elif filter_art == 1:  # Sub
            for i in range(4, zeilenlaenge):
                zeile[i] = (zeile[i] + zeile[i - 4]) & 0xFF
        elif filter_art == 2:  # Up
            for i in range(zeilenlaenge):
                zeile[i] = (zeile[i] + vorige[i]) & 0xFF
        elif filter_art == 3:  # Average
            for i in range(zeilenlaenge):
                links = zeile[i - 4] if i >= 4 else 0
                zeile[i] = (zeile[i] + ((links + vorige[i]) >> 1)) & 0xFF
        elif filter_art == 4:  # Paeth
            for i in range(zeilenlaenge):
                links = zeile[i - 4] if i >= 4 else 0
                oben = vorige[i]
                schraeg = vorige[i - 4] if i >= 4 else 0
                p = links + oben - schraeg
                pa, pb, pc = abs(p - links), abs(p - oben), abs(p - schraeg)
                if pa <= pb and pa <= pc:
                    vorhersage = links
                elif pb <= pc:
                    vorhersage = oben
                else:
                    vorhersage = schraeg
                zeile[i] = (zeile[i] + vorhersage) & 0xFF
        else:
            raise ValueError(f'{pfad}: unbekannter Zeilenfilter {filter_art}')

        pixel[y * zeilenlaenge:(y + 1) * zeilenlaenge] = zeile
        vorige = zeile

    return breite, hoehe, pixel


def kasten(breite, hoehe, pixel):
    """Der Ausschnitt, in dem eine Ebene ueberhaupt sichtbar ist.

    Die Ebenen sind alle so gross wie das ganze Wortzeichen und bis auf ihren
    Teil leer - so liegen sie ohne Koordinaten uebereinander. Fuer das
    Zeichnen ist das Verschwendung: ein Punkt ist acht Pixel breit, seine
    Ebene ein paar hundert. Also einmal nachsehen, wo etwas steht.
    """
    oben, unten, links, rechts = hoehe, -1, breite, -1
    for y in range(hoehe):
        zeile = pixel[y * breite * 4:(y + 1) * breite * 4]
        if not any(zeile[3::4]):
            continue
        oben = min(oben, y)
        unten = y
        for x in range(breite):
            if zeile[x * 4 + 3]:
                links = min(links, x)
                rechts = max(rechts, x)
    if unten < 0:
        return (0, 0, 0, 0)
    return (links, oben, rechts - links + 1, unten - oben + 1)


# ------------------------------------------------------------------- Zeichnen

# Dieselben Werte wie mirror-breathe im Stylesheet und wie smartmirror.script:
# 1400 ms hin und zurueck, die drei Punkte um je 180 ms versetzt, zwischen
# 30 % und voll.
DAUER_S = 1.4
VERSATZ_S = 0.18
STUFEN = 32  # So viele Deckkraft-Stufen werden vorberechnet.

# Hoechstens zwanzig Bilder je Sekunde.
#
# Der Compositor bietet sechzig an, und drei pulsierende Punkte brauchen keine
# sechzig: bei 1400 ms je Atemzug liegen zwischen zwei Bildern dann drei
# Prozent Helligkeit, das sieht niemand. Wohl aber sieht man, was daneben
# passiert - waehrend dieser Startbildschirm liegt, startet Chromium, und jedes
# Bild kostet den Compositor eine Runde. Gemessen auf dem Geraet: von den
# 36 Sekunden, die das Logo steht, gehen 27 fuer das Lesen der Anwendung von
# der Karte drauf. Genau dabei soll hier niemand im Weg stehen.
TAKT_S = 1 / 20


def deckkraft(zeit):
    anteil = (zeit % DAUER_S) / DAUER_S
    if anteil > 0.5:
        anteil = 1 - anteil
    anteil *= 2
    # Weich an den Enden, damit es nicht knickt - dasselbe tut ease-in-out.
    return 0.3 + 0.7 * anteil * anteil * (3 - 2 * anteil)


def auf_schwarz(pixel, breite, ausschnitt, faktor=1.0):
    """RGBA ueber Schwarz zu ARGB8888, wie wl_shm es erwartet.

    Der Hintergrund ist schwarz und deckend, deshalb bleibt von der ueblichen
    Rechnung nur die Multiplikation mit der Deckkraft uebrig. Ergebnis sind
    fertige Zeilen, die spaeter nur noch in den Puffer kopiert werden.
    """
    x0, y0, w, h = ausschnitt
    zeilen = []
    for y in range(y0, y0 + h):
        ziel = bytearray(w * 4)
        quelle = (y * breite + x0) * 4
        for i in range(w):
            r = pixel[quelle + i * 4]
            g = pixel[quelle + i * 4 + 1]
            b = pixel[quelle + i * 4 + 2]
            a = pixel[quelle + i * 4 + 3] * faktor
            # Kleines Endian zuerst: B, G, R, A.
            ziel[i * 4] = int(b * a / 255)
            ziel[i * 4 + 1] = int(g * a / 255)
            ziel[i * 4 + 2] = int(r * a / 255)
            ziel[i * 4 + 3] = 255
        zeilen.append(bytes(ziel))
    return zeilen


# ------------------------------------------------------------ Wayland, knapp

WL_DISPLAY = 1


class Verbindung:
    """Das Stueck Wayland, das dieser Startbildschirm braucht.

    Kein allgemeiner Client: nur die Anfragen, die hier vorkommen, und von den
    Ereignissen nur die, auf die geantwortet werden muss.
    """

    def __init__(self):
        pfad = os.path.join(
            os.environ.get('XDG_RUNTIME_DIR', '/run/user/0'),
            os.environ.get('WAYLAND_DISPLAY', 'wayland-0'),
        )
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.connect(pfad)
        self.puffer = b''
        self.naechste_id = 2
        self.behandler = {}

    def id(self):
        wert = self.naechste_id
        self.naechste_id += 1
        return wert

    def sende(self, objekt, opcode, nutzlast=b'', fd=None):
        kopf = struct.pack('<II', objekt, ((8 + len(nutzlast)) << 16) | opcode)
        if fd is None:
            self.sock.sendall(kopf + nutzlast)
        else:
            self.sock.sendmsg(
                [kopf + nutzlast],
                [(socket.SOL_SOCKET, socket.SCM_RIGHTS, struct.pack('i', fd))],
            )

    @staticmethod
    def text(wert):
        roh = wert.encode() + b'\0'
        return struct.pack('<I', len(roh)) + roh + b'\0' * ((-len(roh)) % 4)

    def lesen(self, frist=None):
        """Holt, was da ist, und ruft die Behandler. False heisst: Ende."""
        self.sock.settimeout(frist)
        try:
            teil = self.sock.recv(8192)
        except (socket.timeout, TimeoutError):
            return True
        if not teil:
            return False
        self.puffer += teil
        while len(self.puffer) >= 8:
            objekt, wort = struct.unpack('<II', self.puffer[:8])
            groesse, opcode = wort >> 16, wort & 0xFFFF
            if groesse < 8 or len(self.puffer) < groesse:
                break
            inhalt = self.puffer[8:groesse]
            self.puffer = self.puffer[groesse:]
            behandler = self.behandler.get(objekt)
            if behandler:
                behandler(opcode, inhalt)
        return True


class Startbild:
    def __init__(self, verzeichnis, drehung):
        self.wl = Verbindung()
        # Bis der Ausgang seinen Modus nennt: eine Groesse, mit der ein Bild
        # entstehen kann. Falsch geraten heisst hier nur, dass das erste Bild
        # verworfen und mit der richtigen Groesse neu gezeichnet wird.
        self.breite, self.hoehe = 1920, 1080
        self.puffer_masse = None
        self.laeuft = True
        self.puffer_frei = [True, True]
        self.puffer_ids = [0, 0]
        self.karte = None
        self.beginn = time.monotonic()
        self.gemeldet = False
        self.letztes_bild = 0.0

        self.lade_bilder(verzeichnis, drehung)
        self.melde_an()

    # ------------------------------------------------------------- Vorbereiten

    def lade_bilder(self, verzeichnis, drehung):
        breite = hoehe = None
        self.mark_zeilen = None
        self.punkte = []

        for name in ('mark', 'dot1', 'dot2', 'dot3'):
            pfad = os.path.join(verzeichnis, f'{name}-{drehung}.png')
            w, h, pixel = png_lesen(pfad)
            if breite is None:
                breite, hoehe = w, h
            elif (w, h) != (breite, hoehe):
                raise ValueError(f'{pfad}: {w}x{h} passt nicht zu {breite}x{hoehe}')

            ausschnitt = kasten(w, h, pixel)
            if name == 'mark':
                self.mark_ausschnitt = ausschnitt
                self.mark_zeilen = auf_schwarz(pixel, w, ausschnitt)
            else:
                # Fuer die Punkte alle Deckkraft-Stufen im Voraus: zur Laufzeit
                # bleibt dann das Kopieren von ein paar Dutzend Bytes je Bild.
                stufen = [
                    auf_schwarz(pixel, w, ausschnitt, (stufe + 1) / STUFEN)
                    for stufe in range(STUFEN)
                ]
                self.punkte.append((ausschnitt, stufen))

        self.block_breite, self.block_hoehe = breite, hoehe

    # -------------------------------------------------------------- Anmelden

    def melde_an(self):
        wl = self.wl
        self.registry = wl.id()
        wl.behandler[self.registry] = self.registry_ereignis
        wl.sende(WL_DISPLAY, 1, struct.pack('<I', self.registry))

        self.globals = {}
        self.compositor = self.shm = self.wm_base = None
        self.warte_auf_umlauf()

        for name in ('wl_compositor', 'wl_shm', 'xdg_wm_base'):
            if name not in self.globals:
                raise RuntimeError(f'{name} fehlt - kein Startbild')

        # Die Groesse des Bildschirms, bevor irgendetwas gezeichnet wird.
        #
        # Das erste `configure` von cage nennt 0x0: der Client soll die Groesse
        # selbst waehlen und bekommt die endgueltige erst, nachdem seine
        # Flaeche steht. Ohne eine erste Zahl gaebe es also nie ein Bild - und
        # die einzige Stelle, an der sie vorher steht, ist der Modus des
        # Ausgangs.
        if 'wl_output' in self.globals:
            ausgang = self.binde('wl_output', 2)
            wl.behandler[ausgang] = self.ausgang_ereignis
            self.warte_auf_umlauf()

        self.compositor = self.binde('wl_compositor', 4)
        self.shm = self.binde('wl_shm', 1)
        self.wm_base = self.binde('xdg_wm_base', 1)
        wl.behandler[self.wm_base] = self.wm_base_ereignis

        self.flaeche = wl.id()
        wl.sende(self.compositor, 0, struct.pack('<I', self.flaeche))

        self.xdg_flaeche = wl.id()
        wl.behandler[self.xdg_flaeche] = self.xdg_flaeche_ereignis
        wl.sende(self.wm_base, 2, struct.pack('<II', self.xdg_flaeche, self.flaeche))

        self.toplevel = wl.id()
        wl.behandler[self.toplevel] = self.toplevel_ereignis
        wl.sende(self.xdg_flaeche, 1, struct.pack('<I', self.toplevel))
        wl.sende(self.toplevel, 2, Verbindung.text('Smartmirror'))
        wl.sende(self.toplevel, 3, Verbindung.text('smartmirror-splash'))
        wl.sende(self.toplevel, 11, struct.pack('<I', 0))  # Vollbild
        wl.sende(self.flaeche, 6)  # commit: jetzt kommt die Groesse zurueck

    def warte_auf_umlauf(self):
        """Wartet, bis der Compositor alles Bisherige beantwortet hat."""
        sync = self.wl.id()
        fertig = []
        self.wl.behandler[sync] = lambda opcode, inhalt: fertig.append(True)
        self.wl.sende(WL_DISPLAY, 0, struct.pack('<I', sync))
        while not fertig:
            if not self.wl.lesen(5):
                raise RuntimeError('Compositor endete beim Anmelden')

    def ausgang_ereignis(self, opcode, inhalt):
        if opcode != 1:  # mode
            return
        flags, breite, hoehe, _ = struct.unpack('<Iiii', inhalt[:16])
        if flags & 1 and breite > 0 and hoehe > 0:  # current
            self.breite, self.hoehe = breite, hoehe

    def binde(self, name, version):
        kennung, angeboten = self.globals[name]
        neu = self.wl.id()
        self.wl.sende(
            self.registry,
            0,
            struct.pack('<I', kennung)
            + Verbindung.text(name)
            + struct.pack('<II', min(version, angeboten), neu),
        )
        return neu

    # ------------------------------------------------------------ Ereignisse

    def registry_ereignis(self, opcode, inhalt):
        if opcode != 0:
            return
        kennung, laenge = struct.unpack('<II', inhalt[:8])
        name = inhalt[8:8 + laenge - 1].decode()
        rest = 8 + laenge + ((-laenge) % 4)
        version, = struct.unpack('<I', inhalt[rest:rest + 4])
        self.globals[name] = (kennung, version)

    def wm_base_ereignis(self, opcode, inhalt):
        if opcode == 0:  # ping
            self.wl.sende(self.wm_base, 3, inhalt[:4])

    def xdg_flaeche_ereignis(self, opcode, inhalt):
        if opcode != 0:  # configure
            return
        serial, = struct.unpack('<I', inhalt[:4])
        self.wl.sende(self.xdg_flaeche, 4, struct.pack('<I', serial))
        self.zeichne(erstes=True)

    def toplevel_ereignis(self, opcode, inhalt):
        if opcode == 0:  # configure
            breite, hoehe = struct.unpack('<ii', inhalt[:8])
            if breite > 0 and hoehe > 0:
                self.breite, self.hoehe = breite, hoehe
        elif opcode == 1:  # close
            self.laeuft = False

    def puffer_ereignis(self, index):
        def behandeln(opcode, inhalt):
            if opcode == 0:  # release
                self.puffer_frei[index] = True

        return behandeln

    def bild_ereignis(self, opcode, inhalt):
        if opcode == 0:  # done
            self.zeichne()

    # -------------------------------------------------------------- Zeichnen

    def lege_puffer_an(self):
        if self.karte is not None:
            # Groessenwechsel: cage nennt die endgueltige Groesse erst, wenn
            # die Flaeche steht. Der alte Speicher wird nicht mehr gebraucht.
            self.karte.close()
        self.puffer_masse = (self.breite, self.hoehe)
        self.puffer_frei = [True, True]
        self.stride = self.breite * 4
        groesse = self.stride * self.hoehe
        fd = os.memfd_create('smartmirror-splash', 0)
        os.ftruncate(fd, groesse * 2)
        self.karte = mmap.mmap(fd, groesse * 2)

        pool = self.wl.id()
        self.wl.sende(self.shm, 0, struct.pack('<Ii', pool, groesse * 2), fd=fd)
        os.close(fd)

        for index in range(2):
            kennung = self.wl.id()
            self.puffer_ids[index] = kennung
            self.wl.behandler[kennung] = self.puffer_ereignis(index)
            self.wl.sende(
                pool,
                0,
                struct.pack('<IiiiiI', kennung, index * groesse, self.breite, self.hoehe, self.stride, 0),
            )
        self.puffer_groesse = groesse

        # Schwarz, einmal - und darauf in beide Puffer das Wortzeichen, das
        # sich nie aendert. Je Bild bleiben dann die Punkte.
        self.karte.seek(0)
        self.karte.write(b'\x00\x00\x00\xff' * (self.breite * self.hoehe) * 2)
        for index in range(2):
            self.male_ebene(index, self.mark_ausschnitt, self.mark_zeilen)

    def versatz(self, ausschnitt):
        """Wo die Ebene im Bild sitzt: der Block mittig, die Ebene darin."""
        x0, y0, _, _ = ausschnitt
        links = (self.breite - self.block_breite) // 2 + x0
        oben = (self.hoehe - self.block_hoehe) // 2 + y0
        return links, oben

    def male_ebene(self, index, ausschnitt, zeilen):
        links, oben = self.versatz(ausschnitt)
        breite = ausschnitt[2]
        if breite == 0:
            return
        for i, zeile in enumerate(zeilen):
            y = oben + i
            if y < 0 or y >= self.hoehe or links < 0 or links + breite > self.breite:
                continue
            stelle = index * self.puffer_groesse + y * self.stride + links * 4
            self.karte[stelle:stelle + breite * 4] = zeile

    def zeichne(self, erstes=False):
        if not self.laeuft:
            return
        if self.breite <= 0 or self.hoehe <= 0:
            # Ohne Groesse kein Bild: cage nennt sie im configure des
            # Toplevels, und ohne die waere jede Annahme geraten.
            return
        if self.karte is None or self.puffer_masse != (self.breite, self.hoehe):
            self.lege_puffer_an()

        jetzt = time.monotonic()
        if not erstes and jetzt - self.letztes_bild < TAKT_S:
            # Zu frueh fuer ein neues Bild: nur das naechste anfragen. Ohne
            # commit bliebe die Anfrage liegen und es kaeme nie wieder eines.
            self.frage_naechstes_bild()
            self.wl.sende(self.flaeche, 6)
            return

        index = 0 if self.puffer_frei[0] else (1 if self.puffer_frei[1] else -1)
        if index < 0:
            # Beide Puffer noch beim Compositor: dieses Bild auslassen und
            # beim naechsten wieder anfragen.
            self.frage_naechstes_bild()
            return

        zeit = time.monotonic() - self.beginn
        for nummer, (ausschnitt, stufen) in enumerate(self.punkte):
            wert = deckkraft(zeit + nummer * VERSATZ_S)
            stufe = min(STUFEN - 1, max(0, int(wert * STUFEN) - 1))
            self.male_ebene(index, ausschnitt, stufen[stufe])

        self.letztes_bild = jetzt
        self.puffer_frei[index] = False
        self.wl.sende(self.flaeche, 1, struct.pack('<Iii', self.puffer_ids[index], 0, 0))  # attach
        if erstes:
            self.wl.sende(self.flaeche, 2, struct.pack('<iiii', 0, 0, self.breite, self.hoehe))
        else:
            for ausschnitt, _ in self.punkte:
                links, oben = self.versatz(ausschnitt)
                self.wl.sende(self.flaeche, 2, struct.pack('<iiii', links, oben, ausschnitt[2], ausschnitt[3]))
        self.frage_naechstes_bild()
        self.wl.sende(self.flaeche, 6)  # commit

        if not self.gemeldet:
            # Eine Zeile ins Journal, wie bei allem anderen am Startbildschirm:
            # zwischen ihr und "[shell] erstes Bild" steht, wie lange der
            # Startbildschirm allein auf dem Bildschirm war.
            self.gemeldet = True
            print(f'Startbild steht nach {(time.monotonic() - self.beginn) * 1000:.0f} ms.', flush=True)

    def frage_naechstes_bild(self):
        kennung = self.wl.id()
        self.wl.behandler[kennung] = self.bild_ereignis
        self.wl.sende(self.flaeche, 3, struct.pack('<I', kennung))

    # ------------------------------------------------------------------ Lauf

    def lauf(self, hoechstens):
        while self.laeuft:
            if time.monotonic() - self.beginn > hoechstens:
                break
            if not self.wl.lesen(0.5):
                break


def main():
    if len(sys.argv) < 3:
        print('Aufruf: cage-splash.py <verzeichnis> <drehung>', file=sys.stderr)
        return 2

    verzeichnis, drehung = sys.argv[1], sys.argv[2]
    hoechstens = float(os.environ.get('MIRROR_SPLASH_MAX_S', '90'))

    startbild = None

    def beenden(*_):
        if startbild is not None:
            startbild.laeuft = False
        else:
            sys.exit(0)

    signal.signal(signal.SIGTERM, beenden)
    signal.signal(signal.SIGINT, beenden)

    startbild = Startbild(verzeichnis, drehung)
    startbild.lauf(hoechstens)
    return 0


if __name__ == '__main__':
    sys.exit(main())
