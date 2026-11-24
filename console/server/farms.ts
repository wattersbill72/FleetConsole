export const NAME_MAX = 80;
export const DESCRIPTION_MAX = 500;

const ZONES = new Set((Intl as any).supportedValuesOf('timeZone') as string[]);
ZONES.add('UTC');

export interface FarmFields { name: string; description: string; time_zone: string }

export type Validated<T> = { ok: true; value: T } | { ok: false; error: string };

/** Validate a create body (all fields) or an update body (any subset). */
export function validateFarm(body: Record<string, unknown>, partial: boolean): Validated<Partial<FarmFields>> {
  const out: Partial<FarmFields> = {};

  if (body.name !== undefined || !partial) {
    if (typeof body.name !== 'string') return { ok: false, error: 'Name is required' };
    const name = body.name.trim();
    if (!name) return { ok: false, error: 'Name is required' };
    if (name.length > NAME_MAX) return { ok: false, error: `Name must be ${NAME_MAX} characters or fewer` };
    out.name = name;
  }
  if (body.description !== undefined) {
    if (typeof body.description !== 'string') return { ok: false, error: 'Description must be text' };
    const d = body.description.trim();
    if (d.length > DESCRIPTION_MAX) return { ok: false, error: `Description must be ${DESCRIPTION_MAX} characters or fewer` };
    out.description = d;
  }
  if (body.time_zone !== undefined || !partial) {
    if (typeof body.time_zone !== 'string' || !ZONES.has(body.time_zone)) {
      return { ok: false, error: 'Time zone must be a valid IANA name, for example America/Los_Angeles' };
    }
    out.time_zone = body.time_zone;
  }
  if (partial && Object.keys(out).length === 0) return { ok: false, error: 'Nothing to update' };
  return { ok: true, value: out };
}
