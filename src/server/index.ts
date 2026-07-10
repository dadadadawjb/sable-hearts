import cors from 'cors';
import express from 'express';
import { existsSync } from 'node:fs';
import { appendFile, mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server } from 'socket.io';
import { cardLabel } from '../core/cards';
import { getLegalCards, playCard, createGame, pickLowestScoreLeader, type GameState } from '../core/game';
import { calculateCoins, calculateScore, isClubTen, rawCardPoint } from '../core/scoring';
import { isSupportedPlayerCount, type PlayerCount } from '../core/config';
import { chooseBotDecision, isBotDifficulty, type BotDecision, type BotDifficulty } from '../core/bot';
import { getUserFromToken, loginUser, registerUser, requireAuth, type AuthSession } from './auth';

interface Seat {
  playerId: string;
  userId: string;
  token: string;
  name: string;
  ready: boolean;
  connected: boolean;
  socketId: string | null;
  isBot: boolean;
  botDifficulty: BotDifficulty | null;
}

interface Room {
  code: string;
  playerCount: PlayerCount;
  hostPlayerId: string;
  seats: Seat[];
  game: GameState | null;
  settings: RoomSettings;
  createdAt: number;
}

interface RoomSettings {
  showHistory: boolean;
  historyLimit: number;
  coinRate: number;
}

type Ack<T> = (response: ({ ok: true } & T) | { ok: false; error: string }) => void;

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: true,
    credentials: true,
  },
});

const rooms = new Map<string, Room>();

app.get('/health', (_request, response) => {
  response.json({ ok: true });
});

