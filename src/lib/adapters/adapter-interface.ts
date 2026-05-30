import type { ChannelCandidate } from '../types.js';

export interface PlatformAdapter {
  readonly id: 'peertube' | 'odysee' | 'dailymotion' | 'bitchute' | 'rumble';
  searchChannels(query: string): Promise<ChannelCandidate[]>;
  resolveChannel(url: string): Promise<ChannelCandidate | null>;
  extractBackReferences(
    candidate: ChannelCandidate,
    youtubeChannelId: string,
    youtubeHandle?: string,
  ): Promise<boolean>;
}
