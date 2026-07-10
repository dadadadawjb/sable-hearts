import { describe, expect, it } from 'vitest';
import {
  activeHeartCards,
  buildDeck,
  calculateScore,
  calculateCoins,
  chooseBotCard,
  createCard,
  createGame,
  getGameConfig,
  getLegalCards,
  playCard,
  resolveTrick,
  type Card,
  type GameState,
  type PlayerCount,
  type TrickPlay,
} from '../src/core';

describe('deck configuration', () => {
  it.each([
    [3, 51, 17],
    [4, 52, 13],
    [5, 50, 10],
    [6, 102, 17],
    [7, 98, 14],
  ] as const)('builds a %i-player deck with expected size', (playerCount, deckSize, handSize) => {
    const config = getGameConfig(playerCount);
    expect(buildDeck(config)).toHaveLength(deckSize);

    const game = createGame(makePlayers(playerCount), playerCount, 'fixed-seed');
    expect(game.players.every((player) => player.hand.length === handSize)).toBe(true);
  });
});

describe('trick rules', () => {
  it('requires following the lead suit when possible', () => {
    const state = makeState([
      [heart(5, 0)],
      [heart(10, 0), club(14, 0)],
      [spade(14, 0)],
      [diamond(11, 0)],
    ]);

    const afterLead = playCard(state, 'p1', heart(5, 0).id);
    expect(getLegalCards(afterLead, 'p2').map((card) => card.id)).toEqual([heart(10, 0).id]);
  });

  it('only lets the lead suit win a trick', () => {
    const winner = resolveTrick([
      { playerId: 'p1', card: heart(5, 0), order: 0 },
      { playerId: 'p2', card: spade(14, 0), order: 1 },
      { playerId: 'p3', card: heart(13, 0), order: 2 },
      { playerId: 'p4', card: heart(12, 0), order: 3 },
    ]);

    expect(winner).toBe('p3');
  });

  it('treats later identical cards as smaller with two decks', () => {
    const winner = resolveTrick([
      { playerId: 'p1', card: heart(10, 0), order: 0 },
      { playerId: 'p2', card: heart(10, 1), order: 1 },
      { playerId: 'p3', card: heart(9, 0), order: 2 },
      { playerId: 'p4', card: club(14, 0), order: 3 },
    ]);

    expect(winner).toBe('p1');
  });
});

describe('scoring', () => {
  it('awards the club ten only bonus', () => {
    expect(calculateScore([club(10, 0)], getGameConfig(4)).score).toBe(50);
    expect(calculateScore([club(10, 0), club(10, 1)], getGameConfig(6)).score).toBe(200);
  });

  it('turns all negative point cards positive after collecting every active heart in one deck', () => {
    const config = getGameConfig(4);
    const captured = [...activeHeartCards(config), spade(12, 0)];

    expect(calculateScore(captured, config).score).toBe(300);
  });

  it('turns one full heart deck and one spade queen positive in two-deck games', () => {
    const config = getGameConfig(6);
    const oneDeckHearts = activeHeartCards(config).filter((card) => card.deckIndex === 0);
    const captured = [...oneDeckHearts, spade(12, 0), spade(12, 1)];

    expect(calculateScore(captured, config).score).toBe(200);
  });

  it('applies two full heart decks multiplier before club ten multipliers', () => {
    const config = getGameConfig(6);
    const captured = [...activeHeartCards(config), spade(12, 0), spade(12, 1), club(10, 0), club(10, 1)];

    expect(calculateScore(captured, config).score).toBe(4800);
  });

  it('calculates coin losses from every positive score', () => {
    const coins = calculateCoins([100, 50, 0], 1);

    expect(coins[0]).toBeCloseTo(-25);
    expect(coins[1]).toBeCloseTo(-50);
    expect(coins[2]).toBeCloseTo(-75);
  });

  it('converts negative scores directly into negative coins', () => {
    const coins = calculateCoins([0, 0, -200], 0.01);

    expect(coins[0]).toBeCloseTo(0);
    expect(coins[1]).toBeCloseTo(0);
    expect(coins[2]).toBeCloseTo(-2);
  });

  it('applies alpha to coin losses', () => {
    const coins = calculateCoins([100, 0, 0, 0], 2);

    expect(coins[0]).toBeCloseTo(0);
    expect(coins[1]).toBeCloseTo(-66.6667);
    expect(coins[2]).toBeCloseTo(-66.6667);
    expect(coins[3]).toBeCloseTo(-66.6667);
  });
});

