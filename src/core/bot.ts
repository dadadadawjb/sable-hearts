import type { Card } from './cards';
import { buildDeck } from './deck';
import { getLegalCards, playCard, resolveTrick, type GameState, type TrickPlay } from './game';
import { isClubTen, rawCardPoint } from './scoring';

export type BotDifficulty = 'foolish' | 'simple' | 'medium' | 'hard';

export const BOT_DIFFICULTIES: BotDifficulty[] = ['foolish', 'simple', 'medium', 'hard'];

export const BOT_STRATEGY_CONFIG = {
  simple: {
    lead: {
      spadeQueenWeight: 10_000,
      negativePointBaseWeight: 5_000,
      diamondJackWeight: 4_000,
      clubTenWeight: 3_000,
      ordinaryRankMultiplier: 1,
    },
    discard: {
      spadeQueenWeight: 1_000,
      negativePointBaseWeight: 500,
      diamondJackWeight: -200,
      clubTenWeight: -100,
      ordinaryRankMultiplier: 1,
    },
  },
  medium: {
    lead: {
      normalRankMultiplier: 1,
      masterRankMultiplier: 4,
      normalDangerMultiplier: 1.4,
      sweepDangerMultiplier: -0.8,
      singletonBonus: 35,
      sweepControlRankMultiplier: 9,
      nonSweepHeartPenalty: 70,
    },
    discard: {
      normalDangerMultiplier: 2.5,
      sweepDangerMultiplier: -0.5,
      rankMultiplier: 2,
      singletonBonus: 25,
      diamondJackPenalty: 220,
    },
    losingFollow: {
      rankMultiplier: 5,
      normalDangerMultiplier: 0.4,
      sweepDangerMultiplier: -0.3,
    },
    winningFollow: {
      rankPenaltyMultiplier: 1,
      certainTrickDangerMultiplier: 2.2,
      uncertainTrickDangerMultiplier: 0.8,
      sweepTrickDangerMultiplier: -1.8,
      unseenHigherCardPenalty: 3,
      sweepHoldBonus: 80,
    },
    sweep: {
      capturedHeartRatio: 0.55,
    },
    cardDanger: {
      negativePointMultiplier: 1,
      positivePointMultiplier: -1,
      clubTenWithNegativeRawScore: 80,
      clubTenWithoutNegativeRawScore: -40,
    },
  },
  hard: {
    singleDeck: {
      candidateLimit: 8,
      openingRolloutBudget: 256,
    },
    doubleDeck: {
      candidateLimit: 12,
      openingRolloutBudget: 128,
    },
    hiddenHandAssignmentAttempts: 20,
    opponentScoreWeight: 0.1,
  },
} as const;

export interface BotCardEvaluation {
  cardId: string;
  heuristicWeight?: number;
  mediumScore?: number;
  totalUtility?: number;
  averageUtility?: number;
}

export interface BotDecisionTrace {
  difficulty: BotDifficulty;
  strategy: string;
  reason: string;
  legalCardIds: string[];
  selectedCardId: string;
  evaluations?: BotCardEvaluation[];
  deterministicIndex?: number;
  sampledDeals?: number;
  rolloutBudget?: number;
  rolloutCount?: number;
  fallbackTo?: Exclude<BotDifficulty, 'hard'>;
}

export interface BotDecision {
  card: Card;
  trace: BotDecisionTrace;
}

export function isBotDifficulty(value: unknown): value is BotDifficulty {
  return value === 'foolish' || value === 'simple' || value === 'medium' || value === 'hard';
}

/**
 * Decide which card a bot should play. Pure and deterministic: the same game
 * state and difficulty always produce the same card, which keeps the behaviour
 * reproducible and testable (mirroring the seed-based shuffling in deck.ts).
 */
export function chooseBotCard(state: GameState, playerId: string, difficulty: BotDifficulty): Card {
  return chooseBotDecision(state, playerId, difficulty).card;
}

