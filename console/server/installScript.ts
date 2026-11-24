import { INSTALL_SCRIPT } from './installScript.generated.js';

// The installer served at /install.sh. Source of truth is install/install.sh; `npm run contracts:build`
// copies it into installScript.generated.ts because only /console is deployed. It carries no secret: the
// enrolment token is passed as an argument and sent to the console on stdin to curl, never in a process list.

const ORIGIN = /^https?:\/\/[A-Za-z0-9.-]+(:\d{1,5})?$/;

/** The script with the console address filled in, or null if the address is not a plain origin. */
export function renderInstallScript(origin: string): string | null {
  // The origin is spliced into shell source. Refuse anything that is not a bare scheme://host[:port].
  if (!ORIGIN.test(origin)) return null;
  return INSTALL_SCRIPT.replaceAll('@@CONSOLE@@', origin);
}
