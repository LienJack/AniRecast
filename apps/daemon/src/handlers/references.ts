import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  addReference,
  assertWithinBudget,
  type CastReference,
  castAppearances,
  getCastMember,
  getProject,
  getSource,
  listReferences,
  projectCacheDir,
  recordCost,
  type Workspace,
} from '@anirecast/core';
import { probe } from '@anirecast/media';
import { estimateVisionCost } from '@anirecast/providers';
import { AniError, newId, toEnvelopeError } from '@anirecast/shared';
import type { JobContext, JobHandler } from '../runner.ts';
import { metered } from './metered.ts';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 15_0) AppleWebKit/537.36 (KHTML, like Gecko) AniRecast';
/** Sites that only show images after logging in or via scripts: their pages give nothing to scrape. */
const SKIP_HOSTS =
  /(^|\.)(pixiv\.net|x\.com|twitter\.com|instagram\.com|facebook\.com|tiktok\.com|youtube\.com)$/i;
/** An image file in a URL — also wiki-style paths that go on after it (…/sheet.png/revision/latest). */
const IMAGE_EXT = /\.(png|jpe?g|webp)(?=[/?#]|$)/i;
/** Page furniture, by file name: logos, icons, buttons, menu and share images, headings. */
const FURNITURE =
  /^(m|ttl)_|(^|[_-])(logo|icon|favicon|btn|button|share|sns|arrow|loading|spacer|nav|menu|bnr|banner)([_.-]|\d)/i;
const MAX_PAGES = 6;
const MAX_URLS_PER_PAGE = 80;
const MAX_DOWNLOADS = 160;
/** How many usable images the vision check sees, shared out between the pages. */
const MAX_CHECKED = 40;
const MAX_KEPT = 12;

async function fetchWithin(url: string, ms: number, signal: AbortSignal): Promise<Response> {
  const timeout = AbortSignal.timeout(ms);
  return fetch(url, {
    headers: { 'user-agent': UA, accept: '*/*' },
    redirect: 'follow',
    signal: AbortSignal.any([signal, timeout]),
  });
}

/** Image URLs on a page: <img src / data-src / srcset>, og:image and links to image files. */
export function imageUrlsOf(html: string, pageUrl: string): string[] {
  const found: string[] = [];
  const add = (u: string | undefined) => {
    if (!u) return;
    try {
      const url = new URL(u.trim().replace(/&amp;/g, '&'), pageUrl);
      const abs = url.toString();
      const name = decodeURIComponent(
        url.pathname
          .split('/')
          .filter(Boolean)
          .find((p) => IMAGE_EXT.test(p)) ?? '',
      );
      if (IMAGE_EXT.test(abs) && !FURNITURE.test(name) && !found.includes(abs)) found.push(abs);
    } catch {
      // not a URL
    }
  };
  for (const m of html.matchAll(
    /<meta[^>]+(?:property|name)=["']og:image["'][^>]*content=["']([^"']+)["']/gi,
  ))
    add(m[1]);
  for (const m of html.matchAll(/<img\b[^>]*>/gi)) {
    const tag = m[0];
    add(/\bdata-src=["']([^"']+)["']/i.exec(tag)?.[1]);
    add(/\bsrc=["']([^"']+)["']/i.exec(tag)?.[1]);
    const srcset = /\bsrcset=["']([^"']+)["']/i.exec(tag)?.[1];
    if (srcset)
      add(
        srcset
          .split(',')
          .map((s) => s.trim().split(/\s+/)[0])
          .at(-1),
      );
  }
  for (const m of html.matchAll(/<a\b[^>]*href=["']([^"']+\.(?:png|jpe?g|webp)(?:\?[^"']*)?)["']/gi))
    add(m[1]);
  return found;
}

/** Downloads an image into `dir` (size-capped); returns the file, or null for anything that is not a usable image. */
export async function downloadImage(url: string, dir: string, signal: AbortSignal): Promise<string | null> {
  try {
    const res = await fetchWithin(url, 15_000, signal);
    if (!res.ok) return null;
    const type = res.headers.get('content-type') ?? '';
    const ext = type.includes('png')
      ? '.png'
      : type.includes('webp')
        ? '.webp'
        : type.includes('jpeg') || type.includes('jpg')
          ? '.jpg'
          : IMAGE_EXT.exec(url)?.[1]
            ? `.${IMAGE_EXT.exec(url)?.[1]?.toLowerCase()}`
            : null;
    if (!ext) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 1_500 || buf.length > 12_000_000) return null;
    const file = path.join(dir, `${newId('dl')}${ext.replace('jpeg', 'jpg')}`);
    writeFileSync(file, buf);
    const p = await probe(file).catch(() => null);
    if (!p || Math.max(p.width, p.height) < 300 || Math.min(p.width, p.height) < 160) {
      rmSync(file, { force: true });
      return null;
    }
    return file;
  } catch {
    return null;
  }
}

/** Runs `fn` over `items`, at most `limit` at a time, keeping their order. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

interface Verdict {
  image: number;
  sameCharacter?: boolean;
  official?: boolean;
  kind?: string;
  score?: number;
  note?: string;
}

/**
 * 用 Agent 搜尋官方設定集: search the web (Gemini + Google Search) for official design art of an original
 * character, scrape the pages it names, download their images, and let the vision model keep the ones that are
 * this character and official design art. They are stored as candidates with their source; a person accepts.
 */
export const searchReferencesHandler: JobHandler = async (ctx: JobContext) => {
  const { workspace: ws, services, signal, job, progress } = ctx;
  const { castMemberId } = job.payload as { castMemberId: string };
  const cast = getCastMember(ws.db, castMemberId);
  const project = getProject(ws.db, cast.projectId);
  const source = getSource(ws.db, project.sourceId);
  const provider = services.provider;
  if (!provider.searchWeb)
    throw new AniError('dependency_missing', 'The configured provider cannot search the web');
  let cost = 0;
  const ledger = (meta: { provider: string; model: string; usage: never; costUsd: number }) => {
    const usd = meta.provider === 'fake' ? 0 : meta.costUsd;
    recordCost(ws.db, {
      jobId: job.id,
      projectId: project.id,
      provider: meta.provider,
      model: meta.model,
      usage: meta.usage,
      usd,
    });
    cost += usd;
  };

  progress(0.05, 'searching the web');
  const searchModel = services.config.models.search;
  if (provider.name !== 'fake') assertWithinBudget(ws.db, services.config.budget.capUsd, 0.06);
  const found = await metered(ctx, { model: searchModel, kind: 'vision' }, () =>
    provider.searchWeb!({
      model: searchModel,
      query: `Find web pages that show official character design art of the anime character "${cast.label}"${cast.description ? ` (${cast.description})` : ''}, who appears in the opening "${source.title}". Official website character pages, official social media, Blu-ray booklets or art books, staff posts: model sheets, turnarounds, expression sheets, official full-body art. Not fan art. List each page URL with one line on what it shows, and give the character's full name.`,
      signal,
    }),
  );
  ledger(found as never);
  const urls = [
    ...found.sources.map((s) => s.url),
    ...[...found.text.matchAll(/https?:\/\/[^\s)<>\]"'*]+/g)].map((m) => m[0].replace(/[.,;]+$/, '')),
  ];
  const pages: string[] = [];
  const htmls = new Map<string, string>();
  for (const u of urls) {
    if (pages.length >= MAX_PAGES) break;
    try {
      const res = await fetchWithin(u, 15_000, signal);
      const finalUrl = res.url || u;
      const host = new URL(finalUrl).hostname;
      if (SKIP_HOSTS.test(host) || pages.includes(finalUrl)) continue;
      if (!(res.headers.get('content-type') ?? '').includes('html')) continue;
      pages.push(finalUrl);
      htmls.set(finalUrl, (await res.text()).slice(0, 3_000_000));
    } catch {
      // unreachable page: skip
    }
  }
  const seen = new Set<string>();
  const candidates: Array<{ url: string; page: string }> = [];
  for (const page of pages) {
    const fresh = imageUrlsOf(htmls.get(page) ?? '', page).filter((url) => !seen.has(url));
    for (const url of fresh.slice(0, MAX_URLS_PER_PAGE)) {
      seen.add(url);
      candidates.push({ url, page });
    }
  }
  candidates.splice(MAX_DOWNLOADS);

  const tmp = path.join(ws.abs(projectCacheDir(project)), 'reference-search', job.id);
  mkdirSync(tmp, { recursive: true });
  try {
    progress(0.3, `downloading ${candidates.length} images from ${pages.length} pages`);
    type Download = { file: string; url: string; page: string };
    const got = (
      await mapLimit(candidates, 6, async (c): Promise<Download | null> => {
        const file = await downloadImage(c.url, tmp, signal);
        return file ? { file, ...c } : null;
      })
    ).filter((g): g is Download => g !== null);
    // Usable images, taken from each page in turn so one long page does not crowd out the others.
    const byPage = pages.map((page) => got.filter((g) => g.page === page));
    const files: Download[] = [];
    for (let i = 0; files.length < MAX_CHECKED && byPage.some((list) => i < list.length); i++)
      for (const list of byPage) if (list[i] && files.length < MAX_CHECKED) files.push(list[i]!);
    // The character as the clip shows her, to compare against.
    const own = castAppearances(ws, cast.id, 4)
      .map((a) => a.body ?? a.head)
      .filter((p): p is string => Boolean(p))
      .slice(0, 2)
      .map((p) => ws.abs(p));
    const known = new Set(listReferences(ws.db, cast.id).map((r) => r.sourceUrl));
    const kept: CastReference[] = [];
    const visionModel = services.config.models.vision;
    for (let i = 0; i < files.length && kept.length < MAX_KEPT; i += 8) {
      progress(0.5 + (0.5 * i) / Math.max(1, files.length), 'checking which images are official design art');
      const batch = files.slice(i, i + 8);
      const images = [...own, ...batch.map((b) => b.file)];
      if (provider.name !== 'fake')
        assertWithinBudget(
          ws.db,
          services.config.budget.capUsd,
          estimateVisionCost(visionModel, images.length),
        );
      const result = await metered(ctx, { model: visionModel, kind: 'vision' }, () =>
        provider.analyzeImages<{ images?: Verdict[] }>({
          model: visionModel,
          prompt: [
            `${own.length ? `Images 1–${own.length} show the character "${cast.label}" as she appears in the anime.` : `The character is "${cast.label}".`} Images ${own.length + 1}–${images.length} were found on web pages.`,
            `For each web image (by its number) say: sameCharacter — does it show this same character; official — is it official character design art (model sheet, turnaround, expression sheet, official full-body or character illustration), not a screenshot, fan art, merchandise photo, logo or another character; kind — turnaround, full body, expressions, face, poses or other; score from 0 to 1 that it is official design art of this character; note — one short line on what it shows.`,
          ].join('\n'),
          images: images.map((p) => ({
            path: p,
            mimeType: p.endsWith('.png') ? 'image/png' : p.endsWith('.webp') ? 'image/webp' : 'image/jpeg',
          })),
          responseSchema: {
            type: 'object',
            properties: {
              images: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    image: { type: 'integer' },
                    sameCharacter: { type: 'boolean' },
                    official: { type: 'boolean' },
                    kind: { type: 'string' },
                    score: { type: 'number' },
                    note: { type: 'string' },
                  },
                  required: ['image', 'sameCharacter', 'official', 'score'],
                },
              },
            },
            required: ['images'],
          },
          signal,
        }),
      );
      ledger(result as never);
      for (const v of result.data.images ?? []) {
        const b = batch[v.image - own.length - 1];
        if (!b || !v.sameCharacter || !v.official || Number(v.score ?? 0) < 0.5 || known.has(b.url)) continue;
        try {
          kept.push(
            addReference(
              ws,
              cast.id,
              b.file,
              {
                sourceUrl: b.url,
                pageUrl: b.page,
                label: [v.kind, v.note].filter(Boolean).join('：'),
                score: Number(v.score ?? 0),
                status: 'candidate',
              },
              'daemon',
            ),
          );
          known.add(b.url);
        } catch {
          // the same image twice
        }
        if (kept.length >= MAX_KEPT) break;
      }
    }
    return {
      result: {
        pages,
        found: candidates.length,
        usable: got.length,
        checked: files.length,
        kept: kept.length,
        answer: found.text.slice(0, 1200),
      },
      costUsd: cost,
    };
  } catch (error) {
    throw new AniError('transient', `Reference search failed: ${toEnvelopeError(error).message}`, {
      cause: error,
    });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
};

/** A reference the human pasted as a URL: downloaded and recorded as accepted (they chose it). */
export async function addReferenceFromUrl(
  ws: Workspace,
  castId: string,
  url: string,
  actor: string,
): Promise<CastReference> {
  const cast = getCastMember(ws.db, castId);
  const project = getProject(ws.db, cast.projectId);
  const tmp = path.join(ws.abs(projectCacheDir(project)), 'reference-paste', newId('tmp'));
  mkdirSync(tmp, { recursive: true });
  try {
    const file = await downloadImage(url, tmp, new AbortController().signal);
    if (!file)
      throw new AniError(
        'usage',
        'That URL did not give a usable image (PNG, JPEG or WebP, at least 300 px)',
      );
    return addReference(ws, castId, file, { sourceUrl: url, status: 'accepted', label: '貼上的參考' }, actor);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
