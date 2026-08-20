import type { UpdateChannel } from '@mirror/sdk';
import { compare } from './semver.js';

export interface ReleaseAsset {
  name: string;
  url: string;
  size: number;
}

export interface Release {
  version: string;
  tag: string;
  prerelease: boolean;
  publishedAt: string;
  assets: ReleaseAsset[];
}

interface GitHubRelease {
  tag_name: string;
  draft: boolean;
  prerelease: boolean;
  published_at: string;
  assets: { name: string; browser_download_url: string; size: number }[];
}

const API = 'https://api.github.com';

function headers(token?: string): Record<string, string> {
  const base: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'smartmirror-updater',
  };
  if (token) base.Authorization = `Bearer ${token}`;
  return base;
}

/**
 * Sucht das passende Release fuer den eingestellten Kanal.
 *
 * "stable" nimmt nur regulaere Releases, "beta" auch Vorabversionen. Entwuerfe
 * werden immer ignoriert – sie sind noch nicht veroeffentlicht.
 */
export async function findLatestRelease(
  repository: string,
  channel: UpdateChannel,
  token: string | undefined,
  signal: AbortSignal,
): Promise<Release | null> {
  const response = await fetch(`${API}/repos/${repository}/releases?per_page=20`, {
    headers: headers(token),
    signal,
  });

  if (response.status === 404) {
    throw new Error(`Repository "${repository}" nicht gefunden (oder privat ohne Token)`);
  }
  if (response.status === 403 || response.status === 429) {
    // GitHub drosselt nicht angemeldete Zugriffe auf 60 pro Stunde. Bei
    // Viertelstunden-Takt passiert das nur, wenn mehrere Geraete am selben
    // Anschluss haengen – dann eben beim naechsten Lauf.
    throw new Error('GitHub-API drosselt gerade (Rate Limit). Naechster Versuch spaeter.');
  }
  if (!response.ok) {
    throw new Error(`GitHub-API antwortete mit HTTP ${response.status}`);
  }

  const body = (await response.json()) as GitHubRelease[];
  const candidates = body
    .filter((entry) => !entry.draft)
    .filter((entry) => (channel === 'stable' ? !entry.prerelease : true))
    .map<Release>((entry) => ({
      version: entry.tag_name.replace(/^v/, ''),
      tag: entry.tag_name,
      prerelease: entry.prerelease,
      publishedAt: entry.published_at,
      assets: entry.assets.map((asset) => ({
        name: asset.name,
        url: asset.browser_download_url,
        size: asset.size,
      })),
    }))
    .sort((a, b) => compare(b.version, a.version));

  return candidates[0] ?? null;
}

export function findAsset(release: Release, suffix: string): ReleaseAsset | null {
  return release.assets.find((asset) => asset.name.endsWith(suffix)) ?? null;
}

export async function downloadAsset(
  asset: ReleaseAsset,
  token: string | undefined,
  signal: AbortSignal,
  onProgress?: (received: number, total: number) => void,
): Promise<Buffer> {
  const response = await fetch(asset.url, { headers: headers(token), signal, redirect: 'follow' });
  if (!response.ok || !response.body) {
    throw new Error(`Download von "${asset.name}" fehlgeschlagen (HTTP ${response.status})`);
  }

  const total = Number(response.headers.get('content-length') ?? asset.size);
  const chunks: Buffer[] = [];
  let received = 0;

  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    const buffer = Buffer.from(chunk);
    chunks.push(buffer);
    received += buffer.length;
    onProgress?.(received, total);
  }

  return Buffer.concat(chunks);
}
