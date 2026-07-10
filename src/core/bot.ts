import type { Card } from './cards';
import { getLegalCards, resolveTrick, type GameState, type TrickPlay } from './game';
import { isClubTen, rawCardPoint } from './scoring';

export type BotDifficulty = 'foolish' | 'simple';

export const BOT_DIFFICULTIES: BotDifficulty[] = ['foolish', 'simple'];

export function isBotDifficulty(value: unknown): value is BotDifficulty {
  return value === 'foolish' || value === 'simple';
}

/**
 * Decide which card a bot should play. Pure and deterministic: the same game
 * state and difficulty always produce the same card, which keeps the behaviour
 * reproducible and testable (mirroring the seed-based shuffling in deck.ts).
 */
export function chooseBotCard(state: GameState, playerId: string, difficulty: BotDifficulty): Card {
  const legal = getLegalCards(state, playerId);
  if (legal.length === 0) {
    throw new Error('Bot has no legal card to play');
  }
  if (legal.length === 1) {
    return legal[0];
  }

  if (difficulty === 'foolish') {
    return pickDeterministic(state, playerId, legal);
  }

  return pickSimple(state, playerId, legal);
}

/**
 * "Foolish" bot: any legal card, chosen deterministically from the game seed so
 * replays stay reproducible instead of relying on Math.random.
 */
function pickDeterministic(state: GameState, playerId: string, legal: Card[]): Card {
  const trickIndex = state.currentTrick?.index ?? 0;
  const playCount = state.currentTrick?.plays.length ?? 0;
  const key = `${state.seed}|${playerId}|${trickIndex}|${playCount}`;
  const index = hashString(key) % legal.length;
  return legal[index];
}

/**
 * "Simple" bot: light heuristics that avoid throwing points away without any
 * card counting.
 */
function pickSimple(state: GameState, playerId: string, legal: Card[]): Card {
  const trick = state.currentTrick;
  const plays = trick?.plays ?? [];

  // Leading the trick: lead a low, harmless card and hold on to point cards.
  if (plays.length === 0) {
    return [...legal].sort((a, b) => leadWeight(a) - leadWeight(b))[0];
  }

  const leadSuit = plays[0].card.suit;
  const followCards = legal.filter((card) => card.suit === leadSuit);

  // Cannot follow suit: discard the most dangerous card we are holding.
  if (followCards.length === 0) {
    return [...legal].sort((a, b) => discardWeight(b) - discardWeight(a))[0];
  }

  // Following suit. Work out the current best card in the lead suit so we can
  // decide whether to duck under it.
  const currentWinner = highestOfSuit(plays, leadSuit);
  const losing = followCards.filter((card) => !beats(card, currentWinner));
  const winning = followCards.filter((card) => beats(card, currentWinner));

  // If we can stay under the current winner, duck with the highest safe card so
  // we shed a big card without taking the trick.
  if (losing.length > 0) {
    return [...losing].sort((a, b) => rankValue(b) - rankValue(a))[0];
  }

  // We are forced to win: take the trick with the smallest winning card.
  return [...winning].sort((a, b) => rankValue(a) - rankValue(b))[0];
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
  if (card.suit === 'spade' && card.rank === 12) return 1000; // 猪 -100
  const point = rawCardPoint(card);
  if (point < 0) return 500 + Math.abs(point); // hearts (bigger heart first)
  if (card.suit === 'diamond' && card.rank === 11) return -200; // 羊 +100, keep it
  if (isClubTen(card)) return -100; // 变压器, keep it
  return rankValue(card); // otherwise dump the highest plain card
}

/** Lower weight = better to lead. Prefer low, point-free cards. */
function leadWeight(card: Card): number {
  if (card.suit === 'spade' && card.rank === 12) return 10000;
  const point = rawCardPoint(card);
  if (point < 0) return 5000 + Math.abs(point);
  if (card.suit === 'diamond' && card.rank === 11) return 4000; // keep the 羊 to score later
  if (isClubTen(card)) return 3000; // keep the 变压器
  return rankValue(card);
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
