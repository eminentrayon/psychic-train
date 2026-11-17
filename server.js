/**
 * RuneDeck — game server.
 *
 * Static hosting, lobby configuration, real-time 1v1 matchmaking with an
 * automatic AI-bot fallback, and one authoritative simulation (game.js) per match.
 *
 * Socket protocol
 *   client -> server   queue:join { nickname }   queue:cancel   queue:spawnBot   match:leave
 *                      game:playCard { slot, x, z }   game:cast { key, x, z }   game:useItem { key, x, z }
 *                      game:move { x, z }   game:attack { id }
 *   server -> client   lobby:stats   lobby:error   queue:joined
 *                      match:found   match:start { side, players, state }   match:ended
 *                      game:state   game:events   game:over
 */

import http from 'node:http';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import express from 'express';
import { Server } from 'socket.io';

import { createGame } from './game.js';
import { DECK, HERO, SIDES } from './public/shared.js';

/* -------------------------------------------------------------------------- */
/* Configuration                                                              */
/* -------------------------------------------------------------------------- */

const ROOT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
const THREE_DIR = path.join(ROOT_DIR, 'node_modules', 'three', 'build');
const PORT = envInt('PORT', 3000);
const QUEUE_TIMEOUT_MS = envInt('QUEUE_TIMEOUT_MS', 60_000);
const MATCH_COUNTDOWN_MS = envInt('MATCH_COUNTDOWN_MS', 5_000);
const NICKNAME_MAX_LENGTH = 16;

const BOT_NAMES = [
  'Vexis the Hollow',
  'Morgath',
  'Ashen Oracle',
  'Kael the Unbound',
  'Obsidian Warden',
  'Sable Tactician',
  'Emberfang',
];

/* -------------------------------------------------------------------------- */
/* HTTP                                                                       */
/* -------------------------------------------------------------------------- */

const app = express();
app.disable('x-powered-by');

app.get('/healthz', (_req, res) => {
  res.json({ ok: true, uptime: Math.round(process.uptime()) });
});

app.get('/api/config', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ hero: HERO, deck: DECK, queueTimeoutMs: QUEUE_TIMEOUT_MS });
});

// The browser imports Three.js as an ES module through the import map in index.html.
app.use('/vendor/three', express.static(THREE_DIR, { maxAge: '7d' }));
app.use(express.static(PUBLIC_DIR, { extensions: ['html'] }));

const server = http.createServer(app);
const io = new Server(server);

/* -------------------------------------------------------------------------- */
/* Matchmaking state                                                          */
/* -------------------------------------------------------------------------- */

/** @type {Map<string, Player>} socket id -> connected player */
const players = new Map();
/** Players waiting for an opponent, oldest first. */
const queue = [];
/** @type {Map<string, Match>} match id -> active match */
const matches = new Map();

/**
 * @typedef {{ id: string, nickname: string, isBot: boolean, socket: import('socket.io').Socket | null,
 *   state: 'idle' | 'queued' | 'matched', queueTimer: NodeJS.Timeout | null, match: Match | null,
 *   side: 'radiant' | 'dire' | null }} Player
 * @typedef {{ id: string, room: string, state: 'countdown' | 'live', reason: 'pvp' | 'timeout' | 'dev',
 *   sides: { radiant: Player, dire: Player }, startTimer: NodeJS.Timeout | null,
 *   game: ReturnType<typeof createGame> | null }} Match
 */

io.on('connection', (socket) => {
  /** @type {Player} */
  const player = {
    id: socket.id,
    nickname: '',
    isBot: false,
    socket,
    state: 'idle',
    queueTimer: null,
    match: null,
    side: null,
  };
  players.set(socket.id, player);
  broadcastStats();

  socket.on('queue:join', (payload) => joinQueue(player, payload));
  socket.on('queue:cancel', () => leaveQueue(player));
  socket.on('queue:spawnBot', () => {
    if (player.state === 'queued') startBotMatch(player, 'dev');
  });
  socket.on('match:leave', () => leaveMatch(player, 'opponent_left'));

  // The simulation validates every intent; these only route them to the right match.
  socket.on('game:playCard', (payload) => {
    player.match?.game?.playCard(player.side, payload?.slot, payload?.x, payload?.z);
  });
  socket.on('game:cast', (payload) => player.match?.game?.cast(player.side, payload?.key, payload?.x, payload?.z));
  socket.on('game:useItem', (payload) => player.match?.game?.useItem(player.side, payload?.key, payload?.x, payload?.z));
  socket.on('game:move', (payload) => player.match?.game?.heroMove(player.side, payload?.x, payload?.z));
  socket.on('game:attack', (payload) => player.match?.game?.heroAttack(player.side, payload?.id));

  socket.on('disconnect', () => {
    leaveQueue(player);
    leaveMatch(player, 'opponent_disconnected');
    players.delete(socket.id);
    broadcastStats();
  });
});