io.on('connection', (socket) => {
  socket.on('register', (payload: { username?: string; password?: string }, ack?: Ack<AuthSession>) => {
    reply(ack, () => registerUser(payload.username, payload.password));
  });

  socket.on('login', (payload: { username?: string; password?: string }, ack?: Ack<AuthSession>) => {
    reply(ack, () => loginUser(payload.username, payload.password));
  });

  socket.on('resumeAuth', (payload: { authToken?: string }, ack?: Ack<{ user: AuthSession['user'] }>) => {
    reply(ack, () => {
      const user = getUserFromToken(payload.authToken);
      if (!user) {
        throw new Error('登录已过期，请重新登录');
      }
      return { user };
    });
  });

  socket.on('createRoom', (payload: { authToken?: string; playerCount?: number }, ack?: Ack<{ roomCode: string; playerId: string; token: string }>) => {
    reply(ack, () => {
      const user = requireAuth(payload.authToken);
      const playerCount = Number(payload.playerCount);
      if (!isSupportedPlayerCount(playerCount)) {
        throw new Error('请选择 3、4、5、6 或 7 人');
      }

      const roomCode = createRoomCode();
      const playerId = createId();
      const token = createId();
      const seat: Seat = {
        playerId,
        userId: user.id,
        token,
        name: user.username,
        ready: false,
        connected: true,
        socketId: socket.id,
        isBot: false,
        botDifficulty: null,
      };

      const room: Room = {
        code: roomCode,
        playerCount,
        hostPlayerId: playerId,
        seats: [seat],
        game: null,
        settings: defaultRoomSettings(),
        createdAt: Date.now(),
      };

      rooms.set(roomCode, room);
      socket.join(roomCode);
      broadcastRoom(roomCode);
      return { roomCode, playerId, token };
    });
  });

  socket.on('joinRoom', (payload: { authToken?: string; roomCode?: string }, ack?: Ack<{ roomCode: string; playerId: string; token: string }>) => {
    reply(ack, () => {
      const user = requireAuth(payload.authToken);
      const room = requireRoom(payload.roomCode);
      if (room.game) {
        throw new Error('这局已经开始，只能断线重连');
      }
      if (room.seats.length >= room.playerCount) {
        throw new Error('房间已满');
      }
      if (room.seats.some((seat) => seat.userId === user.id)) {
        throw new Error('这个账号已经在房间里');
      }

      const playerId = createId();
      const token = createId();
      const seat: Seat = {
        playerId,
        userId: user.id,
        token,
        name: user.username,
        ready: false,
        connected: true,
        socketId: socket.id,
        isBot: false,
        botDifficulty: null,
      };

      room.seats.push(seat);
      socket.join(room.code);
      broadcastRoom(room.code);
      return { roomCode: room.code, playerId, token };
    });
  });

  socket.on('reconnectRoom', (payload: { roomCode?: string; playerId?: string; token?: string }, ack?: Ack<{ roomCode: string; playerId: string; token: string }>) => {
    reply(ack, () => {
      const { room, seat } = authenticate(payload);
      seat.connected = true;
      seat.socketId = socket.id;
      socket.join(room.code);
      broadcastRoom(room.code);
      return { roomCode: room.code, playerId: seat.playerId, token: seat.token };
    });
  });

  socket.on('setReady', (payload: { roomCode?: string; playerId?: string; token?: string; ready?: boolean }, ack?: Ack<Record<string, never>>) => {
    reply(ack, () => {
      const { room, seat } = authenticate(payload);
      if (room.game) {
        throw new Error('游戏已经开始');
      }
      seat.ready = Boolean(payload.ready);
      broadcastRoom(room.code);
      return {};
    });
  });

  socket.on(
    'addBot',
    (payload: { roomCode?: string; playerId?: string; token?: string; difficulty?: string }, ack?: Ack<{ botPlayerId: string }>) => {
      reply(ack, () => {
        const { room, seat } = authenticate(payload);
        if (room.hostPlayerId !== seat.playerId) {
          throw new Error('只有房主可以添加人机');
        }
        if (room.game) {
          throw new Error('游戏已经开始');
        }
        if (room.seats.length >= room.playerCount) {
          throw new Error('房间已满');
        }
        const difficulty: BotDifficulty = isBotDifficulty(payload.difficulty) ? payload.difficulty : 'simple';

        const botPlayerId = createId();
        const botSeat: Seat = {
          playerId: botPlayerId,
          userId: `bot:${botPlayerId}`,
          token: createId(),
          name: createBotName(room, difficulty),
          ready: true,
          connected: true,
          socketId: null,
          isBot: true,
          botDifficulty: difficulty,
        };

        room.seats.push(botSeat);
        broadcastRoom(room.code);
        return { botPlayerId };
      });
    },
  );

  socket.on(
    'removeBot',
    (payload: { roomCode?: string; playerId?: string; token?: string; botPlayerId?: string }, ack?: Ack<Record<string, never>>) => {
      reply(ack, () => {
        const { room, seat } = authenticate(payload);
        if (room.hostPlayerId !== seat.playerId) {
          throw new Error('只有房主可以移除人机');
        }
        if (room.game) {
          throw new Error('游戏已经开始');
        }
        const target = room.seats.find((candidate) => candidate.playerId === payload.botPlayerId);
        if (!target || !target.isBot) {
          throw new Error('人机不存在');
        }

        room.seats = room.seats.filter((candidate) => candidate.playerId !== target.playerId);
        broadcastRoom(room.code);
        return {};
      });
    },
  );

  socket.on(
    'setRoomSettings',
    (
      payload: {
        roomCode?: string;
        playerId?: string;
        token?: string;
        showHistory?: boolean;
        historyLimit?: number;
        coinRate?: number;
      },
      ack?: Ack<Record<string, never>>,
    ) => {
      reply(ack, () => {
        const { room, seat } = authenticate(payload);
        if (room.hostPlayerId !== seat.playerId) {
          throw new Error('只有房主可以修改设置');
        }

        room.settings = normalizeRoomSettings(payload, room.settings);
        broadcastRoom(room.code);
        return {};
      });
    },
  );

  socket.on('startGame', (payload: { roomCode?: string; playerId?: string; token?: string }, ack?: Ack<Record<string, never>>) => {
    reply(ack, () => {
      const { room, seat } = authenticate(payload);
      if (room.hostPlayerId !== seat.playerId) {
        throw new Error('只有房主可以开始');
      }
      if (room.game) {
        throw new Error('游戏已经开始');
      }
      if (room.seats.length !== room.playerCount) {
        throw new Error('人数未满');
      }
      if (!room.seats.every((candidate) => candidate.ready)) {
        throw new Error('还有玩家未准备');
      }

      room.game = createRoomGame(room);

      broadcastRoom(room.code);
      maybeRunBots(room.code);
      return {};
    });
  });

  socket.on('playCard', (payload: { roomCode?: string; playerId?: string; token?: string; cardId?: string }, ack?: Ack<Record<string, never>>) => {
    reply(ack, () => {
      const { room, seat } = authenticate(payload);
      if (!room.game) {
        throw new Error('游戏还没有开始');
      }
      if (!payload.cardId) {
        throw new Error('没有指定要出的牌');
      }

      room.game = playCard(room.game, seat.playerId, payload.cardId);
      broadcastRoom(room.code);
      maybeRunBots(room.code);
      return {};
    });
  });

  socket.on('restartGame', (payload: { roomCode?: string; playerId?: string; token?: string }, ack?: Ack<Record<string, never>>) => {
    reply(ack, () => {
      const { room, seat } = authenticate(payload);
      if (room.hostPlayerId !== seat.playerId) {
        throw new Error('只有房主可以重新开始');
      }
      if (room.seats.length !== room.playerCount) {
        throw new Error('人数未满');
      }
      if (room.game?.status !== 'finished') {
        throw new Error('本局还没有结束');
      }

      const leaderId = pickLowestScoreLeader(room.game.players);
      room.game = createRoomGame(room, leaderId);
      broadcastRoom(room.code);
      maybeRunBots(room.code);
      return {};
    });
  });

  socket.on('disconnect', () => {
    for (const room of rooms.values()) {
      const seat = room.seats.find((candidate) => candidate.socketId === socket.id);
      if (!seat) continue;
      seat.connected = false;
      seat.socketId = null;
      broadcastRoom(room.code);
    }
  });
});