export function chooseBotDecision(state: GameState, playerId: string, difficulty: BotDifficulty): BotDecision {
  const legal = getLegalCards(state, playerId);
  if (legal.length === 0) {
    throw new Error('Bot has no legal card to play');
  }
  if (legal.length === 1) {
    return {
      card: legal[0],
      trace: {
        difficulty,
        strategy: 'forced-legal-card',
        reason: 'only-legal-card',
        legalCardIds: [legal[0].id],
        selectedCardId: legal[0].id,
      },
    };
  }

  if (difficulty === 'foolish') {
    const trickIndex = state.currentTrick?.index ?? 0;
    const playCount = state.currentTrick?.plays.length ?? 0;
    const key = `${state.seed}|${playerId}|${trickIndex}|${playCount}`;
    const index = hashString(key) % legal.length;
    return {
      card: legal[index],
      trace: {
        difficulty,
        strategy: 'deterministic-random',
        reason: 'seeded-index',
        legalCardIds: legal.map((card) => card.id),
        selectedCardId: legal[index].id,
        deterministicIndex: index,
      },
    };
  }

  if (difficulty === 'simple') {
    return getSimpleDecision(state, playerId, legal);
  }

  if (difficulty === 'medium') {
    return getMediumDecision(state, playerId, legal);
  }

  return getHardDecision(state, playerId, legal);
}

/**
 * "Simple" bot: light heuristics that avoid throwing points away without any
 * card counting.
 */
function pickSimple(state: GameState, playerId: string, legal: Card[]): Card {
  return getSimpleDecision(state, playerId, legal).card;
}

function getSimpleDecision(state: GameState, playerId: string, legal: Card[]): BotDecision {
  const trick = state.currentTrick;
  const plays = trick?.plays ?? [];
  const baseTrace = {
    difficulty: 'simple' as const,
    legalCardIds: legal.map((card) => card.id),
  };

  // Leading the trick: lead a low, harmless card and hold on to point cards.
  if (plays.length === 0) {
    const evaluations = legal.map((card) => ({ cardId: card.id, heuristicWeight: leadWeight(card) }));
    const card = [...legal].sort((a, b) => leadWeight(a) - leadWeight(b))[0];
    return {
      card,
      trace: {
        ...baseTrace,
        strategy: 'simple-lead',
        reason: 'lowest-lead-weight',
        selectedCardId: card.id,
        evaluations,
      },
    };
  }

  const leadSuit = plays[0].card.suit;
  const followCards = legal.filter((card) => card.suit === leadSuit);

  // Cannot follow suit: discard the most dangerous card we are holding.
  if (followCards.length === 0) {
    const evaluations = legal.map((card) => ({ cardId: card.id, heuristicWeight: discardWeight(card) }));
    const card = [...legal].sort((a, b) => discardWeight(b) - discardWeight(a))[0];
    return {
      card,
      trace: {
        ...baseTrace,
        strategy: 'simple-discard',
        reason: 'highest-discard-weight',
        selectedCardId: card.id,
        evaluations,
      },
    };
  }

  // Following suit. Work out the current best card in the lead suit so we can
  // decide whether to duck under it.
  const currentWinner = highestOfSuit(plays, leadSuit);
  const losing = followCards.filter((card) => !beats(card, currentWinner));
  const winning = followCards.filter((card) => beats(card, currentWinner));

  // If we can stay under the current winner, duck with the highest safe card so
  // we shed a big card without taking the trick.
  if (losing.length > 0) {
    const card = [...losing].sort((a, b) => rankValue(b) - rankValue(a))[0];
    return {
      card,
      trace: {
        ...baseTrace,
        strategy: 'simple-follow',
        reason: 'highest-losing-card',
        selectedCardId: card.id,
        evaluations: losing.map((candidate) => ({ cardId: candidate.id, heuristicWeight: rankValue(candidate) })),
      },
    };
  }

  // We are forced to win: take the trick with the smallest winning card.
  const card = [...winning].sort((a, b) => rankValue(a) - rankValue(b))[0];
  return {
    card,
    trace: {
      ...baseTrace,
      strategy: 'simple-follow',
      reason: 'lowest-winning-card',
      selectedCardId: card.id,
      evaluations: winning.map((candidate) => ({ cardId: candidate.id, heuristicWeight: rankValue(candidate) })),
    },
  };
}

