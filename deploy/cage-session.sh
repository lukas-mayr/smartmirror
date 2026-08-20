#!/usr/bin/env bash
#
# Startet die Anzeige-Anwendung unter dem Compositor `cage`.
#
# cage stellt genau ein Fenster im Vollbild dar und beendet sich, wenn die
# Anwendung endet – dann startet systemd beide zusammen neu. Ein Desktop wird
# nirgends gestartet.
set -euo pipefail

APP="/opt/smartmirror/current/shell/smartmirror-shell"
CORE_URL="${MIRROR_CORE_URL:-http://127.0.0.1:8080}"

if [[ ! -x "$APP" ]]; then
  echo "Anzeige-Anwendung nicht gefunden: $APP" >&2
  exit 1
fi

# Auf den Core warten, bevor das Fenster aufgeht: sonst zeigt der Spiegel beim
# Booten fuer ein paar Sekunden den Verbindungshinweis.
for _ in $(seq 1 30); do
  if curl -sf --max-time 2 "$CORE_URL/healthz" >/dev/null 2>&1; then break; fi
  sleep 1
done

# -s = Software-Cursor aus, -d = keine Dekorationen.
exec cage -s -- "$APP" \
  --ozone-platform=wayland \
  --enable-features=UseOzonePlatform,WaylandWindowDecorations \
  --disable-features=Translate,MediaRouter \
  --disable-pinch \
  --overscroll-history-navigation=0
