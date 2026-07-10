import { useEffect, useMemo, useState, type PointerEvent } from 'react';
import { io } from 'socket.io-client';
import packageJson from '../../package.json';
import { cardLabel, isRedSuit, rankLabel, suitLabel, type BotDifficulty, type Card } from '../core';

type SeatState = {
  seat: number;
  playerId: string;
  name: string;
  ready: boolean;
  connected: boolean;
  isHost: boolean;
  isBot: boolean;
  botDifficulty: BotDifficulty | null;
  handCount: number;
  capturedCount: number;
  score: number;
  coins: number;
  scoringCards: Card[];
};

type PublicRoomState = {
  roomCode: string;
  playerCount: number;
  hostPlayerId: string;
  viewerId: string;
  settings: {
    showHistory: boolean;
    historyLimit: number;
    coinRate: number;
  };
  seats: SeatState[];
  game: {
    id: string;
    status: 'playing' | 'finished';
    seed: string;
    currentPlayerId: string | null;
    currentTrick: {
      index: number;
      leaderId: string;
      plays: { playerId: string; card: Card; order: number }[];
    } | null;
    completedTricks: {
      index: number;
      leaderId: string;
      winnerId: string;
      plays: { playerId: string; card: Card; order: number }[];
    }[];
    trickNumber: number;
    totalTricks: number;
  } | null;
  hand: Card[];
  legalCardIds: string[];
};

type AuthUser = {
  id: string;
  username: string;
};

type AuthSession = {
  user: AuthUser;
  token: string;
};

type RoomSession = {
  roomCode: string;
  playerId: string;
  token: string;
};

type Ack<T> = ({ ok: true } & T) | { ok: false; error: string };

const serverUrl =
  import.meta.env.VITE_SERVER_URL ??
  (window.location.port === '5173' ? 'http://localhost:3000' : window.location.origin);

const socket = io(serverUrl, {
  autoConnect: true,
});

const appVersion = packageJson.version;

