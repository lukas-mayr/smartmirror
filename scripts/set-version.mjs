#!/usr/bin/env node
/**
 * Setzt eine Versionsnummer im gesamten Arbeitsbereich: in der Wurzel, in
 * jedem Paket unter packages/ und modules/ und in allen internen
 * @mirror/*-Abhaengigkeiten.
 *
 * Die internen Abhaengigkeiten sind der Grund, warum "npm version" hier nicht
 * reicht: Sie zeigen auf eine exakte Version ("@mirror/sdk": "0.6.0"). Bliebe
 * dort die alte Nummer stehen, waehrend das Paket selbst weiterzaehlt, wuerde
 * npm den Arbeitsbereich nicht mehr verlinken, sondern im Netz nach einem
 * Paket suchen, das es nicht gibt.
 *
 * Ersetzt wird im Text und nicht ueber JSON.parse/stringify, damit im Diff nur
 * die Versionszeilen stehen und nicht die halbe Datei neu formatiert ist.
 *
 * Aufgerufen wird das Skript vom Ablauf "Release nach Merge", nicht von Hand:
 * die naechste Nummer kommt aus dem letzten v*-Tag, und wer sie im Zweig schon
 * selbst setzt, nimmt dem Ablauf die Aenderung weg, die er als Versions-Commit
 * ablegen will. Von Hand gebraucht wird es nur, um eine Nummer zu reparieren,
 * die aus einem abgebrochenen Lauf schief steht.
 *
 * Aufruf: node scripts/set-version.mjs 0.7.0
 */
import { glob, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const version = process.argv[2]?.replace(/^v/, '') ?? '';
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error('Aufruf: node scripts/set-version.mjs <version>, z.B. 0.7.0');
  process.exit(1);
}

const manifests = ['package.json'];
for await (const entry of glob('{packages,modules}/*/package.json', { cwd: root })) {
  manifests.push(entry);
}
manifests.sort();

for (const relative of manifests) {
  const file = resolve(root, relative);
  const before = await readFile(file, 'utf8');

  const after = before
    // Nur das erste "version" ist das des Pakets selbst.
    .replace(/"version":\s*"[^"]*"/, `"version": "${version}"`)
    .replace(/"(@mirror\/[^"]+)":\s*"[^"]*"/g, `"$1": "${version}"`);

  if (after === before) {
    console.log(`${relative} unveraendert`);
    continue;
  }

  await writeFile(file, after, 'utf8');
  console.log(`${relative} -> ${version}`);
}