/**
 * "Medium" bot: evaluates every legal play using only public information. It
 * remembers played cards, infers void suits and changes priorities when a
 * heart sweep becomes plausible.
 */
function pickMedium(state: GameState, playerId: string, legal: Card[]): Card {
  return getMediumDecision(state, playerId, legal).card;
}

function getMediumDecision(state: GameState, playerId: string, legal: Card[]): BotDecision {
  const evaluations = evaluateMediumCards(state, playerId, legal);
  const card = legal.find((candidate) => candidate.id === evaluations[0].cardId)!;
  return {
    card,
    trace: {
      difficulty: 'medium',
      strategy: 'public-information-evaluation',
      reason: 'highest-medium-score',
      legalCardIds: legal.map((candidate) => candidate.id),
      selectedCardId: card.id,
      evaluations,
    },
  };
}

function evaluateMediumCards(state: GameState, playerId: string, cards: Card[]): BotCardEvaluation[] {
  return cards
    .map((card) => ({ cardId: card.id, mediumScore: scoreMediumCard(state, playerId, card) }))
    .sort((a, b) => (b.mediumScore ?? 0) - (a.mediumScore ?? 0) || a.cardId.localeCompare(b.cardId));
}

/**
 * "Hard" bot: samples hidden hands consistent with public information, then
 * rolls each promising play to the end of the game. A fixed iteration count
 * and seeded PRNG keep decisions reproducible and server load bounded.
 */
function getHardDecision(state: GameState, playerId: string, legal: Card[]): BotDecision {
  const knowledge = getPublicKnowledge(state, playerId);
  const hiddenHandCount = state.players
    .filter((player) => player.id !== playerId)
    .reduce((total, player) => total + player.hand.length, 0);
  if (knowledge.unseen.length !== hiddenHandCount) {
    const medium = getMediumDecision(state, playerId, legal);
    return {
      card: medium.card,
      trace: {
        ...medium.trace,
        difficulty: 'hard',
        strategy: 'hard-fallback-medium',
        reason: 'incomplete-hidden-card-state',
        fallbackTo: 'medium',
      },
    };
  }

  const searchConfig =
    state.config.deckCount === 1 ? BOT_STRATEGY_CONFIG.hard.singleDeck : BOT_STRATEGY_CONFIG.hard.doubleDeck;
  const candidateLimit = searchConfig.candidateLimit;
  const mediumEvaluations = evaluateMediumCards(state, playerId, legal);
  const candidates = mediumEvaluations
    .slice(0, candidateLimit)
    .map((evaluation) => legal.find((card) => card.id === evaluation.cardId)!);
  const totals = new Map(candidates.map((card) => [card.id, 0]));
  const player = requireBotPlayer(state, playerId);
  const rolloutBudget = Math.round(
    searchConfig.openingRolloutBudget * (state.config.handSize / Math.max(1, player.hand.length)),
  );
  const iterations = Math.max(1, Math.floor(rolloutBudget / candidates.length));

  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const sampled = sampleHiddenHands(state, playerId, `${state.seed}|${state.currentTrick?.index}|${iteration}`);
    for (const card of candidates) {
      let simulated = playCard(sampled, playerId, card.id);
      while (simulated.status === 'playing' && simulated.currentPlayerId) {
        const currentId = simulated.currentPlayerId;
        const simulationLegal = getLegalCards(simulated, currentId);
        if (simulationLegal.length === 0) break;
        const choice = pickMedium(simulated, currentId, simulationLegal);
        simulated = playCard(simulated, currentId, choice.id);
      }
      totals.set(card.id, (totals.get(card.id) ?? 0) + gameUtility(simulated, playerId));
    }
  }

  const ranked = candidates.sort((a, b) => {
    const utilityDifference = (totals.get(b.id) ?? 0) - (totals.get(a.id) ?? 0);
    const mediumDifference =
      (mediumEvaluations.find((evaluation) => evaluation.cardId === b.id)?.mediumScore ?? 0) -
      (mediumEvaluations.find((evaluation) => evaluation.cardId === a.id)?.mediumScore ?? 0);
    return utilityDifference || mediumDifference || a.id.localeCompare(b.id);
  });
  const card = ranked[0];
  const evaluations = ranked.map((candidate) => {
    const totalUtility = totals.get(candidate.id) ?? 0;
    return {
      cardId: candidate.id,
      mediumScore: mediumEvaluations.find((evaluation) => evaluation.cardId === candidate.id)?.mediumScore,
      totalUtility,
      averageUtility: totalUtility / iterations,
    };
  });
  return {
    card,
    trace: {
      difficulty: 'hard',
      strategy: 'sampled-hidden-hands-rollout',
      reason: 'highest-accumulated-utility',
      legalCardIds: legal.map((candidate) => candidate.id),
      selectedCardId: card.id,
      evaluations,
      sampledDeals: iterations,
      rolloutBudget,
      rolloutCount: iterations * candidates.length,
    },
  };
}