function publicRoomState(room: Room, viewerId: string) {
  const game = room.game;
  const viewer = game?.players.find((player) => player.id === viewerId);
  const legalCardIds = game && game.currentPlayerId === viewerId ? getLegalCards(game, viewerId).map((card) => card.id) : [];
  const seatStates = room.seats.map((seat, index) => {
    const gamePlayer = game?.players.find((player) => player.id === seat.playerId);
    const preview = game && gamePlayer ? calculateScore(gamePlayer.captured, game.config) : null;
    return {
      seat: index,
      playerId: seat.playerId,
      name: seat.name,
      ready: seat.ready,
      connected: seat.connected,
      isHost: seat.playerId === room.hostPlayerId,
      isBot: seat.isBot,
      botDifficulty: seat.botDifficulty,
      handCount: gamePlayer?.hand.length ?? 0,
      capturedCount: gamePlayer?.captured.length ?? 0,
      score: game?.status === 'finished' ? gamePlayer?.score ?? 0 : preview?.score ?? 0,
      scoringCards: gamePlayer ? getScoringCards(gamePlayer.captured) : [],
    };
  });
  const coins =
    game?.status === 'finished'
      ? calculateCoins(
          seatStates.map((seat) => seat.score),
          room.settings.coinRate,
        )
      : seatStates.map(() => 0);

  return {
    roomCode: room.code,
    playerCount: room.playerCount,
    hostPlayerId: room.hostPlayerId,
    viewerId,
    settings: room.settings,
    seats: seatStates.map((seat, index) => ({ ...seat, coins: coins[index] })),
    game: game
      ? {
          id: game.id,
          status: game.status,
          seed: game.seed,
          currentPlayerId: game.currentPlayerId,
          currentTrick: game.currentTrick,
          completedTricks: room.settings.showHistory ? game.completedTricks.slice(-room.settings.historyLimit) : [],
          trickNumber: game.completedTricks.length + (game.status === 'playing' ? 1 : 0),
          totalTricks: game.config.handSize,
        }
      : null,
    hand: viewer?.hand ?? [],
    legalCardIds,
  };
}

