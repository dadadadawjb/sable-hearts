import { createCard, RANKS, SUITS, type Card } from './cards';
import type { GameConfig } from './config';

export function buildDeck(config: GameConfig): Card[] {
  const deck: Card[] = [];

  for (let deckIndex = 0; deckIndex < config.deckCount; deckIndex += 1) {
    for (const suit of SUITS) {
      for (const rank of RANKS) {
        deck.push(createCard(suit, rank, deckIndex));
      }
    }
  }

  for (const spec of config.removedCards) {
    for (let removed = 0; removed < spec.count; removed += 1) {
      const index = deck.findIndex((card) => card.suit === spec.suit && card.rank === spec.rank);
      if (index === -1) {
        throw new Error(`Cannot remove missing card ${spec.suit}-${spec.rank}`);
      }
      deck.splice(index, 1);
    }
  }

  return deck;
}

export function activeHeartCards(config: GameConfig): Card[] {
  return buildDeck(config).filter((card) => card.suit === 'heart');
}

export function randomSeed(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export function shuffleDeck(cards: Card[], seed: string): Card[] {
  const shuffled = [...cards];
  const random = mulberry32(hashSeed(seed));

  for (let i = shuffled.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }

  return shuffled;
}

function hashSeed(seed: string): number {
  let hash = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i += 1) {
    hash = Math.imul(hash ^ seed.charCodeAt(i), 3432918353);
    hash = (hash << 13) | (hash >>> 19);
  }
  return hash >>> 0;
}

function mulberry32(seed: number): () => number {
  return () => {
    let value = (seed += 0x6d2b79f5);
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}
