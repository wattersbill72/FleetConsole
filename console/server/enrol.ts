import { createHash, randomBytes } from 'node:crypto';
import type { VercelRequest } from '@vercel/node';
import { desiredConfigV1 } from './contracts.generated.js';
import { validate } from './schema.js';

export const ENROLMENT_TTL_MINUTES = 60;
export const MAX_OUTSTANDING_PER_FARM = 20;
export const MAX_ENROL_BODY_BYTES = 8192;
export const DISPLAY_NAME_MAX = 80;
export const PLATFORMS = ['ubuntu', 'macos'] as const;
export type Platform = (typeof PLATFORMS)[number];

// Unkeyed SHA-256 is deliberate: tokens and credentials are 192+ bit random values, and an unkeyed
// hash means rotating SESSION_SECRET cannot invalidate the fleet.
export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export function newEnrolmentToken(): string {
  return 'fce_' + randomBytes(24).toString('base64url');
}

export function newNodeCredential(): string {
  return 'fcn_' + randomBytes(32).toString('base64url');
}

export function consoleOrigin(req: VercelRequest): string {
  const fixed = process.env.CONSOLE_URL?.replace(/\/+$/, '');
  if (fixed) return fixed;
  const proto = (req.headers['x-forwarded-proto'] as string | undefined)?.split(',')[0] ?? 'https';
  return `${proto}://${req.headers.host}`;
}

export function installCommand(origin: string, token: string): string {
  return `curl -fsSL ${origin}/install.sh | sudo bash -s -- --token ${token}`;
}

/** Defaults for the fields every node must have; the operator's presets are layered on top. */
export function buildInitialConfig(preset: Record<string, unknown>, version = 1) {
  return { heartbeat_interval_s: 60, ...preset, schema_version: 1, version };
}

export interface EnrolmentInput {
  platform: Platform;
  displayName: string | null;
  initialConfig: Record<string, unknown>;
}

type Parsed = { ok: true; value: EnrolmentInput } | { ok: false; error: string };

export function parseEnrolmentInput(body: Record<string, unknown>): Parsed {
  if (!PLATFORMS.includes(body.platform as Platform)) return { ok: false, error: 'Platform must be ubuntu or macos' };

  let displayName: string | null = null;
  if (body.display_name !== undefined && body.display_name !== null && body.display_name !== '') {
    if (typeof body.display_name !== 'string') return { ok: false, error: 'Display name must be text' };
    displayName = body.display_name.trim();
    if (!displayName) displayName = null;
    else if (displayName.length > DISPLAY_NAME_MAX) {
      return { ok: false, error: `Display name must be ${DISPLAY_NAME_MAX} characters or fewer` };
    }
  }

  let preset: Record<string, unknown> = {};
  if (body.initial_config !== undefined) {
    if (typeof body.initial_config !== 'object' || body.initial_config === null || Array.isArray(body.initial_config)) {
      return { ok: false, error: 'Initial configuration must be an object' };
    }
    preset = { ...(body.initial_config as Record<string, unknown>) };
  }
  if (body.intermittent !== undefined) {
    if (typeof body.intermittent !== 'boolean') return { ok: false, error: 'Intermittent must be true or false' };
    preset.intermittent = body.intermittent;
  }

  const errors = validate(desiredConfigV1, buildInitialConfig(preset));
  if (errors.length) return { ok: false, error: `Invalid initial configuration: ${errors.join('; ')}` };
  const { schema_version: _s, version: _v, ...stored } = buildInitialConfig(preset);
  return { ok: true, value: { platform: body.platform as Platform, displayName, initialConfig: stored } };
}
