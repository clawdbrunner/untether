// === Channel Data ===
export interface YouTubeChannel {
  id: string;
  title: string;
  url: string;
  handle?: string;
  description?: string;
  avatarUrl?: string;
  subscriberCount?: number;
  subscriberCountApprox?: string;
}

export interface DeclaredLink {
  platform: 'peertube' | 'odysee' | 'lbry' | 'rumble' | 'unknown';
  url: string;
  source: 'description' | 'formal_links' | 'back_reference';
}

export interface ChannelCandidate {
  url: string;
  handle?: string;
  displayName: string;
  avatarUrl?: string;
  subscriberCount?: number;
  description?: string;
  platform: 'peertube' | 'odysee';
}

export type ConfidenceTier = 'verified' | 'likely' | 'possible' | 'weak';

export interface MatchResult {
  youtubeChannel: YouTubeChannel;
  platform: 'peertube' | 'odysee';
  candidates: ScoredCandidate[];
}

export interface ScoredCandidate {
  candidate: ChannelCandidate;
  tier: ConfidenceTier;
  signals: MatchSignal[];
  score: number;
}

export interface MatchSignal {
  type: 'declared_link' | 'back_reference' | 'name_match' | 'avatar_hash' | 'handle_match';
  strength: number;
  detail: string;
}

// === Pipeline ===
export interface PipelineConfig {
  youtubeApiKey?: string;
  platforms: ('peertube' | 'odysee')[];
  peertubeInstances?: string[];
  maxConcurrent?: number;
  onProgress?: (event: ProgressEvent) => void;
}

export interface ProgressEvent {
  phase: 'ingest' | 'enrich' | 'links' | 'match';
  current: number;
  total: number;
  message: string;
}

export interface PipelineResult {
  channels: YouTubeChannel[];
  matches: MatchResult[];
  stats: {
    totalChannels: number;
    enriched: number;
    enrichmentFailed: number;
    declaredLinksFound: number;
    verifiedMatches: number;
    likelyMatches: number;
    possibleMatches: number;
    weakMatches: number;
  };
}
