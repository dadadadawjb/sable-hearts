import type { Rank, Suit } from './cards';

export type PlayerCount = 3 | 4 | 5 | 6 | 7;

export interface RemoveSpec {
  suit: Suit;
  rank: Rank;
  count: number;
}

export interface GameConfig {
  playerCount: PlayerCount;
  deckCount: 1 | 2;
  handSize: number;
  removedCards: RemoveSpec[];
}

export function isSupportedPlayerCount(value: number): value is PlayerCount {
  return value === 3 || value === 4 || value === 5 || value === 6 || value === 7;
}

export function getGameConfig(playerCount: PlayerCount): GameConfig {
  switch (playerCount) {
    case 3:
      return {
        playerCount,
        deckCount: 1,
        handSize: 17,
        removedCards: [{ suit: 'heart', rank: 2, count: 1 }],
      };
    case 4:
      return {
        playerCount,
        deckCount: 1,
        handSize: 13,
        removedCards: [],
      };
    case 5:
      return {
        playerCount,
        deckCount: 1,
        handSize: 10,
        removedCards: [
          { suit: 'heart', rank: 2, count: 1 },
          { suit: 'heart', rank: 3, count: 1 },
        ],
      };
    case 6:
      return {
        playerCount,
        deckCount: 2,
        handSize: 17,
        removedCards: [{ suit: 'heart', rank: 2, count: 2 }],
      };
    case 7:
      return {
        playerCount,
        deckCount: 2,
        handSize: 14,
        removedCards: [
          { suit: 'heart', rank: 2, count: 2 },
          { suit: 'heart', rank: 3, count: 2 },
          { suit: 'heart', rank: 4, count: 2 },
        ],
      };
  }
}
