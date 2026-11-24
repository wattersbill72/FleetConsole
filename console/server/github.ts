// Resolves agent release files from this repository's private GitHub Releases.
// The console holds the GitHub token; nodes never do. A node is handed a short-lived signed URL.

export interface ReleaseConfig { repo: string; token: string; apiUrl: string }

export function releaseConfig(): ReleaseConfig | null {
  const repo = process.env.GITHUB_REPO;
  const token = process.env.GITHUB_RELEASE_TOKEN;
  if (!repo || !token || !/^[\w.-]+\/[\w.-]+$/.test(repo)) return null;
  return { repo, token, apiUrl: (process.env.GITHUB_API_URL || 'https://api.github.com').replace(/\/+$/, '') };
}

export const AGENT_TAG_PREFIX = 'agent-v';
export const DOWNLOADABLE = /^(fleetagent-(linux-amd64|darwin-arm64)|SHA256SUMS)$/;

export type Resolved =
  | { ok: true; location: string }
  | { ok: false; reason: 'no_release' | 'no_file' | 'upstream' };

const headers = (cfg: ReleaseConfig, accept: string) => ({
  Authorization: `Bearer ${cfg.token}`, Accept: accept, 'User-Agent': 'fleet-console', 'X-GitHub-Api-Version': '2022-11-28',
});

/** Find `file` in the newest published agent release and return the signed URL GitHub redirects to. */
export async function resolveAgentFile(cfg: ReleaseConfig, file: string): Promise<Resolved> {
  try {
    const list = await fetch(`${cfg.apiUrl}/repos/${cfg.repo}/releases?per_page=20`, {
      headers: headers(cfg, 'application/vnd.github+json'), signal: AbortSignal.timeout(8000),
    });
    if (!list.ok) return { ok: false, reason: 'upstream' };
    const releases = (await list.json()) as { tag_name: string; draft: boolean; prerelease: boolean; assets: { name: string; url: string }[] }[];
    const rel = releases.find((r) => !r.draft && !r.prerelease && r.tag_name.startsWith(AGENT_TAG_PREFIX));
    if (!rel) return { ok: false, reason: 'no_release' };
    const asset = rel.assets.find((a) => a.name === file);
    if (!asset) return { ok: false, reason: 'no_file' };

    const dl = await fetch(asset.url, {
      headers: headers(cfg, 'application/octet-stream'), redirect: 'manual', signal: AbortSignal.timeout(8000),
    });
    const location = dl.headers.get('location');
    if (dl.status >= 300 && dl.status < 400 && location) return { ok: true, location };
    return { ok: false, reason: 'upstream' };
  } catch {
    return { ok: false, reason: 'upstream' };
  }
}