function broadcastRoom(roomCode: string): void {
  const room = rooms.get(roomCode);
  if (!room) return;

  for (const seat of room.seats) {
    if (!seat.socketId) continue;
    io.to(seat.socketId).emit('roomState', publicRoomState(room, seat.playerId));
  }
}

function authenticate(payload: { roomCode?: string; playerId?: string; token?: string }): { room: Room; seat: Seat } {
  const room = requireRoom(payload.roomCode);
  const seat = room.seats.find((candidate) => candidate.playerId === payload.playerId && candidate.token === payload.token);
  if (!seat) {
    throw new Error('玩家身份已失效，请重新加入房间');
  }
  return { room, seat };
}

function requireRoom(roomCode?: string): Room {
  const normalized = normalizeRoomCode(roomCode);
  const room = rooms.get(normalized);
  if (!room) {
    throw new Error('房间不存在');
  }
  return room;
}

function normalizeRoomCode(roomCode?: string): string {
  return String(roomCode ?? '').trim().toUpperCase();
}

function createRoomGame(room: Room, leaderId?: string): GameState {
  return createGame(
    room.seats.map((candidate) => ({
      id: candidate.playerId,
      name: candidate.name,
    })),
    room.playerCount,
    undefined,
    undefined,
    leaderId,
  );
}

const BOT_PLAY_DELAY_MS = 700;
const botTimers = new Map<string, ReturnType<typeof setTimeout>>();
let botLogWriteQueue = Promise.resolve();

function createBotName(room: Room, difficulty: BotDifficulty): string {
  const labels: Record<BotDifficulty, string> = {
    foolish: '愚蠢',
    simple: '简单',
    medium: '中等',
    hard: '困难',
  };
  const existing = room.seats.filter((seat) => seat.isBot).length;
  return `机器人${existing + 1}（${labels[difficulty]}）`;
}

/**
 * When the current player is a bot, schedule its move. After playing it
 * re-checks, so a chain of bots plays one after another until it is a human's
 * turn or the game ends. Only one pending timer exists per room at a time.
 */
function maybeRunBots(roomCode: string): void {
  const room = rooms.get(roomCode);
  if (!room || !room.game || room.game.status !== 'playing') return;

  const currentId = room.game.currentPlayerId;
  if (!currentId) return;

  const seat = room.seats.find((candidate) => candidate.playerId === currentId);
  if (!seat || !seat.isBot || !seat.botDifficulty) return;

  if (botTimers.has(roomCode)) return;

  const timer = setTimeout(() => {
    botTimers.delete(roomCode);
    const activeRoom = rooms.get(roomCode);
    if (!activeRoom || !activeRoom.game || activeRoom.game.status !== 'playing') return;

    const activeSeat = activeRoom.seats.find((candidate) => candidate.playerId === activeRoom.game?.currentPlayerId);
    if (!activeSeat || !activeSeat.isBot || !activeSeat.botDifficulty) return;

    try {
      const gameBeforePlay = activeRoom.game;
      const startedAt = Date.now();
      const decision = chooseBotDecision(gameBeforePlay, activeSeat.playerId, activeSeat.botDifficulty);
      activeRoom.game = playCard(gameBeforePlay, activeSeat.playerId, decision.card.id);
      writeBotDecisionLog(activeRoom, activeSeat, gameBeforePlay, decision, Date.now() - startedAt);
      broadcastRoom(roomCode);
    } catch (error) {
      console.error(`Bot play failed in room ${roomCode}:`, error);
      return;
    }

    maybeRunBots(roomCode);
  }, BOT_PLAY_DELAY_MS);

  botTimers.set(roomCode, timer);
}

