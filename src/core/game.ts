import { sortHand, type Card } from './cards';
import { getGameConfig, type PlayerCount } from './config';
import { buildDeck, randomSeed, shuffleDeck } from './deck';
import { calculateScore, type ScoreBreakdown } from './scoring';

export interface PlayerInfo {
  id: string;
  name: string;
}

export interface PlayerState extends PlayerInfo {
  seat: number;
  hand: Card[];
  captured: Card[];
  score: number;
  scoreBreakdown: ScoreBreakdown | null;
}

export interface TrickPlay {
  playerId: string;
  card: Card;
  order: number;
}

export interface CurrentTrick {
  index: number;
  leaderId: string;
  plays: TrickPlay[];
}

export interface CompletedTrick extends CurrentTrick {
  winnerId: string;
}

export type GameStatus = 'playing' | 'finished';

export interface GameState {
  id: string;
  seed: string;
  status: GameStatus;
  config: ReturnType<typeof getGameConfig>;
  players: PlayerState[];
  currentPlayerId: string | null;
  currentTrick: CurrentTrick | null;
  completedTricks: CompletedTrick[];
}

export function pickLowestScoreLeader(players: Array<{ id: string; score: number }>): string {
  let leader = players[0];
  for (const player of players.slice(1)) {
    if (player.score < leader.score) {
      leader = player;
    }
  }
  return leader.id;
}

export function createGame(
  players: PlayerInfo[],
  playerCount: PlayerCount,
  seed = randomSeed(),
  id = randomSeed(),
  leaderId?: string,
): GameState {
  if (players.length !== playerCount) {
    throw new Error(`Expected ${playerCount} players, got ${players.length}`);
  }

  const config = getGameConfig(playerCount);
  const deck = shuffleDeck(buildDeck(config), seed);
  const hands = Array.from({ length: playerCount }, () => [] as Card[]);

  deck.forEach((card, index) => {
    hands[index % playerCount].push(card);
  });

  const playerStates = players.map((player, seat) => ({
    ...player,
    seat,
    hand: sortHand(hands[seat]),
    captured: [],
    score: 0,
    scoreBreakdown: null,
  }));

  const resolvedLeaderId =
    leaderId && playerStates.some((player) => player.id === leaderId) ? leaderId : playerStates[0].id;

  return {
    id,
    seed,
    status: 'playing',
    config,
    players: playerStates,
    currentPlayerId: resolvedLeaderId,
    currentTrick: {
      index: 0,
      leaderId: resolvedLeaderId,
      plays: [],
    },
    completedTricks: [],
  };
}

export function getLegalCards(state: GameState, playerId: string): Card[] {
  if (state.status !== 'playing' || !state.currentTrick) return [];

  const player = requirePlayer(state, playerId);
  if (state.currentTrick.plays.length === 0) return player.hand;

  const leadSuit = state.currentTrick.plays[0].card.suit;
  const followSuitCards = player.hand.filter((card) => card.suit === leadSuit);
  return followSuitCards.length > 0 ? followSuitCards : player.hand;
}

export function playCard(state: GameState, playerId: string, cardId: string): GameState {
  if (state.status !== 'playing' || !state.currentTrick) {
    throw new Error('Game is not accepting plays');
  }

  if (state.currentPlayerId !== playerId) {
    throw new Error('It is not this player turn');
  }

  const legalCards = getLegalCards(state, playerId);
  if (!legalCards.some((card) => card.id === cardId)) {
    throw new Error('Card is not legal for this trick');
  }

  const next = cloneGameState(state);
  const player = requirePlayer(next, playerId);
  const cardIndex = player.hand.findIndex((card) => card.id === cardId);
  if (cardIndex === -1) {
    throw new Error('Card is not in hand');
  }

  const [card] = player.hand.splice(cardIndex, 1);
  player.hand = sortHand(player.hand);

  const trick = next.currentTrick;
  if (!trick) throw new Error('Current trick is missing');

  trick.plays.push({
    playerId,
    card,
    order: trick.plays.length,
  });

  if (trick.plays.length === next.config.playerCount) {
    return finishTrick(next, trick);
  }

  next.currentPlayerId = getNextPlayerId(next.players, playerId);
  return next;
}

export function resolveTrick(plays: TrickPlay[]): string {
  if (plays.length === 0) {
    throw new Error('Cannot resolve an empty trick');
  }

  const leadSuit = plays[0].card.suit;
  let best = plays[0];

  for (const play of plays.slice(1)) {
    if (play.card.suit !== leadSuit) continue;
    if (play.card.rank > best.card.rank) {
      best = play;
    }
  }

  return best.playerId;
}

function finishTrick(state: GameState, trick: CurrentTrick): GameState {
  const winnerId = resolveTrick(trick.plays);
  const winner = requirePlayer(state, winnerId);
  winner.captured.push(...trick.plays.map((play) => play.card));

  const completedTrick: CompletedTrick = {
    ...trick,
    plays: [...trick.plays],
    winnerId,
  };
  state.completedTricks.push(completedTrick);

  if (state.completedTricks.length === state.config.handSize) {
    const scoredPlayers = state.players.map((player) => {
      const scoreBreakdown = calculateScore(player.captured, state.config);
      return {
        ...player,
        score: scoreBreakdown.score,
        scoreBreakdown,
      };
    });

    return {
      ...state,
      status: 'finished',
      players: scoredPlayers,
      currentPlayerId: null,
      currentTrick: null,
    };
  }

  return {
    ...state,
    currentPlayerId: winnerId,
    currentTrick: {
      index: state.completedTricks.length,
      leaderId: winnerId,
      plays: [],
    },
  };
}

function getNextPlayerId(players: PlayerState[], playerId: string): string {
  const index = players.findIndex((player) => player.id === playerId);
  if (index === -1) {
    throw new Error('Player not found');
  }
  return players[(index + 1) % players.length].id;
}

function requirePlayer(state: GameState, playerId: string): PlayerState {
  const player = state.players.find((candidate) => candidate.id === playerId);
  if (!player) {
    throw new Error('Player not found');
  }
  return player;
}

function cloneGameState(state: GameState): GameState {
  return {
    ...state,
    config: { ...state.config, removedCards: state.config.removedCards.map((spec) => ({ ...spec })) },
    players: state.players.map((player) => ({
      ...player,
      hand: [...player.hand],
      captured: [...player.captured],
      scoreBreakdown: player.scoreBreakdown ? { ...player.scoreBreakdown } : null,
    })),
    currentTrick: state.currentTrick
      ? {
          ...state.currentTrick,
          plays: state.currentTrick.plays.map((play) => ({ ...play })),
        }
      : null,
    completedTricks: state.completedTricks.map((trick) => ({
      ...trick,
      plays: trick.plays.map((play) => ({ ...play })),
    })),
  };
}
