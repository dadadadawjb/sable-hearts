import { describe, expect, it } from 'vitest';
import {
  activeHeartCards,
  BOT_DIFFICULTIES,
  BOT_STRATEGY_CONFIG,
  buildDeck,
  calculateCoinSettlement,
  calculateScore,
  calculateCoins,
  calculateSettledCoins,
  chooseBotCard,
  chooseBotDecision,
  createCard,
  createGame,
  DEFAULT_COIN_RATE,
  getGameConfig,
  getLegalCards,
  pickLowestScoreLeader,
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

describe('game leader', () => {
  it('defaults to the first player when no leader is specified', () => {
    const game = createGame(makePlayers(4), 4, 'leader-seed');
    expect(game.currentPlayerId).toBe('p1');
    expect(game.currentTrick?.leaderId).toBe('p1');
  });

  it('uses the specified leader when restarting', () => {
    const game = createGame(makePlayers(4), 4, 'leader-seed', 'game-id', 'p3');
    expect(game.currentPlayerId).toBe('p3');
    expect(game.currentTrick?.leaderId).toBe('p3');
  });

  it('picks the player with the lowest score as the next leader', () => {
    const leaderId = pickLowestScoreLeader([
      { id: 'p1', score: 120 },
      { id: 'p2', score: -30 },
      { id: 'p3', score: 45 },
      { id: 'p4', score: -30 },
    ]);
    expect(leaderId).toBe('p2');
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
  it('defaults the room coin rate to 0.01', () => {
    expect(DEFAULT_COIN_RATE).toBe(0.01);
  });

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

  it('replaces previous coins when accumulation is disabled', () => {
    const coins = calculateSettledCoins([-5, -10, 0], [100, 50, 0], 0.01, false);

    expect(coins[0]).toBeCloseTo(-0.25);
    expect(coins[1]).toBeCloseTo(-0.5);
    expect(coins[2]).toBeCloseTo(-0.75);
  });

  it('adds round coins to previous totals when accumulation is enabled', () => {
    const settlement = calculateCoinSettlement([-5, -10, 0], [100, 50, 0], 0.01, true);

    expect(settlement.previousCoins).toEqual([-5, -10, 0]);
    expect(settlement.roundCoins[0]).toBeCloseTo(-0.25);
    expect(settlement.roundCoins[1]).toBeCloseTo(-0.5);
    expect(settlement.roundCoins[2]).toBeCloseTo(-0.75);
    expect(settlement.totalCoins[0]).toBeCloseTo(-5.25);
    expect(settlement.totalCoins[1]).toBeCloseTo(-10.5);
    expect(settlement.totalCoins[2]).toBeCloseTo(-0.75);
  });
});

describe('bot decisions', () => {
  it('always returns a legal card for every difficulty', () => {
    const game = createGame(makePlayers(4), 4, 'bot-seed');
    for (const difficulty of BOT_DIFFICULTIES) {
      const chosen = chooseBotCard(game, game.currentPlayerId!, difficulty);
      const legalIds = getLegalCards(game, game.currentPlayerId!).map((card) => card.id);
      expect(legalIds).toContain(chosen.id);
    }
  });

  it('is deterministic for every difficulty', () => {
    const game = createGame(makePlayers(4), 4, 'bot-seed');
    for (const difficulty of BOT_DIFFICULTIES) {
      const first = chooseBotCard(game, game.currentPlayerId!, difficulty);
      const second = chooseBotCard(game, game.currentPlayerId!, difficulty);
      expect(first.id).toBe(second.id);
    }
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

    for (const difficulty of BOT_DIFFICULTIES) {
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

    for (const difficulty of ['simple', 'medium', 'hard'] as const) {
      const chosen = chooseBotCard(state, 'p2', difficulty);
      // Both club 9 and 4 lose to the king; the bot sheds the higher safe card.
      expect(chosen.id).toBe(club(9, 0).id);
    }
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

    for (const difficulty of ['simple', 'medium', 'hard'] as const) {
      const chosen = chooseBotCard(state, 'p2', difficulty);
      // The queen of spades (猪, -100) is the most dangerous card to hold.
      expect(chosen.id).toBe(spade(12, 0).id);
    }
  });

  it('keeps medium and hard decisions independent of hidden opponent cards', () => {
    const firstState = createGame(makePlayers(4), 4, 'hidden-information');
    const secondState: GameState = {
      ...firstState,
      players: firstState.players.map((player) => ({ ...player, hand: [...player.hand] })),
    };
    const secondHand = secondState.players[1].hand;
    secondState.players[1].hand = secondState.players[2].hand;
    secondState.players[2].hand = secondHand;

    for (const difficulty of ['medium', 'hard'] as const) {
      expect(chooseBotCard(firstState, 'p1', difficulty).id).toBe(chooseBotCard(secondState, 'p1', difficulty).id);
    }
  });

  it('supports hard decisions with two decks and six players', () => {
    const game = createGame(makePlayers(6), 6, 'double-deck-bot');
    const chosen = chooseBotCard(game, game.currentPlayerId!, 'hard');
    expect(getLegalCards(game, game.currentPlayerId!).map((card) => card.id)).toContain(chosen.id);
  });

  it('reports a structured trace for every difficulty', () => {
    const game = createGame(makePlayers(4), 4, 'bot-trace');
    for (const difficulty of BOT_DIFFICULTIES) {
      const decision = chooseBotDecision(game, game.currentPlayerId!, difficulty);
      expect(decision.trace.difficulty).toBe(difficulty);
      expect(decision.trace.selectedCardId).toBe(decision.card.id);
      expect(decision.trace.legalCardIds).toContain(decision.card.id);
      expect(decision.trace.reason).not.toBe('');
      if (difficulty === 'hard') {
        expect(decision.trace.sampledDeals).toBe(
          Math.floor(
            BOT_STRATEGY_CONFIG.hard.singleDeck.openingRolloutBudget /
              BOT_STRATEGY_CONFIG.hard.singleDeck.candidateLimit,
          ),
        );
        expect(decision.trace.evaluations).toHaveLength(BOT_STRATEGY_CONFIG.hard.singleDeck.candidateLimit);
        expect(decision.trace.rolloutBudget).toBe(BOT_STRATEGY_CONFIG.hard.singleDeck.openingRolloutBudget);
        expect(decision.trace.rolloutCount).toBe(BOT_STRATEGY_CONFIG.hard.singleDeck.openingRolloutBudget);
      }
    }
  });

  it('redistributes the hard rollout budget when fewer candidates are legal', () => {
    const game = createGame(makePlayers(4), 4, 'dynamic-rollout-budget');
    const nextPlayer = game.players[1];
    const leadCard = game.players[0].hand
      .map((card) => ({
        card,
        followCount: nextPlayer.hand.filter((candidate) => candidate.suit === card.suit).length,
      }))
      .filter(({ followCount }) => followCount > 1 && followCount < BOT_STRATEGY_CONFIG.hard.singleDeck.candidateLimit)
      .sort((a, b) => a.followCount - b.followCount)[0];
    if (!leadCard) throw new Error('Test seed did not produce a suitable lead suit');

    const afterLead = playCard(game, game.currentPlayerId!, leadCard.card.id);
    const legalCount = getLegalCards(afterLead, afterLead.currentPlayerId!).length;
    const decision = chooseBotDecision(afterLead, afterLead.currentPlayerId!, 'hard');
    const expectedSamples = Math.floor(BOT_STRATEGY_CONFIG.hard.singleDeck.openingRolloutBudget / legalCount);

    expect(decision.trace.evaluations).toHaveLength(legalCount);
    expect(decision.trace.sampledDeals).toBe(expectedSamples);
    expect(decision.trace.rolloutCount).toBe(expectedSamples * legalCount);
    expect(decision.trace.rolloutCount).toBeLessThanOrEqual(
      BOT_STRATEGY_CONFIG.hard.singleDeck.openingRolloutBudget,
    );
  });

  it('increases the hard rollout budget as hands get shorter', () => {
    let game = createGame(makePlayers(4), 4, 'progressive-rollout-budget');
    while (game.status === 'playing') {
      const currentId = game.currentPlayerId!;
      const currentPlayer = game.players.find((player) => player.id === currentId)!;
      const legal = getLegalCards(game, currentId);
      if (currentPlayer.hand.length <= 6 && legal.length > 1) break;
      game = playCard(game, currentId, chooseBotCard(game, currentId, 'simple').id);
    }
    if (game.status !== 'playing' || !game.currentPlayerId) {
      throw new Error('Test seed did not produce a suitable late-game decision');
    }

    const currentPlayer = game.players.find((player) => player.id === game.currentPlayerId)!;
    const expectedBudget = Math.round(
      BOT_STRATEGY_CONFIG.hard.singleDeck.openingRolloutBudget *
        (game.config.handSize / currentPlayer.hand.length),
    );
    const decision = chooseBotDecision(game, game.currentPlayerId, 'hard');

    expect(decision.trace.rolloutBudget).toBe(expectedBudget);
    expect(decision.trace.rolloutBudget).toBeGreaterThan(BOT_STRATEGY_CONFIG.hard.singleDeck.openingRolloutBudget);
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
