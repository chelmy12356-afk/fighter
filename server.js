const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { WebSocketServer, WebSocket } = require('ws');
const { GameSimulation, GS } = require('./game-simulation');

const GAME_FILE = path.join(__dirname, 'stickman_clash.html');
const ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const ROOM_LENGTH = 6;

function send(ws, message) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
}

function createGameServer(options = {}) {
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? 30000;
  const rooms = new Map();
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (req.method === 'GET' && pathname === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end('{"status":"ok"}');
      return;
    }
    if (req.method === 'GET' && pathname === '/power-system.js') {
      res.writeHead(200, {
        'Content-Type': 'text/javascript; charset=utf-8',
        'Cache-Control': 'no-cache'
      });
      fs.createReadStream(path.join(__dirname, 'power-system.js')).pipe(res);
      return;
    }
    if (req.method !== 'GET' || (pathname !== '/' && pathname !== '/stickman_clash.html')) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-cache'
    });
    fs.createReadStream(GAME_FILE).pipe(res);
  });
  const wss = new WebSocketServer({ server, maxPayload: 1024, perMessageDeflate: false });
  const heartbeat = setInterval(() => {
    wss.clients.forEach(ws => {
      if (ws.readyState !== WebSocket.OPEN) return;
      if (ws.isAlive === false) {
        ws.terminate();
        return;
      }
      ws.isAlive = false;
      ws.ping();
    });
  }, heartbeatIntervalMs);

  function createRoomCode() {
    let code;
    do {
      code = Array.from({ length: ROOM_LENGTH }, () =>
        ROOM_ALPHABET[crypto.randomInt(ROOM_ALPHABET.length)]
      ).join('');
    } while (rooms.has(code));
    return code;
  }

  wss.on('connection', ws => {
    ws.roomCode = null;
    ws.role = null;
    ws.isAlive = true;

    ws.on('pong', () => {
      ws.isAlive = true;
    });

    ws.on('message', raw => {
      let message;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        send(ws, { type: 'error', message: 'Message must be valid JSON.' });
        return;
      }
      if (!message || typeof message !== 'object' || Array.isArray(message)) {
        send(ws, { type: 'error', message: 'Message must be a JSON object.' });
        return;
      }

      if (message.type === 'create') {
        if (ws.roomCode) {
          send(ws, { type: 'error', message: 'This connection already has a room.' });
          return;
        }
        const code = createRoomCode();
        rooms.set(code, {
          host: ws, guest: null, powerMode: message.powerMode === true,
          simulation: null, tickTimer: null, snapshotCounter: 0
        });
        ws.roomCode = code;
        ws.role = 'host';
        send(ws, { type: 'room', room: code, powerMode: message.powerMode === true });
        return;
      }

      if (message.type === 'join') {
        const code = typeof message.room === 'string' ? message.room.toUpperCase() : '';
        if (ws.roomCode || !new RegExp(`^[${ROOM_ALPHABET}]{${ROOM_LENGTH}}$`).test(code)) {
          send(ws, { type: 'error', message: 'Enter a valid room code.' });
          return;
        }
        const room = rooms.get(code);
        if (!room || room.guest) {
          send(ws, { type: 'error', message: 'Room unavailable. Check the code and try again.' });
          return;
        }
        room.guest = ws;
        ws.roomCode = code;
        ws.role = 'guest';
        room.simulation = new GameSimulation(room.powerMode);
        send(room.host, { type: 'join', powerMode: room.powerMode });
        send(ws, { type: 'joined', room: code, powerMode: room.powerMode });
        const publish = () => {
          const snapshot = room.simulation.snapshot();
          send(room.host, snapshot);
          send(room.guest, snapshot);
        };
        publish();
        room.tickTimer = setInterval(() => {
          if (!room.simulation) return;
          room.simulation.step(1 / 60);
          room.snapshotCounter++;
          if (room.snapshotCounter % 3 === 0) publish();
        }, 1000 / 60);
        return;
      }

      const room = ws.roomCode && rooms.get(ws.roomCode);
      if (!room) {
        send(ws, { type: 'error', message: 'Create or join a room first.' });
        return;
      }
      if (message.type === 'input' && (ws.role === 'host' || ws.role === 'guest')) {
        if (!Number.isInteger(message.bits) || message.bits < 0 || message.bits > 255) {
          send(ws, { type: 'error', message: 'Input must be an 8-bit control mask.' });
          return;
        }
        const now = Date.now();
        if (!ws.inputWindowStart || now - ws.inputWindowStart >= 1000) {
          ws.inputWindowStart = now;
          ws.inputCount = 0;
        }
        ws.inputCount++;
        if (ws.inputCount > 90) {
          send(ws, { type: 'error', message: 'Input rate is too high.' });
          return;
        }
        if (!room.simulation) return;
        room.simulation.setInput(ws.role === 'host' ? 1 : 2, message.bits);
        return;
      }
      if (message.type === 'rematch' && (ws.role === 'host' || ws.role === 'guest')) {
        if (room.simulation && room.simulation.state === GS.MATCH_END) {
          room.simulation.restart();
          const snapshot = room.simulation.snapshot();
          send(room.host, snapshot);
          send(room.guest, snapshot);
        }
        return;
      }
      send(ws, { type: 'error', message: 'Message is not allowed for this player.' });
    });

    ws.on('close', () => {
      if (!ws.roomCode) return;
      const room = rooms.get(ws.roomCode);
      if (!room) return;
      const other = ws.role === 'host' ? room.guest : room.host;
      send(other, { type: 'left' });
      if (room.tickTimer) clearInterval(room.tickTimer);
      room.simulation = null;
      rooms.delete(ws.roomCode);
    });

    ws.on('error', error => {
      console.warn('WebSocket client error:', error.message);
    });
  });

  wss.on('error', error => {
    console.error('WebSocket server error:', error);
  });

  wss.on('close', () => {
    clearInterval(heartbeat);
  });

  return { server, wss };
}

if (require.main === module) {
  const { server } = createGameServer();
  const port = Number(process.env.PORT) || 8080;
  server.listen(port, '0.0.0.0', () => {
    console.log(`Stickman Clash listening on port ${port}`);
  });
  server.on('error', error => {
    console.error('HTTP server error:', error);
    process.exitCode = 1;
  });
}

module.exports = { createGameServer };
