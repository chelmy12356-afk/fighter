const assert = require('node:assert/strict');
const { once } = require('node:events');
const test = require('node:test');
const WebSocket = require('ws');
const { createGameServer } = require('./server');

async function openServer(options = {}) {
  const { server, wss } = createGameServer(options);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  return {
    server,
    wss,
    baseUrl: `http://127.0.0.1:${port}`,
    wsUrl: `ws://127.0.0.1:${port}`
  };
}

async function closeServer(server, wss, clients = []) {
  const openClients = clients.filter(client => client.readyState !== WebSocket.CLOSED);
  openClients.forEach(client => client.close());
  await Promise.all(openClients.map(client => once(client, 'close')));
  await new Promise(resolve => wss.close(resolve));
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

function nextMessage(ws) {
  return new Promise((resolve, reject) => {
    ws.once('message', raw => resolve(JSON.parse(raw.toString())));
    ws.once('error', reject);
  });
}

function nextMessageOfType(ws, type) {
  return new Promise((resolve, reject) => {
    const onMessage = raw => {
      const message = JSON.parse(raw.toString());
      if (message.type !== type) return;
      ws.off('message', onMessage);
      resolve(message);
    };
    ws.on('message', onMessage);
    ws.once('error', reject);
  });
}

test('serves the game and Render health check', async t => {
  const app = await openServer();
  t.after(() => closeServer(app.server, app.wss));

  const page = await fetch(app.baseUrl);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /ONLINE MATCH/);

  const health = await fetch(`${app.baseUrl}/healthz`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: 'ok' });

  const powers = await fetch(`${app.baseUrl}/power-system.js`);
  assert.equal(powers.status, 200);
  assert.match(await powers.text(), /TIME SLOW/);
});

test('keeps websocket connections alive with ping/pong heartbeats', async t => {
  const { server, wss } = createGameServer({ heartbeatIntervalMs: 1000 });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  const client = new WebSocket(`ws://127.0.0.1:${port}`);
  t.after(() => closeServer(server, wss, [client]));
  await once(client, 'open');

  await Promise.race([
    once(client, 'ping'),
    new Promise((_, reject) => setTimeout(() => reject(new Error('No heartbeat ping received')), 2000))
  ]);
});

test('pairs players and broadcasts only server-simulated snapshots', async t => {
  const app = await openServer();
  const clients = [new WebSocket(app.wsUrl), new WebSocket(app.wsUrl)];
  t.after(() => closeServer(app.server, app.wss, clients));
  await Promise.all(clients.map(client => once(client, 'open')));
  const [host, guest] = clients;

  const hostRoom = nextMessage(host);
  host.send(JSON.stringify({ type: 'create', powerMode: true }));
  const { type: roomType, room, token: hostToken } = await hostRoom;
  assert.equal(roomType, 'room');
  assert.match(room, /^[A-HJ-NP-Z2-9]{6}$/);
  assert.match(hostToken, /^[A-Za-z0-9_-]{32}$/);

  const hostJoined = nextMessage(host);
  const guestJoined = nextMessage(guest);
  guest.send(JSON.stringify({ type: 'join', room }));
  assert.deepEqual(await hostJoined, { type: 'join', powerMode: true });
  const joinedMessage = await guestJoined;
  assert.equal(joinedMessage.type, 'joined');
  assert.equal(joinedMessage.room, room);
  assert.equal(joinedMessage.powerMode, true);
  assert.match(joinedMessage.token, /^[A-Za-z0-9_-]{32}$/);

  const hostSnapshotPromise = nextMessageOfType(host, 'state');
  const guestSnapshotPromise = nextMessageOfType(guest, 'state');
  const [hostSnapshot, guestSnapshot] = await Promise.all([hostSnapshotPromise, guestSnapshotPromise]);
  for (const snapshot of [hostSnapshot, guestSnapshot]) {
    assert.equal(snapshot.type, 'state');
    assert.equal(snapshot.powerMode, true);
    assert.notEqual(snapshot.fighters[0].power, snapshot.fighters[1].power);
    assert.deepEqual(snapshot.fighters.map(fighter => fighter.health), [100, 100]);
  }

  const rejectedState = nextMessageOfType(guest, 'error');
  guest.send(JSON.stringify({ type: 'state', state: { damage: 100 } }));
  assert.deepEqual(await rejectedState, { type: 'error', message: 'Message is not allowed for this player.' });

  const rejectedHostState = nextMessageOfType(host, 'error');
  host.send(JSON.stringify({ type: 'state', state: { health: 0, powerCooldown: 0 } }));
  assert.deepEqual(await rejectedHostState, { type: 'error', message: 'Message is not allowed for this player.' });

  const invalidInput = nextMessageOfType(guest, 'error');
  guest.send(JSON.stringify({ type: 'input', bits: 999 }));
  assert.deepEqual(await invalidInput, { type: 'error', message: 'Input must be an 8-bit control mask.' });

  const hostNextSnapshot = nextMessageOfType(host, 'state');
  const guestNextSnapshot = nextMessageOfType(guest, 'state');
  host.send(JSON.stringify({ type: 'input', bits: 2, health: 0, powerCooldown: 0 }));
  guest.send(JSON.stringify({ type: 'input', bits: 16, damage: 100, power: 'FREEZE' }));
  for (const snapshot of await Promise.all([hostNextSnapshot, guestNextSnapshot])) {
    assert.equal(snapshot.type, 'state');
    assert.equal(snapshot.fighters.length, 2);
    assert.deepEqual(snapshot.fighters.map(fighter => fighter.health), [100, 100]);
  }
});