function joinQueue(player, payload) {
  if (player.state !== 'idle') {
    player.socket.emit('lobby:error', { message: 'You are already in a queue or match.' });
    return;
  }
  player.nickname = sanitizeNickname(payload?.nickname);
  player.socket.emit('queue:joined', { nickname: player.nickname, timeoutMs: QUEUE_TIMEOUT_MS, elapsedMs: 0 });

  // Anyone already waiting becomes Player 1 (Radiant); the newcomer is Player 2 (Dire).
  const opponent = queue.shift();
  if (opponent) {
    clearTimeout(opponent.queueTimer);
    opponent.queueTimer = null;
    createMatch(opponent, player, 'pvp');
    return;
  }

  player.state = 'queued';
  player.queueTimer = setTimeout(() => startBotMatch(player, 'timeout'), QUEUE_TIMEOUT_MS);
  queue.push(player);
  log('queue', `${player.nickname} is searching (${queue.length} waiting)`);
  broadcastStats();
}

function leaveQueue(player) {
  if (player.state !== 'queued') return;
  removeFromQueue(player);
  player.state = 'idle';
  log('queue', `${player.nickname} left the queue`);
  broadcastStats();
}

function removeFromQueue(player) {
  clearTimeout(player.queueTimer);
  player.queueTimer = null;
  const index = queue.indexOf(player);
  if (index !== -1) queue.splice(index, 1);
}

function startBotMatch(player, reason) {
  if (player.state !== 'queued') return;
  removeFromQueue(player);
  createMatch(player, createBot(), reason);
}

/** Server-side AI opponent. The simulation drives it; it has no socket. */
function createBot() {
  return {
    id: `bot_${shortId()}`,
    nickname: BOT_NAMES[Math.floor(Math.random() * BOT_NAMES.length)],
    isBot: true,
    socket: null,
    state: 'matched',
    queueTimer: null,
    match: null,
    side: null,
  };
}

function rosterOf(match) {
  const { radiant, dire } = match.sides;
  return {
    radiant: { nickname: radiant.nickname, isBot: radiant.isBot },
    dire: { nickname: dire.nickname, isBot: dire.isBot },
  };
}

function createMatch(radiant, dire, reason) {
  const id = shortId();
  /** @type {Match} */
  const match = {
    id,
    room: `match:${id}`,
    state: 'countdown',
    reason,
    sides: { radiant, dire },
    startTimer: null,
    game: null,
  };
  matches.set(id, match);

  for (const side of SIDES) {
    const participant = match.sides[side];
    participant.state = 'matched';
    participant.match = match;
    participant.side = side;
    if (participant.isBot) continue;
    participant.socket.join(match.room);
    participant.socket.emit('match:found', {
      matchId: id,
      reason,
      side,
      vsBot: radiant.isBot || dire.isBot,
      countdownMs: MATCH_COUNTDOWN_MS,
      players: rosterOf(match),
    });
  }

  match.startTimer = setTimeout(() => startGame(match), MATCH_COUNTDOWN_MS);

  log('match', `${id} created (${reason}): ${radiant.nickname} [Radiant] vs ${dire.nickname} [Dire]`);
  broadcastStats();
}

function startGame(match) {
  match.startTimer = null;
  match.state = 'live';
  match.game = createGame({
    players: rosterOf(match),
    emit(side, event, payload) {
      const participant = match.sides[side];
      if (!participant.isBot) participant.socket.emit(event, payload);
    },
    // A finished game releases its players; the result screen is client-side.
    onOver() {
      log('match', `${match.id} finished`);
      closeMatch(match);
    },
  });

  for (const side of SIDES) {
    const participant = match.sides[side];
    if (participant.isBot) continue;
    participant.socket.emit('match:start', {
      matchId: match.id,
      side,
      players: rosterOf(match),
      state: match.game.snapshot(side),
    });
  }
  log('match', `${match.id} is live`);
}

/** Stops the match and frees its players. `leaver` leaving tells the other human why. */
function closeMatch(match, leaver = null, reasonForOpponent = null) {
  if (!matches.delete(match.id)) return;
  clearTimeout(match.startTimer);
  match.game?.stop();

  for (const side of SIDES) {
    const participant = match.sides[side];
    participant.match = null;
    participant.side = null;
    if (participant.isBot) continue;
    participant.state = 'idle';
    participant.socket.leave(match.room);
    if (leaver && participant !== leaver) {
      participant.socket.emit('match:ended', { matchId: match.id, reason: reasonForOpponent });
    }
  }
  broadcastStats();
}

function leaveMatch(player, reasonForOpponent) {
  const match = player.match;
  if (!match) return;
  log('match', `${match.id} ended (${player.nickname}: ${reasonForOpponent})`);
  closeMatch(match, player, reasonForOpponent);
}

function broadcastStats() {
  io.emit('lobby:stats', { online: players.size, searching: queue.length, matches: matches.size });
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function sanitizeNickname(raw) {
  const cleaned = (typeof raw === 'string' ? raw : '')
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N} _\-.']/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
  const clipped = [...cleaned].slice(0, NICKNAME_MAX_LENGTH).join('').trim();
  return clipped || `Knight-${1000 + Math.floor(Math.random() * 9000)}`;
}

function shortId() {
  return randomBytes(4).toString('hex');
}

function envInt(name, fallback) {
  const value = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function log(scope, message) {
  console.log(`${new Date().toISOString()} [${scope}] ${message}`);
}

/* -------------------------------------------------------------------------- */
/* Lifecycle                                                                  */
/* -------------------------------------------------------------------------- */

server.listen(PORT, () => {
  log('server', `RuneDeck listening on http://localhost:${PORT} (bot fallback after ${QUEUE_TIMEOUT_MS / 1000}s)`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    log('server', `${signal} received, shutting down`);
    io.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2_000).unref();
  });
}