function scoreMediumCard(state: GameState, playerId: string, card: Card): number {
  const player = requireBotPlayer(state, playerId);
  const plays = state.currentTrick?.plays ?? [];
  const knowledge = getPublicKnowledge(state, playerId);
  const danger = cardDanger(card, player.captured);
  const suitCount = player.hand.filter((candidate) => candidate.suit === card.suit).length;
  const sweep = isPursuingSweep(state, playerId, knowledge.unseen);
  const config = BOT_STRATEGY_CONFIG.medium;
  let score = 0;

  if (plays.length === 0) {
    const higherUnseen = knowledge.unseen.filter(
      (candidate) => candidate.suit === card.suit && candidate.rank > card.rank,
    ).length;
    const isMaster = higherUnseen === 0;
    score -= rankValue(card) * (isMaster ? config.lead.masterRankMultiplier : config.lead.normalRankMultiplier);
    score -= danger * (sweep ? config.lead.sweepDangerMultiplier : config.lead.normalDangerMultiplier);
    if (suitCount === 1) score += config.lead.singletonBonus;
    if (sweep && (card.suit === 'heart' || isMaster)) {
      score += rankValue(card) * config.lead.sweepControlRankMultiplier;
    }
    if (!sweep && card.suit === 'heart') score -= config.lead.nonSweepHeartPenalty;
    return score;
  }

  const leadSuit = plays[0].card.suit;
  if (card.suit !== leadSuit) {
    score += danger * (sweep ? config.discard.sweepDangerMultiplier : config.discard.normalDangerMultiplier);
    score += rankValue(card) * config.discard.rankMultiplier;
    if (suitCount === 1) score += config.discard.singletonBonus;
    if (card.suit === 'diamond' && card.rank === 11) score -= config.discard.diamondJackPenalty;
    return score;
  }

  const candidatePlay: TrickPlay = { playerId, card, order: plays.length };
  const candidatePlays = [...plays, candidatePlay];
  const winning = resolveTrick(candidatePlays) === playerId;
  const trickDanger = candidatePlays.reduce((total, play) => total + cardDanger(play.card, player.captured), 0);
  const isLast = candidatePlays.length === state.config.playerCount;

  if (!winning) {
    score += rankValue(card) * config.losingFollow.rankMultiplier;
    score +=
      danger *
      (sweep ? config.losingFollow.sweepDangerMultiplier : config.losingFollow.normalDangerMultiplier);
    return score;
  }

  const higherUnseen = knowledge.unseen.filter(
    (candidate) => candidate.suit === leadSuit && candidate.rank > card.rank,
  ).length;
  const likelyToHold = isLast || higherUnseen === 0;
  score -= rankValue(card) * config.winningFollow.rankPenaltyMultiplier;
  score -=
    trickDanger *
    (sweep
      ? config.winningFollow.sweepTrickDangerMultiplier
      : likelyToHold
        ? config.winningFollow.certainTrickDangerMultiplier
        : config.winningFollow.uncertainTrickDangerMultiplier);
  if (!isLast) score -= higherUnseen * config.winningFollow.unseenHigherCardPenalty;
  if (sweep && likelyToHold) score += config.winningFollow.sweepHoldBonus;
  return score;
}

interface PublicKnowledge {
  unseen: Card[];
  voidSuits: Map<string, Set<Card['suit']>>;
}

