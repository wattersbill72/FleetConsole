// A notification channel is anything that can deliver one message to one address. Adding a second
// channel (OD-2) means implementing this interface and registering it; nothing else changes.

export interface Message {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export class SendError extends Error {
  constructor(message: string, public retryable: boolean) { super(message); }
}

export interface Channel {
  name: string;
  /** False when the channel's credentials or settings are missing; sends are then retried later. */
  configured(): boolean;
  send(m: Message): Promise<{ id?: string }>;
}

const registry = new Map<string, Channel>();

export function registerChannel(c: Channel) { registry.set(c.name, c); }
export function getChannel(name: string): Channel | undefined { return registry.get(name); }
export function channelNames(): string[] { return [...registry.keys()]; }