export function App() {
  const [roomState, setRoomState] = useState<PublicRoomState | null>(null);
  const [roomSession, setRoomSession] = useState<RoomSession | null>(null);
  const [auth, setAuth] = useState<AuthSession | null>(loadAuthSession());
  const [authChecked, setAuthChecked] = useState(false);
  const [authMode, setAuthMode] = useState<'login' | 'register'>('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [roomCodeInput, setRoomCodeInput] = useState(getRoomCodeFromPath());
  const [playerCount, setPlayerCount] = useState(4);
  const [botDifficulty, setBotDifficulty] = useState<BotDifficulty>('simple');
  const [connected, setConnected] = useState(socket.connected);
  const [error, setError] = useState('');
  const [activeRuleCardId, setActiveRuleCardId] = useState<string | null>(null);
  const [lastPointerKind, setLastPointerKind] = useState<'mouse' | 'touch'>('mouse');
  const [showRules, setShowRules] = useState(false);

  useEffect(() => {
    const onConnect = () => setConnected(true);
    const onDisconnect = () => setConnected(false);
    const onRoomState = (state: PublicRoomState) => setRoomState(state);

    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    socket.on('roomState', onRoomState);

    return () => {
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
      socket.off('roomState', onRoomState);
    };
  }, []);

  useEffect(() => {
    const savedAuth = loadAuthSession();
    if (!savedAuth) {
      setAuthChecked(true);
      return;
    }

    emitAck<{ user: AuthUser }>('resumeAuth', { authToken: savedAuth.token }).then((response) => {
      if (response.ok) {
        const resumed = { token: savedAuth.token, user: response.user };
        saveAuthSession(resumed);
        setAuth(resumed);
      } else {
        clearAuthSession();
        setAuth(null);
      }
      setAuthChecked(true);
    });
  }, []);

  useEffect(() => {
    const roomCode = getRoomCodeFromPath();
    if (!roomCode) return;
    const savedRoomSession = loadRoomSession(roomCode);
    if (!savedRoomSession) return;

    setRoomSession(savedRoomSession);
    emitAck<RoomSession>('reconnectRoom', savedRoomSession).then((response) => {
      if (!response.ok) {
        setError(response.error);
        clearRoomSession(roomCode);
        setRoomSession(null);
      }
    });
  }, []);

  const viewerSeat = useMemo(
    () => roomState?.seats.find((seat) => seat.playerId === roomSession?.playerId) ?? null,
    [roomState, roomSession],
  );
  const currentSeat = useMemo(
    () => roomState?.seats.find((seat) => seat.playerId === roomState.game?.currentPlayerId) ?? null,
    [roomState],
  );
  const isHost = Boolean(roomSession && roomState?.hostPlayerId === roomSession.playerId);
  const legalCardIds = useMemo(() => new Set(roomState?.legalCardIds ?? []), [roomState]);
  const isViewerTurn = Boolean(
    roomState?.game?.currentPlayerId && roomState.game.currentPlayerId === roomSession?.playerId,
  );

  async function submitAuth() {
    setError('');
    const response = await emitAck<AuthSession>(authMode, { username, password });
    if (!response.ok) {
      setError(response.error);
      return;
    }

    saveAuthSession(response);
    setAuth(response);
    setPassword('');
  }

  function logout() {
    clearAuthSession();
    setAuth(null);
    setRoomState(null);
    setRoomSession(null);
    setPassword('');
  }

  async function createRoom() {
    if (!auth) return;
    setError('');
    const response = await emitAck<RoomSession>('createRoom', { authToken: auth.token, playerCount });
    if (!response.ok) {
      setError(response.error);
      return;
    }
    saveRoomSession(response);
    setRoomSession(response);
    setRoomCodeInput(response.roomCode);
    window.history.replaceState({}, '', `/room/${response.roomCode}`);
  }

  async function joinRoom() {
    if (!auth) return;
    setError('');
    const response = await emitAck<RoomSession>('joinRoom', { authToken: auth.token, roomCode: roomCodeInput });
    if (!response.ok) {
      setError(response.error);
      return;
    }
    saveRoomSession(response);
    setRoomSession(response);
    window.history.replaceState({}, '', `/room/${response.roomCode}`);
  }

  async function setReady(ready: boolean) {
    if (!roomSession) return;
    const response = await emitAck<Record<string, never>>('setReady', { ...roomSession, ready });
    if (!response.ok) setError(response.error);
  }

  async function startGame() {
    if (!roomSession) return;
    const response = await emitAck<Record<string, never>>('startGame', roomSession);
    if (!response.ok) setError(response.error);
  }

  async function addBot(difficulty: BotDifficulty) {
    if (!roomSession) return;
    setError('');
    const response = await emitAck<{ botPlayerId: string }>('addBot', { ...roomSession, difficulty });
    if (!response.ok) setError(response.error);
  }

  async function removeBot(botPlayerId: string) {
    if (!roomSession) return;
    setError('');
    const response = await emitAck<Record<string, never>>('removeBot', { ...roomSession, botPlayerId });
    if (!response.ok) setError(response.error);
  }

  async function restartGame() {
    if (!roomSession) return;
    const response = await emitAck<Record<string, never>>('restartGame', roomSession);
    if (!response.ok) setError(response.error);
  }

  async function setRoomSettings(nextSettings: { showHistory?: boolean; historyLimit?: number; coinRate?: number }) {
    if (!roomSession || !roomState) return;
    const response = await emitAck<Record<string, never>>('setRoomSettings', {
      ...roomSession,
      showHistory: nextSettings.showHistory ?? roomState.settings.showHistory,
      historyLimit: nextSettings.historyLimit ?? roomState.settings.historyLimit,
      coinRate: nextSettings.coinRate ?? roomState.settings.coinRate,
    });
    if (!response.ok) setError(response.error);
  }

  async function play(card: Card) {
    if (!roomSession || !legalCardIds.has(card.id) || !isViewerTurn) return;
    const response = await emitAck<Record<string, never>>('playCard', { ...roomSession, cardId: card.id });
    if (!response.ok) setError(response.error);
  }

  async function clickHandCard(card: Card) {
    if (lastPointerKind === 'touch' && activeRuleCardId !== card.id) {
      setActiveRuleCardId(card.id);
      return;
    }

    setActiveRuleCardId(null);
    await play(card);
  }

  function inspectCard(card: Card) {
    setActiveRuleCardId((current) => (current === card.id ? null : card.id));
  }

  return (
    <main className="appShell" onPointerDown={handlePagePointerDown}>
      <header className="topbar">
        <div className="brandBlock">
          <img className="brandLogo" src="/assets/logo.png" alt="" aria-hidden="true" />
          <div>
            <h1>拱猪</h1>
            <p>
              {roomState ? `房间 ${roomState.roomCode}` : auth ? `账号 ${auth.user.username}` : '线上牌桌'} · v{appVersion}
            </p>
          </div>
        </div>
        <div className="topActions">
          <button className="secondaryButton" onClick={() => setShowRules(true)}>
            规则
          </button>
          {auth ? (
            <button className="secondaryButton" onClick={logout}>
              退出登录
            </button>
          ) : null}
          <div className={connected ? 'status connected' : 'status'}>{connected ? '已连接' : '断线'}</div>
        </div>
      </header>

      {error ? <div className="errorBar">{error}</div> : null}
      {showRules ? <RulesDialog onClose={() => setShowRules(false)} /> : null}

      {!authChecked ? (
        <section className="lobbyLayout">
          <div className="panel">
            <h2>正在检查登录</h2>
          </div>
        </section>
      ) : !auth ? (
        <section className="lobbyLayout">
          <div className="panel authPanel">
            <div className="authTabs">
              <button className={authMode === 'login' ? 'tab active' : 'tab'} onClick={() => setAuthMode('login')}>
                登录
              </button>
              <button
                className={authMode === 'register' ? 'tab active' : 'tab'}
                onClick={() => setAuthMode('register')}
              >
                注册
              </button>
            </div>
            <label>
              用户名
              <input value={username} onChange={(event) => setUsername(event.target.value)} maxLength={20} />
            </label>
            <label>
              密码
              <input
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                type="password"
                maxLength={128}
              />
            </label>
            <button onClick={submitAuth}>{authMode === 'login' ? '登录' : '注册并登录'}</button>
          </div>
        </section>
      ) : !roomSession || !roomState ? (
        <section className="entryGrid">
          <div className="panel">
            <h2>创建房间</h2>
            <label>
              人数
              <select value={playerCount} onChange={(event) => setPlayerCount(Number(event.target.value))}>
                {[3, 4, 5, 6, 7].map((count) => (
                  <option key={count} value={count}>
                    {count} 人
                  </option>
                ))}
              </select>
            </label>
            <button onClick={createRoom}>创建</button>
          </div>

          <div className="panel">
            <h2>加入房间</h2>
            <label>
              房间号
              <input
                value={roomCodeInput}
                onChange={(event) => setRoomCodeInput(event.target.value.toUpperCase())}
                maxLength={6}
              />
            </label>
            <button onClick={joinRoom}>加入</button>
          </div>
        </section>
      ) : roomState.game ? (
        <section className="gameLayout">
          <aside className="scorePanel">
            <h2>座位</h2>
            <div className="seatList">
              {roomState.seats.map((seat) => (
                <div key={seat.playerId} className={seat.playerId === roomState.game?.currentPlayerId ? 'seat active' : 'seat'}>
                  <div>
                    <strong>{seat.name}</strong>
                    <span>{seat.isHost ? '房主' : `座位 ${seat.seat + 1}`}</span>
                  </div>
                  <div className="seatStats">
                    <span>{seat.handCount} 手牌</span>
                    <span>{seat.capturedCount} 收牌</span>
                    <span>{seat.score} 分</span>
                  </div>
                  {seat.scoringCards.length > 0 ? (
                    <div className="seatScoreCards">
                      {seat.scoringCards.map((card) => (
                        <InlineCardLabel
                          key={`${seat.playerId}-${card.id}`}
                          card={card}
                          activeRule={activeRuleCardId === card.id}
                          onInspect={inspectCard}
                        />
                      ))}
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
            <RoomSettingsPanel roomState={roomState} canEdit={isHost} onChange={setRoomSettings} />
          </aside>

          <section className="tableArea">
            <div className="roundLine">
              <span>
                {roomState.game.status === 'finished'
                  ? '本局结束'
                  : `第 ${roomState.game.trickNumber} / ${roomState.game.totalTricks} 墩`}
              </span>
              <span>{currentSeat ? `当前：${currentSeat.name}` : ''}</span>
            </div>

            <div className="tableSurface">
              {roomState.game.currentTrick?.plays.length ? (
                roomState.game.currentTrick.plays.map((play) => {
                  const seat = roomState.seats.find((candidate) => candidate.playerId === play.playerId);
                  return (
                    <div key={`${play.playerId}-${play.card.id}`} className="playedCard">
                      <CardFace
                        card={play.card}
                        activeRule={activeRuleCardId === play.card.id}
                        onInspect={inspectCard}
                      />
                      <span>{seat?.name ?? '玩家'}</span>
                    </div>
                  );
                })
              ) : (
                <div className="emptyTable">{roomState.game.status === 'finished' ? '查看结算' : '等待先手'}</div>
              )}
            </div>

            <HistoryList roomState={roomState} activeRuleCardId={activeRuleCardId} onInspect={inspectCard} />

            {roomState.game.status === 'finished' ? (
              <FinalSummary
                roomState={roomState}
                isHost={isHost}
                activeRuleCardId={activeRuleCardId}
                onInspect={inspectCard}
                onRestart={restartGame}
              />
            ) : null}

            <div className="handArea">
              <div className="handHeader">
                <strong>{viewerSeat?.name ?? '我的手牌'}</strong>
                <span>{isViewerTurn ? '轮到你' : '等待'}</span>
              </div>
              <div className="hand">
                {roomState.hand.map((card) => {
                  const legal = legalCardIds.has(card.id);
                  return (
                    <button
                      key={card.id}
                      className={legal && isViewerTurn ? 'handCard legal' : 'handCard inactive'}
                      aria-disabled={!legal || !isViewerTurn}
                      onPointerDown={(event) => setLastPointerKind(event.pointerType === 'mouse' ? 'mouse' : 'touch')}
                      onClick={() => clickHandCard(card)}
                      aria-label={cardLabel(card)}
                    >
                      <CardFace card={card} compact activeRule={activeRuleCardId === card.id} />
                    </button>
                  );
                })}
              </div>
            </div>
          </section>
        </section>
      ) : (
        <section className="lobbyLayout">
          <div className="panel">
            <h2>房间 {roomState.roomCode}</h2>
            <div className="inviteLine">{`${window.location.origin}/room/${roomState.roomCode}`}</div>
            <div className="seatList">
              {Array.from({ length: roomState.playerCount }).map((_, index) => {
                const seat = roomState.seats[index];
                return (
                  <div key={index} className="seat">
                    <div>
                      <strong>
                        {seat ? (seat.isBot ? `🤖 ${seat.name}` : seat.name) : '空位'}
                      </strong>
                      <span>{seat?.isHost ? '房主' : `座位 ${index + 1}`}</span>
                    </div>
                    <div className="seatStats">
                      <span>{seat ? (seat.isBot ? '人机' : seat.connected ? '在线' : '离线') : ''}</span>
                      <span>{seat ? (seat.ready ? '已准备' : '未准备') : ''}</span>
                    </div>
                    {isHost && seat?.isBot ? (
                      <button className="secondaryButton" onClick={() => removeBot(seat.playerId)}>
                        移除
                      </button>
                    ) : null}
                    {isHost && !seat ? (
                      <div className="botAddRow">
                        <select
                          value={botDifficulty}
                          onChange={(event) => setBotDifficulty(event.target.value as BotDifficulty)}
                        >
                          <option value="foolish">愚蠢</option>
                          <option value="simple">简单</option>
                          <option value="medium">中等</option>
                          <option value="hard">困难</option>
                        </select>
                        <button className="secondaryButton" onClick={() => addBot(botDifficulty)}>
                          添加人机
                        </button>
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
            <div className="lobbyActions">
              <button onClick={() => setReady(!viewerSeat?.ready)}>{viewerSeat?.ready ? '取消准备' : '准备'}</button>
              <button onClick={startGame} disabled={!isHost}>
                开始
              </button>
            </div>
            <RoomSettingsPanel roomState={roomState} canEdit={isHost} onChange={setRoomSettings} />
          </div>
        </section>
      )}
    </main>
  );

  function handlePagePointerDown(event: PointerEvent<HTMLElement>) {
    const target = event.target as HTMLElement;
    const isCardInteraction = Boolean(target.closest('.handCard, .cardFace, .inlineCard'));
    setLastPointerKind(event.pointerType === 'mouse' ? 'mouse' : 'touch');
    if (!isCardInteraction) {
      setActiveRuleCardId(null);
    }
  }
}

function RulesDialog({ onClose }: { onClose: () => void }) {
  return (
    <div className="modalBackdrop" role="dialog" aria-modal="true" aria-labelledby="rules-title" onClick={onClose}>
      <section className="rulesDialog" onClick={(event) => event.stopPropagation()}>
        <div className="rulesHeader">
          <h2 id="rules-title">规则</h2>
          <button className="secondaryButton" onClick={onClose}>
            关闭
          </button>
        </div>

        <div className="rulesContent">
          <section>
            <h3>人数和牌数</h3>
            <pre>{`3人：1副牌，移除红心2，每人 51/3=17 张
4人：1副牌，不移除，每人 52/4=13 张
5人：1副牌，移除红心2、3，每人 50/5=10 张
6人：2副牌，移除两张红心2，每人 102/6=17 张
7人：2副牌，移除两张红心2、3、4，每人 98/7=14 张`}</pre>
          </section>

          <section>
            <h3>出牌规则</h3>
            <pre>{`每墩先手可任意出牌
后手有首出花色必须跟花色
没有首出花色可以任意垫牌
只有首出花色可以赢这一墩
同花色 2 < 3 < ... < 10 < J < Q < K < A
两副牌出现相同牌时，后出的相同牌比先出的小`}</pre>
          </section>

          <section>
            <h3>计分规则</h3>
            <pre>{`黑桃Q：-100
方块J：+100
红心5-10：每张-10
红心J：-20
红心Q：-30
红心K：-40
红心A：-50
梅花10：总分x2
只吃到1张梅花10：+50
两副牌只吃到2张梅花10：+200
全收集1套红心：该套红心的负分全变正分，且可带一张黑桃Q变正分，多余的红心和黑桃Q仍为负分（两副牌情况下）
全收集2套红心：所有负分全变正分，且额外翻2倍
1副牌下全收所有红心、黑桃Q、方块J、梅花10：(-(-60-20-30-40-50-100)+100)x2=+800
2副牌下全收所有红心、两张黑桃Q、两张方块J、两张梅花10：(-(-60-20-30-40-50-100)+100)x2x4x2=+6400
1副牌下分摊每人平均而言-100分左右，2副牌下分摊每人平均而言-200分左右`}</pre>
          </section>

          <section>
            <h3>金币规则</h3>
            <pre>{`房主可设置分数兑换金币的比率alpha
当某玩家分数为负a分时，该玩家负a*alpha金币
当某玩家分数为正a分时，均匀让其他n-1名玩家额外负a/(n-1)*alpha金币，该玩家则0金币`}</pre>
          </section>
        </div>
      </section>
    </div>
  );
}

function RoomSettingsPanel({
  roomState,
  canEdit,
  onChange,
}: {
  roomState: PublicRoomState;
  canEdit: boolean;
  onChange: (settings: { showHistory?: boolean; historyLimit?: number; coinRate?: number }) => void;
}) {
  return (
    <div className="settingsPanel">
      <h3>房间设置</h3>
      <label className="checkRow">
        <input
          type="checkbox"
          checked={roomState.settings.showHistory}
          disabled={!canEdit}
          onChange={(event) => onChange({ showHistory: event.target.checked })}
        />
        显示出牌历史
      </label>
      <label>
        最近几墩
        <input
          type="number"
          min={1}
          max={50}
          value={roomState.settings.historyLimit}
          disabled={!canEdit || !roomState.settings.showHistory}
          onChange={(event) => onChange({ historyLimit: Number(event.target.value) })}
        />
      </label>
      <label>
        金币比率 alpha
        <input
          type="number"
          min={0}
          max={1000}
          step={0.01}
          value={roomState.settings.coinRate}
          disabled={!canEdit}
          onChange={(event) => onChange({ coinRate: Number(event.target.value) })}
        />
      </label>
    </div>
  );
}

function HistoryList({
  roomState,
  activeRuleCardId,
  onInspect,
}: {
  roomState: PublicRoomState;
  activeRuleCardId: string | null;
  onInspect: (card: Card) => void;
}) {
  if (!roomState.game) return null;

  if (!roomState.settings.showHistory) {
    return <div className="historyEmpty">出牌历史已隐藏</div>;
  }

  if (roomState.game.completedTricks.length === 0) {
    return <div className="historyEmpty">暂无出牌历史</div>;
  }

  return (
    <div className="historyStrip">
      {roomState.game.completedTricks.map((trick) => {
        const winner = roomState.seats.find((seat) => seat.playerId === trick.winnerId);
        return (
          <div key={trick.index} className="historyItem">
            <strong>第 {trick.index + 1} 墩</strong>
            <span>{winner?.name ?? '玩家'} 收</span>
            <span className="inlineCards">
              {trick.plays.map((trickPlay) => (
                <InlineCardLabel
                  key={`${trick.index}-${trickPlay.playerId}-${trickPlay.card.id}`}
                  card={trickPlay.card}
                  activeRule={activeRuleCardId === trickPlay.card.id}
                  onInspect={onInspect}
                />
              ))}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function FinalSummary({
  roomState,
  isHost,
  activeRuleCardId,
  onInspect,
  onRestart,
}: {
  roomState: PublicRoomState;
  isHost: boolean;
  activeRuleCardId: string | null;
  onInspect: (card: Card) => void;
  onRestart: () => void;
}) {
  return (
    <section className="finalSummary">
      <div className="summaryHeader">
        <h2>结算</h2>
        {isHost ? <button onClick={onRestart}>重新开始</button> : null}
      </div>
      <div className="summaryGrid">
        {roomState.seats.map((seat) => (
          <div key={seat.playerId} className="summaryItem">
            <div className="summaryTitle">
              <strong>{seat.name}</strong>
              <span>{seat.score} 分 / {formatCoins(seat.coins)} 金币</span>
            </div>
            <div className="scoringCards">
              {seat.scoringCards.length > 0 ? (
                seat.scoringCards.map((card) => (
                  <InlineCardLabel
                    key={card.id}
                    card={card}
                    activeRule={activeRuleCardId === card.id}
                    onInspect={onInspect}
                  />
                ))
              ) : (
                <span className="mutedText">无分牌</span>
              )}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function InlineCardLabel({
  card,
  activeRule = false,
  onInspect,
}: {
  card: Card;
  activeRule?: boolean;
  onInspect?: (card: Card) => void;
}) {
  return (
    <span
      className={`${isRedSuit(card.suit) ? 'inlineCard red' : 'inlineCard'}${activeRule ? ' showRule' : ''}`}
      tabIndex={0}
      onClick={() => onInspect?.(card)}
    >
      {cardLabel(card)}
      <CardRuleTooltip card={card} />
    </span>
  );
}

function formatCoins(value: number): string {
  const rounded = Math.round(value * 100) / 100;
  if (Object.is(rounded, -0)) return '0';
  return Number.isInteger(rounded) ? `${rounded}` : rounded.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
}

function CardFace({
  card,
  compact = false,
  activeRule = false,
  onInspect,
}: {
  card: Card;
  compact?: boolean;
  activeRule?: boolean;
  onInspect?: (card: Card) => void;
}) {
  return (
    <span
      className={`${isRedSuit(card.suit) ? 'cardFace red' : 'cardFace'}${activeRule ? ' showRule' : ''}`}
      tabIndex={onInspect ? 0 : undefined}
      onClick={(event) => {
        if (!onInspect) return;
        event.stopPropagation();
        onInspect(card);
      }}
    >
      <span className="rank">{rankLabel(card.rank)}</span>
      <span className="suit">{suitLabel(card.suit)}</span>
      {!compact && card.deckIndex > 0 ? <span className="copyMark">{card.deckIndex + 1}</span> : null}
      <CardRuleTooltip card={card} />
    </span>
  );
}

function CardRuleTooltip({ card }: { card: Card }) {
  const rule = getCardRule(card);
  return (
    <span className="cardTooltip" role="tooltip">
      <strong>{rule.title}</strong>
      <span>{rule.detail}</span>
    </span>
  );
}

function getCardRule(card: Card): { title: string; detail: string } {
  const label = cardLabel(card);

  if (card.suit === 'spade' && card.rank === 12) {
    return {
      title: `${label} 猪`,
      detail: '分值 -100；满红时可转为 +100。',
    };
  }

  if (card.suit === 'diamond' && card.rank === 11) {
    return {
      title: `${label} 羊`,
      detail: '分值 +100。',
    };
  }

  if (card.suit === 'club' && card.rank === 10) {
    return {
      title: `${label} 变压器`,
      detail: '功能：总分 x2；只吃梅花10为 +50，两张为 +200。',
    };
  }

  if (card.suit === 'heart') {
    const point = heartPoint(card.rank);
    return {
      title: `${label} 红心`,
      detail:
        point === 0
          ? '0 分；计入满红，全收本局红心可让负分变正。'
          : `分值 ${point}；满红时红心负分变正。`,
    };
  }

  return {
    title: label,
    detail: '无分牌；用于跟牌和争墩。',
  };
}

function heartPoint(rank: Card['rank']): number {
  if (rank >= 5 && rank <= 10) return -10;
  if (rank === 11) return -20;
  if (rank === 12) return -30;
  if (rank === 13) return -40;
  if (rank === 14) return -50;
  return 0;
}

function getRoomCodeFromPath(): string {
  const match = window.location.pathname.match(/\/room\/([A-Za-z0-9]+)/);
  return match?.[1]?.toUpperCase() ?? '';
}

function authSessionKey(): string {
  return 'sable-hearts-auth-session';
}

function roomSessionKey(roomCode: string): string {
  return `sable-hearts-room-session-${roomCode}`;
}

function saveAuthSession(session: AuthSession): void {
  window.localStorage.setItem(authSessionKey(), JSON.stringify(session));
}

function loadAuthSession(): AuthSession | null {
  const raw = window.localStorage.getItem(authSessionKey());
  if (!raw) return null;
  try {
    return JSON.parse(raw) as AuthSession;
  } catch {
    return null;
  }
}

function clearAuthSession(): void {
  window.localStorage.removeItem(authSessionKey());
}

function saveRoomSession(session: RoomSession): void {
  window.localStorage.setItem(roomSessionKey(session.roomCode), JSON.stringify(session));
}

function loadRoomSession(roomCode: string): RoomSession | null {
  const raw = window.localStorage.getItem(roomSessionKey(roomCode));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as RoomSession;
  } catch {
    return null;
  }
}

function clearRoomSession(roomCode: string): void {
  window.localStorage.removeItem(roomSessionKey(roomCode));
}

function emitAck<T>(event: string, payload: unknown): Promise<Ack<T>> {
  return new Promise((resolve) => {
    socket.emit(event, payload, (response: Ack<T>) => resolve(response));
  });
}
