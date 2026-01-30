import * as bluesky from './bluesky.js';
import * as mastodon from './mastodon.js';
import * as twitter from './twitter.js';
import * as reddit from './reddit.js';

export const tier1Handlers = {
  bluesky,
  mastodon,
  twitter,
  reddit,
} as const;

export type { FetchedData } from '../../types.js';
