import type { Card } from './cards';
import { buildDeck } from './deck';
import type { GameConfig } from './config';

export interface ScoreBreakdown {
  score: number;
  pointsBeforeMultipliers: number;
  clubTenCount: number;
  clubMultiplier: number;
  heartSweepMultiplier: number;
  completedHeartDecks: number[];
  clubOnlyBonus: number | null;
  transformedCardIds: string[];
}

export function rawCardPoint(card: Card): number {
  if (card.suit === 'spade' && card.rank === 12) return -100;
  if (card.suit === 'diamond' && card.rank === 11) return 100;

  if (card.suit === 'heart') {
    if (card.rank >= 5 && card.rank <= 10) return -10;
    if (card.rank === 11) return -20;
    if (card.rank === 12) return -30;
    if (card.rank === 13) return -40;
    if (card.rank === 14) return -50;
  }

  return 0;
}

export function isClubTen(card: Card): boolean {
  return card.suit === 'club' && card.rank === 10;
}

export function calculateCoins(scores: number[], alpha: number): number[] {
  if (scores.length <= 1) {
    return scores.map(() => 0);
  }

  const rate = Number.isFinite(alpha) ? Math.max(0, alpha) : 0;
  const coins = scores.map((score) => (score < 0 ? score * rate : 0));

  scores.forEach((score, scorerIndex) => {
    if (score <= 0) return;

    const loss = (score / (scores.length - 1)) * rate;
    coins.forEach((_coin, playerIndex) => {
      if (playerIndex !== scorerIndex) {
        coins[playerIndex] -= loss;
      }
    });
  });

  return coins;
}

export function calculateScore(capturedCards: Card[], config: GameConfig): ScoreBreakdown {
  const clubTenCount = capturedCards.filter(isClubTen).length;
  const hasPointCards = capturedCards.some((card) => rawCardPoint(card) !== 0);

  if (clubTenCount > 0 && !hasPointCards) {
    return {
      score: clubTenCount === 1 ? 50 : 200,
      pointsBeforeMultipliers: 0,
      clubTenCount,
      clubMultiplier: 1,
      heartSweepMultiplier: 1,
      completedHeartDecks: [],
      clubOnlyBonus: clubTenCount === 1 ? 50 : 200,
      transformedCardIds: [],
    };
  }

  const capturedIds = new Set(capturedCards.map((card) => card.id));
  const completedHeartDecks = getCompletedHeartDecks(capturedIds, config);
  const transformedCardIds = new Set<string>();

  for (const card of capturedCards) {
    if (card.suit === 'heart' && rawCardPoint(card) < 0 && completedHeartDecks.includes(card.deckIndex)) {
      transformedCardIds.add(card.id);
    }
  }

  const spadeQueens = capturedCards.filter((card) => card.suit === 'spade' && card.rank === 12);
  if (config.deckCount === 1 && completedHeartDecks.length === 1) {
    for (const card of spadeQueens) transformedCardIds.add(card.id);
  }

  if (config.deckCount === 2) {
    if (completedHeartDecks.length === 2) {
      for (const card of spadeQueens) transformedCardIds.add(card.id);
    } else if (completedHeartDecks.length === 1 && spadeQueens.length > 0) {
      transformedCardIds.add(spadeQueens[0].id);
    }
  }

  const pointsBeforeMultipliers = capturedCards.reduce((total, card) => {
    const rawPoint = rawCardPoint(card);
    if (rawPoint < 0 && transformedCardIds.has(card.id)) {
      return total + Math.abs(rawPoint);
    }
    return total + rawPoint;
  }, 0);

  const heartSweepMultiplier = config.deckCount === 2 && completedHeartDecks.length === 2 ? 2 : 1;
  const clubMultiplier = clubTenCount > 0 ? 2 ** clubTenCount : 1;
  const score = pointsBeforeMultipliers * heartSweepMultiplier * clubMultiplier;

  return {
    score,
    pointsBeforeMultipliers,
    clubTenCount,
    clubMultiplier,
    heartSweepMultiplier,
    completedHeartDecks,
    clubOnlyBonus: null,
    transformedCardIds: [...transformedCardIds],
  };
}

function getCompletedHeartDecks(capturedIds: Set<string>, config: GameConfig): number[] {
  const activeHeartsByDeck = new Map<number, Card[]>();

  for (const card of buildDeck(config)) {
    if (card.suit !== 'heart') continue;
    const cards = activeHeartsByDeck.get(card.deckIndex) ?? [];
    cards.push(card);
    activeHeartsByDeck.set(card.deckIndex, cards);
  }

  const completed: number[] = [];
  for (const [deckIndex, hearts] of activeHeartsByDeck) {
    if (hearts.length > 0 && hearts.every((card) => capturedIds.has(card.id))) {
      completed.push(deckIndex);
    }
  }

  return completed;
}