test('restores a player after a temporary WebSocket disconnect', async t => {
  const app = await openServer({ reconnectGraceMs: 2000 });
  const host = new WebSocket(app.wsUrl);
  const guest = new WebSocket(app.wsUrl);
  const clients = [host, guest];
  t.after(() => closeServer(app.server, app.wss, clients));
  await Promise.all(clients.map(client => once(client, 'open')));

  const hostRoomPromise = nextMessage(host);
  host.send(JSON.stringify({ type: 'create', powerMode: false }));
  const hostRoom = await hostRoomPromise;
  const hostToken = hostRoom.token;

  const hostJoinedPromise = nextMessage(host);
  const guestJoinedPromise = nextMessage(guest);
  guest.send(JSON.stringify({ type: 'join', room: hostRoom.room }));
  await hostJoinedPromise;
  const guestJoined = await guestJoinedPromise;
  assert.match(guestJoined.token, /^[A-Za-z0-9_-]{32}$/);
  const opponentDisconnected = nextMessageOfType(guest, 'opponent-disconnected');

  host.terminate();
  await once(host, 'close');
  await opponentDisconnected;

  const reconnectingHost = new WebSocket(app.wsUrl);
  clients.push(reconnectingHost);
  await once(reconnectingHost, 'open');
  const resumedPromise = nextMessage(reconnectingHost);
  const snapshotPromise = nextMessageOfType(reconnectingHost, 'state');
  const opponentReconnected = nextMessageOfType(guest, 'opponent-reconnected');
  reconnectingHost.send(JSON.stringify({
    type: 'resume', room: hostRoom.room, token: hostToken
  }));

  const resumed = await resumedPromise;
  assert.deepEqual(resumed, {
    type: 'resumed', room: hostRoom.room, role: 'host',
    powerMode: false, inMatch: true
  });
  assert.equal((await snapshotPromise).type, 'state');
  await opponentReconnected;
});

test('rejects a malformed room code without closing the connection', async t => {
  const app = await openServer();
  const client = new WebSocket(app.wsUrl);
  t.after(() => closeServer(app.server, app.wss, [client]));
  await once(client, 'open');

  const response = nextMessage(client);
  client.send(JSON.stringify({ type: 'join', room: '../bad' }));
  assert.deepEqual(await response, { type: 'error', message: 'Enter a valid room code.' });
  assert.equal(client.readyState, WebSocket.OPEN);
});