function getPublicKnowledge(state: GameState, playerId: string): PublicKnowledge {
  const player = requireBotPlayer(state, playerId);
  const seenIds = new Set<string>(player.hand.map((card) => card.id));
  for (const candidate of state.players) {
    for (const card of candidate.captured) seenIds.add(card.id);
  }
  for (const play of state.currentTrick?.plays ?? []) seenIds.add(play.card.id);

  const voidSuits = new Map(state.players.map((candidate) => [candidate.id, new Set<Card['suit']>()]));
  for (const trick of [...state.completedTricks, ...(state.currentTrick ? [state.currentTrick] : [])]) {
    const leadSuit = trick.plays[0]?.card.suit;
    if (!leadSuit) continue;
    for (const play of trick.plays.slice(1)) {
      if (play.card.suit !== leadSuit) voidSuits.get(play.playerId)?.add(leadSuit);
    }
  }

  return {
    unseen: buildDeck(state.config).filter((card) => !seenIds.has(card.id)),
    voidSuits,
  };
}

function sampleHiddenHands(state: GameState, playerId: string, seed: string): GameState {
  const knowledge = getPublicKnowledge(state, playerId);
  const opponents = state.players.filter((player) => player.id !== playerId);
  const random = createSeededRandom(seed);
  const shuffled = shuffleWith(knowledge.unseen, random);
  let assignments: Map<string, Card[]> | null = null;

  for (
    let attempt = 0;
    attempt < BOT_STRATEGY_CONFIG.hard.hiddenHandAssignmentAttempts && !assignments;
    attempt += 1
  ) {
    const candidateAssignments = new Map(opponents.map((player) => [player.id, [] as Card[]]));
    const cards = shuffleWith(shuffled, random).sort((a, b) => {
      const eligibleA = opponents.filter((player) => !knowledge.voidSuits.get(player.id)?.has(a.suit)).length;
      const eligibleB = opponents.filter((player) => !knowledge.voidSuits.get(player.id)?.has(b.suit)).length;
      return eligibleA - eligibleB;
    });
    let failed = false;

    for (const card of cards) {
      const eligible = shuffleWith(
        opponents.filter((player) => {
          const assigned = candidateAssignments.get(player.id)!;
          return assigned.length < player.hand.length && !knowledge.voidSuits.get(player.id)?.has(card.suit);
        }),
        random,
      );
      if (eligible.length === 0) {
        failed = true;
        break;
      }
      candidateAssignments.get(eligible[0].id)!.push(card);
    }

    if (!failed && opponents.every((player) => candidateAssignments.get(player.id)!.length === player.hand.length)) {
      assignments = candidateAssignments;
    }
  }

  if (!assignments) {
    assignments = new Map();
    let offset = 0;
    for (const opponent of opponents) {
      assignments.set(opponent.id, shuffled.slice(offset, offset + opponent.hand.length));
      offset += opponent.hand.length;
    }
  }

  return {
    ...state,
    players: state.players.map((player) => ({
      ...player,
      hand: player.id === playerId ? [...player.hand] : [...(assignments?.get(player.id) ?? [])],
      captured: [...player.captured],
      scoreBreakdown: player.scoreBreakdown ? { ...player.scoreBreakdown } : null,
    })),
    currentTrick: state.currentTrick
      ? { ...state.currentTrick, plays: state.currentTrick.plays.map((play) => ({ ...play })) }
      : null,
    completedTricks: state.completedTricks.map((trick) => ({
      ...trick,
      plays: trick.plays.map((play) => ({ ...play })),
    })),
  };
}

function isPursuingSweep(state: GameState, playerId: string, unseen: Card[]): boolean {
  const player = requireBotPlayer(state, playerId);
  const activeHearts = buildDeck(state.config).filter((card) => card.suit === 'heart' && rawCardPoint(card) < 0);
  const capturedHeartIds = new Set(
    player.captured.filter((card) => card.suit === 'heart' && rawCardPoint(card) < 0).map((card) => card.id),
  );
  const capturedHearts = capturedHeartIds.size;
  const remainingHearts = unseen.filter((card) => card.suit === 'heart' && rawCardPoint(card) < 0).length;
  return (
    capturedHearts >= Math.ceil(activeHearts.length * BOT_STRATEGY_CONFIG.medium.sweep.capturedHeartRatio) &&
    remainingHearts <= activeHearts.length - capturedHearts
  );
}