describe('bot decisions', () => {
  it('always returns a legal card for both difficulties', () => {
    const game = createGame(makePlayers(4), 4, 'bot-seed');
    for (const difficulty of ['foolish', 'simple'] as const) {
      const chosen = chooseBotCard(game, game.currentPlayerId!, difficulty);
      const legalIds = getLegalCards(game, game.currentPlayerId!).map((card) => card.id);
      expect(legalIds).toContain(chosen.id);
    }
  });

  it('is deterministic for the foolish difficulty', () => {
    const game = createGame(makePlayers(4), 4, 'bot-seed');
    const first = chooseBotCard(game, game.currentPlayerId!, 'foolish');
    const second = chooseBotCard(game, game.currentPlayerId!, 'foolish');
    expect(first.id).toBe(second.id);
  });

  it('follows the lead suit when required', () => {
    const state = withTrick(
      makeState([
        [heart(3, 0), spade(14, 0)],
        [heart(9, 0), heart(4, 0), club(14, 0)],
        [spade(2, 0)],
        [diamond(11, 0)],
      ]),
      'p2',
      [{ playerId: 'p1', card: heart(3, 0), order: 0 }],
    );

    for (const difficulty of ['foolish', 'simple'] as const) {
      const chosen = chooseBotCard(state, 'p2', difficulty);
      expect(chosen.suit).toBe('heart');
    }
  });

  it('ducks under the current winner instead of taking a clean trick', () => {
    const state = withTrick(
      makeState([
        [club(13, 0)],
        [club(9, 0), club(4, 0)],
        [club(2, 0)],
        [club(3, 0)],
      ]),
      'p2',
      [{ playerId: 'p1', card: club(13, 0), order: 0 }],
    );

    const chosen = chooseBotCard(state, 'p2', 'simple');
    // Both club 9 and 4 lose to the king; the bot sheds the higher safe card.
    expect(chosen.id).toBe(club(9, 0).id);
  });

  it('discards the most dangerous card when it cannot follow suit', () => {
    const state = withTrick(
      makeState([
        [club(13, 0)],
        [spade(12, 0), heart(14, 0), diamond(2, 0)],
        [club(2, 0)],
        [club(3, 0)],
      ]),
      'p2',
      [{ playerId: 'p1', card: club(13, 0), order: 0 }],
    );

    const chosen = chooseBotCard(state, 'p2', 'simple');
    // The queen of spades (猪, -100) is the most dangerous card to hold.
    expect(chosen.id).toBe(spade(12, 0).id);
  });
});

function withTrick(state: GameState, currentPlayerId: string, plays: TrickPlay[]): GameState {
  return {
    ...state,
    currentPlayerId,
    currentTrick: {
      index: 0,
      leaderId: plays[0]?.playerId ?? currentPlayerId,
      plays,
    },
  };
}

function makePlayers(playerCount: PlayerCount) {
  return Array.from({ length: playerCount }, (_, index) => ({
    id: `p${index + 1}`,
    name: `P${index + 1}`,
  }));
}

function makeState(hands: Card[][]): GameState {
  const config = getGameConfig(4);
  return {
    id: 'test-game',
    seed: 'test-seed',
    status: 'playing',
    config,
    players: hands.map((hand, index) => ({
      id: `p${index + 1}`,
      name: `P${index + 1}`,
      seat: index,
      hand,
      captured: [],
      score: 0,
      scoreBreakdown: null,
    })),
    currentPlayerId: 'p1',
    currentTrick: {
      index: 0,
      leaderId: 'p1',
      plays: [],
    },
    completedTricks: [],
  };
}

function heart(rank: Parameters<typeof createCard>[1], deckIndex: number): Card {
  return createCard('heart', rank, deckIndex);
}

function spade(rank: Parameters<typeof createCard>[1], deckIndex: number): Card {
  return createCard('spade', rank, deckIndex);
}

function diamond(rank: Parameters<typeof createCard>[1], deckIndex: number): Card {
  return createCard('diamond', rank, deckIndex);
}

function club(rank: Parameters<typeof createCard>[1], deckIndex: number): Card {
  return createCard('club', rank, deckIndex);
}