function writeBotDecisionLog(
  room: Room,
  seat: Seat,
  state: GameState,
  decision: BotDecision,
  decisionTimeMs: number,
): void {
  const player = state.players.find((candidate) => candidate.id === seat.playerId);
  const cardById = new Map(player?.hand.map((card) => [card.id, card]) ?? []);
  for (const play of state.currentTrick?.plays ?? []) cardById.set(play.card.id, play.card);
  const formatCardLabel = (cardId: string) => {
    const card = cardById.get(cardId);
    return card ? cardLabel(card) : '未知牌';
  };
  const loggedEvaluations = decision.trace.evaluations?.map(({ cardId, ...evaluation }) => ({
    card: formatCardLabel(cardId),
    ...evaluation,
  }));
  const entry = {
    trickIndex: state.currentTrick?.index ?? null,
    playIndex: state.currentTrick?.plays.length ?? null,
    playerName: seat.name,
    decisionTimeMs,
    hand: player?.hand.map(cardLabel).join(' ') ?? '',
    currentTrick: state.currentTrick?.plays.map((play) => cardLabel(play.card)).join(' ') ?? '',
    legalCards: decision.trace.legalCardIds.map(formatCardLabel).join(' '),
    selectedCard: formatCardLabel(decision.card.id),
    decision: {
      strategy: decision.trace.strategy,
      reason: decision.trace.reason,
      evaluations: loggedEvaluations,
      deterministicIndex: decision.trace.deterministicIndex,
      sampledDeals: decision.trace.sampledDeals,
      rolloutBudget: decision.trace.rolloutBudget,
      rolloutCount: decision.trace.rolloutCount,
      fallbackTo: decision.trace.fallbackTo,
    },
  };
  const roomCreatedAt = new Date(room.createdAt);
  const date = [
    roomCreatedAt.getFullYear(),
    String(roomCreatedAt.getMonth() + 1).padStart(2, '0'),
    String(roomCreatedAt.getDate()).padStart(2, '0'),
  ].join('-');
  const time = [
    String(roomCreatedAt.getHours()).padStart(2, '0'),
    String(roomCreatedAt.getMinutes()).padStart(2, '0'),
    String(roomCreatedAt.getSeconds()).padStart(2, '0'),
    String(roomCreatedAt.getMilliseconds()).padStart(3, '0'),
  ].join('-');
  const logDirectory = path.resolve(process.cwd(), 'logs');
  const logPath = path.join(logDirectory, `bot-decisions-${date}_${time}-${room.code}.jsonl`);
  const operation = botLogWriteQueue.then(async () => {
    await mkdir(logDirectory, { recursive: true });
    await appendFile(logPath, `${JSON.stringify(entry)}\n`, 'utf8');
  });
  botLogWriteQueue = operation.catch((error) => {
    console.error('Failed to write bot decision log:', error);
  });
}

function defaultRoomSettings(): RoomSettings {
  return {
    showHistory: true,
    historyLimit: 5,
    coinRate: 1,
  };
}

function normalizeRoomSettings(
  payload: { showHistory?: boolean; historyLimit?: number; coinRate?: number },
  current: RoomSettings,
): RoomSettings {
  const parsedLimit = Number(payload.historyLimit);
  const parsedCoinRate = Number(payload.coinRate);
  return {
    showHistory: typeof payload.showHistory === 'boolean' ? payload.showHistory : current.showHistory,
    historyLimit: Number.isFinite(parsedLimit) ? Math.max(1, Math.min(50, Math.floor(parsedLimit))) : current.historyLimit,
    coinRate: Number.isFinite(parsedCoinRate) ? Math.max(0, Math.min(1000, parsedCoinRate)) : current.coinRate,
  };
}

function getScoringCards(cards: GameState['players'][number]['captured']) {
  return cards.filter((card) => card.suit === 'heart' || rawCardPoint(card) !== 0 || isClubTen(card));
}

function createId(): string {
  return randomUUID();
}

function createRoomCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  do {
    code = Array.from({ length: 6 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function reply<T>(ack: Ack<T> | undefined, run: () => T): void {
  try {
    ack?.({ ok: true, ...run() });
  } catch (error) {
    ack?.({ ok: false, error: error instanceof Error ? error.message : '未知错误' });
  }
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const distPath = path.resolve(__dirname, '../../dist');

if (existsSync(distPath)) {
  app.use(express.static(distPath));
  app.get('*', (_request, response) => {
    response.sendFile(path.join(distPath, 'index.html'));
  });
}

const port = Number(process.env.PORT ?? 3000);
server.listen(port, () => {
  console.log(`Sable Hearts server listening on http://localhost:${port}`);
});
