import type { InstanceKind } from '@unbent/shared';
import { instanceKindOf, instanceLabelOf } from '../routes/auth.js';
import type { Env } from '../types.js';

/** Where the page links its manifest from; `apps/web/index.html`. */
export const MANIFEST_PATH = '/manifest.webmanifest';

/**
 * The web manifest, as this instance should be installed.
 *
 * An installed web app is named and drawn from its manifest, and the manifest was one
 * static file, so production, dev.unbent.app and every PR's preview installed as the same
 * green "Unbent" — beside the Android app's own green icon on the same home screen, with
 * nothing to say which of them was the scratch copy. The tab already said so
 * (`instance-marker.ts`); the home screen, where the title and the favicon's badge are not
 * shown, did not.
 *
 * So the Worker answers this one path itself (`run_worker_first` in wrangler.toml) and,
 * on an instance with an `INSTANCE_LABEL`, renames the app the way the tab is titled —
 * "PR 222 · Unbent", the label first so a launcher that cuts the name short keeps the part
 * that differs — and points its icons at a copy in the kind's colour from styles.css: amber
 * for dev, violet for a preview, grey for local. The whole tile changes colour rather than
 * gaining the favicon's corner dot, because a launcher masks the icon to a circle or a
 * squircle and a dot in the corner is the first thing it cuts.
 *
 * Production has no label and is handed the static file untouched, byte for byte; the
 * only cost there is that the request now passes through the Worker. It is answered here,
 * ahead of Hono, so that pass is a single asset read and not the session lookup every
 * routed request makes.
 *
 * The recoloured icons are files in `apps/web/public/icons/<kind>/`, not drawn per request:
 * a Worker has no canvas, and the Android launcher wants PNGs. They were made from the
 * production icons with ImageMagick, using the red channel as the mask between the green
 * and the white (`<colour>` and `<ink>` are the kind's `--instance-*` pair):
 *
 *   magick -size <n>x<n> xc:'<colour>' xc:'<ink>' \
 *     \( icon.png -alpha off -channel R -separate +channel -level 18.43%,100% \) \
 *     -composite -depth 8 -strip PNG24:<kind>/icon.png
 *
 * If the production icon changes, run that again for each kind and size.
 */
export async function serveManifest(request: Request, env: Pick<Env, 'ASSETS' | 'INSTANCE_LABEL' | 'INSTANCE_KIND'>): Promise<Response> {
  const label = instanceLabelOf(env);
  if (!label) return env.ASSETS.fetch(request);
  // A plain GET, not the browser's conditional one: the static file's ETag describes the
  // file, not this answer, and a 304 against it would keep a manifest renamed under an
  // older label.
  const asset = await env.ASSETS.fetch(new Request(new URL(MANIFEST_PATH, request.url)));
  if (!asset.ok) return asset;
  const manifest = (await asset.json()) as WebManifest;
  return new Response(JSON.stringify(instanceManifest(manifest, label, instanceKindOf(env))), {
    headers: { 'Content-Type': 'application/manifest+json', 'Cache-Control': 'no-cache' },
  });
}

interface WebManifest {
  name?: string;
  short_name?: string;
  icons?: { src: string; [key: string]: unknown }[];
  [key: string]: unknown;
}

/**
 * The manifest renamed for `label` and, when the kind is one there are icons for, drawn in
 * that kind's colour. A label with no known kind — a self-hoster's "Staging" — is renamed
 * only.
 */
export function instanceManifest(manifest: WebManifest, label: string, kind: InstanceKind | undefined): WebManifest {
  const name = `${label} · ${manifest.short_name ?? manifest.name ?? 'Unbent'}`;
  return {
    ...manifest,
    name,
    short_name: name,
    icons: kind ? manifest.icons?.map((icon) => ({ ...icon, src: instanceIcon(icon.src, kind) })) : manifest.icons,
  };
}

/** `/icons/icon-512.png` → `/icons/preview/icon-512.png`. */
export function instanceIcon(src: string, kind: InstanceKind): string {
  return src.replace(/^\/icons\//, `/icons/${kind}/`);
}
