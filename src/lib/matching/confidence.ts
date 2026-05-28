import type {
  YouTubeChannel,
  ChannelCandidate,
  DeclaredLink,
  ScoredCandidate,
  MatchSignal,
  ConfidenceTier,
} from '../types.js';
import { nameSimilarity, normalizeHandle } from './name-utils.js';
import { hashSimilarity } from './phash.js';

export function scoreCandidate(
  ytChannel: YouTubeChannel,
  candidate: ChannelCandidate,
  declaredLink?: DeclaredLink,
  hasBackReference?: boolean,
  ytAvatarHash?: string,
  candidateAvatarHash?: string,
  lowEntropyAvatar?: boolean,
): ScoredCandidate {
  const signals: MatchSignal[] = [];

  // Signal 1: Declared link (strongest)
  if (declaredLink) {
    signals.push({
      type: 'declared_link',
      strength: 1.0,
      detail: `Found in ${declaredLink.source}`,
    });
  }

  // Signal 2: Back-reference
  if (hasBackReference) {
    signals.push({
      type: 'back_reference',
      strength: 0.95,
      detail: 'Candidate links back to YouTube channel',
    });
  }

  // Signal 3: Name match
  const nameScore = nameSimilarity(ytChannel.title, candidate.displayName);
  if (nameScore > 0.5) {
    signals.push({
      type: 'name_match',
      strength: nameScore,
      detail: `Name similarity: ${(nameScore * 100).toFixed(0)}%`,
    });
  }

  // Signal 4: Handle match
  if (ytChannel.handle && candidate.handle) {
    const ytHandle = normalizeHandle(ytChannel.handle);
    const candHandle = normalizeHandle(candidate.handle);
    if (ytHandle && candHandle) {
      const handleScore = ytHandle === candHandle ? 1.0 :
        ytHandle.includes(candHandle) || candHandle.includes(ytHandle) ? 0.85 :
        0;
      if (handleScore > 0.5) {
        signals.push({
          type: 'handle_match',
          strength: handleScore,
          detail: `Handle match: @${candidate.handle}`,
        });
      }
    }
  }

  // Signal 5: Avatar hash (zeroed for low-entropy avatars)
  if (ytAvatarHash && candidateAvatarHash && !lowEntropyAvatar) {
    const avatarScore = hashSimilarity(ytAvatarHash, candidateAvatarHash);
    if (avatarScore > 0.85) {
      signals.push({
        type: 'avatar_hash',
        strength: avatarScore,
        detail: `Avatar similarity: ${(avatarScore * 100).toFixed(0)}%`,
      });
    }
  }

  const score = computeCompositeScore(signals);
  const tier = determineTier(signals, score);

  return { candidate, tier, signals, score };
}

function computeCompositeScore(signals: MatchSignal[]): number {
  if (signals.length === 0) return 0;

  const weights: Record<string, number> = {
    declared_link: 1.0,
    back_reference: 0.95,
    name_match: 0.7,
    handle_match: 0.5,
    avatar_hash: 0.6,
  };

  let maxWeighted = 0;
  let bonusCount = 0;

  for (const signal of signals) {
    const weight = weights[signal.type] ?? 0.5;
    const weighted = signal.strength * weight;
    if (weighted > maxWeighted) maxWeighted = weighted;
    if (signal.strength > 0.6) bonusCount++;
  }

  // Bonus for multiple corroborating signals
  const multiSignalBonus = bonusCount > 1 ? 0.1 * (bonusCount - 1) : 0;

  return Math.min(1.0, maxWeighted + multiSignalBonus);
}

function determineTier(signals: MatchSignal[], score: number): ConfidenceTier {
  const hasType = (type: string) => signals.some((s) => s.type === type);

  // VERIFIED: has declared_link OR back_reference
  if (hasType('declared_link') || hasType('back_reference')) return 'verified';

  // Count strong signals
  const strongSignals = signals.filter((s) => s.strength > 0.7).length;

  // LIKELY: score >= 0.7 AND at least 2 strong signals
  if (score >= 0.7 && strongSignals >= 2) return 'likely';

  // POSSIBLE: score >= 0.5 AND at least 1 strong signal
  if (score >= 0.5 && strongSignals >= 1) return 'possible';

  // WEAK: everything else
  return 'weak';
}