function cardDanger(card: Card, captured: Card[]): number {
  const config = BOT_STRATEGY_CONFIG.medium.cardDanger;
  const point = rawCardPoint(card);
  if (point < 0) return Math.abs(point) * config.negativePointMultiplier;
  if (point > 0) return point * config.positivePointMultiplier;
  if (isClubTen(card)) {
    const currentRawScore = captured.reduce((total, capturedCard) => total + rawCardPoint(capturedCard), 0);
    return currentRawScore < 0 ? config.clubTenWithNegativeRawScore : config.clubTenWithoutNegativeRawScore;
  }
  return 0;
}

function gameUtility(state: GameState, playerId: string): number {
  const player = requireBotPlayer(state, playerId);
  const opponents = state.players.filter((candidate) => candidate.id !== playerId);
  const averageOpponentScore =
    opponents.reduce((total, opponent) => total + opponent.score, 0) / Math.max(1, opponents.length);
  return player.score - averageOpponentScore * BOT_STRATEGY_CONFIG.hard.opponentScoreWeight;
}

function requireBotPlayer(state: GameState, playerId: string): GameState['players'][number] {
  const player = state.players.find((candidate) => candidate.id === playerId);
  if (!player) throw new Error('Bot player not found');
  return player;
}

function createSeededRandom(seed: string): () => number {
  let value = hashString(seed) || 1;
  return () => {
    value += 0x6d2b79f5;
    let result = value;
    result = Math.imul(result ^ (result >>> 15), result | 1);
    result ^= result + Math.imul(result ^ (result >>> 7), result | 61);
    return ((result ^ (result >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffleWith<T>(items: T[], random: () => number): T[] {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const target = Math.floor(random() * (index + 1));
    [result[index], result[target]] = [result[target], result[index]];
  }
  return result;
}

function highestOfSuit(plays: TrickPlay[], leadSuit: Card['suit']): TrickPlay {
  const winnerId = resolveTrick(plays);
  const winnerPlay = plays.find((play) => play.playerId === winnerId);
  if (winnerPlay && winnerPlay.card.suit === leadSuit) {
    return winnerPlay;
  }
  // Fallback: the highest lead-suit card played so far.
  return plays
    .filter((play) => play.card.suit === leadSuit)
    .sort((a, b) => rankValue(b.card) - rankValue(a.card))[0];
}

/**
 * Whether `card` would beat `reference` under the same-suit "later identical
 * card is smaller" rule used by resolveTrick.
 */
function beats(card: Card, reference: TrickPlay): boolean {
  return card.rank > reference.card.rank;
}

/** Higher weight = more dangerous to keep, so discard it first. */
function discardWeight(card: Card): number {
  const config = BOT_STRATEGY_CONFIG.simple.discard;
  if (card.suit === 'spade' && card.rank === 12) return config.spadeQueenWeight; // 猪 -100
  const point = rawCardPoint(card);
  if (point < 0) return config.negativePointBaseWeight + Math.abs(point); // hearts (bigger heart first)
  if (card.suit === 'diamond' && card.rank === 11) return config.diamondJackWeight; // 羊 +100, keep it
  if (isClubTen(card)) return config.clubTenWeight; // 变压器, keep it
  return rankValue(card) * config.ordinaryRankMultiplier; // otherwise dump the highest plain card
}

/** Lower weight = better to lead. Prefer low, point-free cards. */
function leadWeight(card: Card): number {
  const config = BOT_STRATEGY_CONFIG.simple.lead;
  if (card.suit === 'spade' && card.rank === 12) return config.spadeQueenWeight;
  const point = rawCardPoint(card);
  if (point < 0) return config.negativePointBaseWeight + Math.abs(point);
  if (card.suit === 'diamond' && card.rank === 11) return config.diamondJackWeight; // keep the 羊 to score later
  if (isClubTen(card)) return config.clubTenWeight; // keep the 变压器
  return rankValue(card) * config.ordinaryRankMultiplier;
}

function rankValue(card: Card): number {
  return card.rank;
}

function hashString(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}
