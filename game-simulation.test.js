const assert = require('node:assert/strict');
const test = require('node:test');
const PowerSystem = require('./power-system');
const { GameSimulation, GS } = require('./game-simulation');

test('server assigns unique round powers and serializes authoritative snapshots', () => {
  const game = new GameSimulation(true);
  const snapshot = game.snapshot();
  assert.equal(snapshot.state, GS.INTRO);
  assert.notEqual(snapshot.fighters[0].power, snapshot.fighters[1].power);
  assert.ok(snapshot.fighters.every(fighter => fighter.health === 100));

  for (let index = 0; index < 30; index++) game.step(0.05);
  assert.equal(game.state, GS.FIGHT);
  assert.ok(game.fighters.every(fighter => fighter.canControl));
});

test('server simulates player movement and punch damage from inputs', () => {
  const game = new GameSimulation(false);
  game.state = GS.FIGHT;
  for (const fighter of game.fighters) fighter.canControl = true;
  game.setInput(1, 2);
  game.step(0.05);
  assert.ok(game.fighters[0].x > 420);

  game.setInput(1, 0);
  game.setInput(2, 0);
  game.fighters[0].x = 700;
  game.fighters[1].x = 755;
  game.fighters[0].facing = 1;
  game.fighters[1].facing = -1;
  game.setInput(1, 16);
  for (let index = 0; index < 20; index++) game.step(1 / 60);
  assert.equal(game.fighters[1].health, 92);
});

test('server simulates powers and ignores client-supplied damage or cooldown state', () => {
  const game = new GameSimulation(true);
  game.state = GS.FIGHT;
  const [attacker, target] = game.fighters;
  attacker.canControl = target.canControl = true;
  attacker.x = 450;
  target.x = 520;
  attacker.power = 'PROJECTILE';
  target.power = 'FREEZE';
  game.setInput(1, 128);
  for (let index = 0; index < 20; index++) game.step(1 / 60);

  assert.equal(target.health, 86);
  assert.ok(attacker.powerCooldown < 6 && attacker.powerCooldown > 5.5);
  assert.equal(game.snapshot().fighters[1].health, 86);
  assert.equal(game.snapshot().powerEntities.projectiles.length, 0);
});

test('server-authoritative match snapshots include new Shockwave entities and resolve their hit', () => {
  const game = new GameSimulation(true);
  game.state = GS.FIGHT;
  const [attacker, target] = game.fighters;
  attacker.canControl = target.canControl = true;
  attacker.x = 450;
  target.x = 520;
  attacker.power = 'SHOCKWAVE';
  target.power = 'SWAP';
  game.setInput(1, 128);

  game.step(1 / 60);
  assert.equal(game.snapshot().powerEntities.shockwaves.length, 1);
  assert.doesNotThrow(() => JSON.stringify(game.snapshot()));
  for (let index = 0; index < 24; index++) game.step(1 / 60);
  assert.equal(target.health, 100 - PowerSystem.CONFIG.SHOCKWAVE.damage);
  assert.ok(target.x > 520);
  assert.ok(game.snapshot().powerEntities.shockwaves.length > 0);
});

test('server resets powers, cooldowns, scores and entities for a rematch', () => {
  const game = new GameSimulation(true);
  game.state = GS.MATCH_END;
  game.roundWins = [2, 0];
  game.projectiles.push({ ownerId: 1 });
  game.traps.push({ ownerId: 2 });
  game.shockwaves.push({ ownerId: 1 });
  game.fighters[0].powerCooldown = 8;

  game.restart();

  assert.equal(game.state, GS.INTRO);
  assert.deepEqual(game.roundWins, [0, 0]);
  assert.equal(game.H.p1w, 0);
  assert.equal(game.H.p2w, 0);
  assert.equal(game.fighters[0].powerCooldown, 0);
  assert.equal(game.projectiles.length, 0);
  assert.equal(game.traps.length, 0);
  assert.equal(game.shockwaves.length, 0);
  assert.notEqual(game.fighters[0].power, game.fighters[1].power);
});
