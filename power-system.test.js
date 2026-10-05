const assert = require('node:assert/strict');
const test = require('node:test');
const Powers = require('./power-system');

function fighter(id, x, power) {
  return {
    id, x, y: 612, facing: id === 1 ? 1 : -1, state: 0,
    health: 100, grounded: true, canControl: true, power, powerCooldown: 0, invisibleT: 0,
    applyHit(damage, knockback, launch, stun, direction) {
      this.health = Math.max(0, this.health - damage);
      this.lastHit = { damage, knockback, launch, stun, direction };
      return false;
    }
  };
}

function world(players = [fighter(1, 400, 'TELEPORT'), fighter(2, 800, 'FREEZE')]) {
  return {
    powerMode: true, left: 70, right: 1210, groundY: 612,
    fighters: players, projectiles: [], clones: [], traps: [], statues: [], shockwaves: [], effects: [],
    hits: [], onHit(...hit) { this.hits.push(hit); }
  };
}

function advance(seconds, match) {
  while (seconds > 0) {
    const step = Math.min(seconds, 0.05);
    Powers.update(step, match);
    seconds -= step;
  }
}

test('assigns different powers to both fighters each round', () => {
  const players = [fighter(1, 400), fighter(2, 800)];
  for (let n = 0; n < 100; n++) {
    const powerSet = Powers.assignRound(players, () => (n * 0.61803398875) % 1);
    assert.notEqual(powerSet[0], powerSet[1]);
    assert.ok(Powers.NAMES.includes(powerSet[0]));
    assert.ok(Powers.NAMES.includes(powerSet[1]));
  }
  assert.equal(Powers.NAMES.length, 12);
});

test('SWAP exchanges positions safely and SHOCKWAVE deals synchronized hit and shove', () => {
  const swapMatch = world([fighter(1, 400, 'SWAP'), fighter(2, 800, 'FREEZE')]);
  assert.equal(Powers.activate(swapMatch.fighters[0], swapMatch.fighters[1], swapMatch), true);
  assert.equal(swapMatch.fighters[0].x, 800);
  assert.equal(swapMatch.fighters[1].x, 400);
  assert.equal(swapMatch.fighters[0].facing, -1);
  assert.equal(swapMatch.fighters[1].facing, 1);

  const closeMatch = world([fighter(1, 400, 'SWAP'), fighter(2, 430, 'FREEZE')]);
  assert.equal(Powers.activate(closeMatch.fighters[0], closeMatch.fighters[1], closeMatch), false);
  assert.equal(closeMatch.fighters[0].powerCooldown, 0);

  const waveMatch = world([fighter(1, 400, 'SHOCKWAVE'), fighter(2, 520, 'FREEZE')]);
  assert.equal(Powers.activate(waveMatch.fighters[0], waveMatch.fighters[1], waveMatch), true);
  assert.equal(waveMatch.shockwaves.length, 1);
  advance(0.2, waveMatch);
  assert.equal(waveMatch.fighters[1].health, 100 - Powers.CONFIG.SHOCKWAVE.damage);
  assert.equal(waveMatch.shockwaves.length, 1);
  assert.ok(waveMatch.fighters[1].x > 520);
  assert.equal(waveMatch.hits.length, 1);
});

test('a newly placed trap appears at full size immediately while remaining unarmed', () => {
  const match = world([fighter(1, 400, 'TRAP'), fighter(2, 800, 'PULL')]);
  assert.equal(Powers.activate(match.fighters[0], match.fighters[1], match), true);
  const trap = match.traps[0];
  assert.equal(trap.armT, Powers.CONFIG.TRAP.armTime);

  const lineTos = [];
  const ctx = new Proxy({}, {
    get(target, key) {
      if (key === 'lineTo') return (...point) => lineTos.push(point);
      if (!(key in target)) target[key] = () => {};
      return target[key];
    },
    set(target, key, value) { target[key] = value; return true; }
  });
  Powers.drawBack(ctx, {
    fxTime: 0, fighters: [match.fighters[0], match.fighters[1]],
    traps: match.traps, statues: [], clones: []
  });
  assert.ok(lineTos.some(([, y]) => y === trap.y - 23));
  assert.equal(trap.armT, Powers.CONFIG.TRAP.armTime);
});

test('activates each configured power once and blocks reuse during cooldown', () => {
  for (const power of Powers.NAMES) {
    const match = world([fighter(1, 400, power), fighter(2, 800, 'TELEPORT')]);
    assert.equal(Powers.activate(match.fighters[0], match.fighters[1], match), true, power);
    assert.equal(match.fighters[0].powerCooldown, Powers.CONFIG[power].cooldown, power);
    assert.equal(Powers.activate(match.fighters[0], match.fighters[1], match), false, power);
  }
});

test('teleport stays inside arena and projectile applies host-side damage', () => {
  const facingRight = world([fighter(1, 400, 'TELEPORT'), fighter(2, 800, 'FREEZE')]);
  facingRight.fighters[1].facing = 1;
  assert.equal(Powers.activate(facingRight.fighters[0], facingRight.fighters[1], facingRight), true);
  assert.equal(facingRight.fighters[0].x, facingRight.fighters[1].x - Powers.CONFIG.TELEPORT.landingOffset);
  assert.equal(facingRight.fighters[0].facing, 1);

  const facingLeft = world([fighter(1, 400, 'TELEPORT'), fighter(2, 800, 'FREEZE')]);
  facingLeft.fighters[1].facing = -1;
  Powers.activate(facingLeft.fighters[0], facingLeft.fighters[1], facingLeft);
  assert.equal(facingLeft.fighters[0].x, facingLeft.fighters[1].x + Powers.CONFIG.TELEPORT.landingOffset);
  assert.equal(facingLeft.fighters[0].facing, -1);

  const teleportMatch = world([fighter(1, 1190, 'TELEPORT'), fighter(2, 1205, 'FREEZE')]);
  assert.equal(Powers.activate(teleportMatch.fighters[0], teleportMatch.fighters[1], teleportMatch), true);
  assert.ok(teleportMatch.fighters[0].x >= teleportMatch.left);
  assert.ok(teleportMatch.fighters[0].x <= teleportMatch.right);

  const projectileMatch = world([fighter(1, 400, 'PROJECTILE'), fighter(2, 470, 'FREEZE')]);
  Powers.activate(projectileMatch.fighters[0], projectileMatch.fighters[1], projectileMatch);
  advance(0.1, projectileMatch);
  assert.equal(projectileMatch.fighters[1].health, 86);
  assert.equal(projectileMatch.projectiles.length, 0);
  assert.equal(projectileMatch.hits.length, 1);
});

test('freeze statue re-freezes only after its target leaves and returns', () => {
  const match = world([fighter(1, 400, 'FREEZE'), fighter(2, 800, 'TELEPORT')]);
  Powers.activate(match.fighters[0], match.fighters[1], match);
  assert.equal(match.fighters[1].freezeT, Powers.CONFIG.FREEZE.duration);
  advance(3, match);
  assert.equal(match.fighters[1].freezeT, 0);
  match.fighters[1].x += 100;
  Powers.update(0.05, match);
  match.fighters[1].x = match.statues[0].x;
  Powers.update(0.05, match);
  assert.equal(match.fighters[1].freezeT, Powers.CONFIG.FREEZE.reFreezeDuration);
});

test('temporary power states expire and traps and clones apply damage', () => {
  const slowMatch = world([fighter(1, 400, 'TIME SLOW'), fighter(2, 800, 'DASH')]);
  Powers.activate(slowMatch.fighters[0], slowMatch.fighters[1], slowMatch);
  advance(1, slowMatch);
  assert.equal(slowMatch.fighters[1].slowFactor, Powers.CONFIG['TIME SLOW'].speedFactor);
  advance(3, slowMatch);
  assert.equal(slowMatch.fighters[1].slowFactor, 1);
  assert.ok(Math.abs(slowMatch.fighters[0].powerCooldown - 11) < 1e-9);

  const trapMatch = world([fighter(1, 400, 'TRAP'), fighter(2, 486, 'PULL')]);
  Powers.activate(trapMatch.fighters[0], trapMatch.fighters[1], trapMatch);
  advance(Powers.CONFIG.TRAP.armTime, trapMatch);
  assert.equal(trapMatch.fighters[1].health, 82);
  assert.equal(trapMatch.traps.length, 0);

  const cloneMatch = world([fighter(1, 400, 'CLONE'), fighter(2, 500, 'PULL')]);
  cloneMatch.fighters[1].dmg = 1;
  Powers.activate(cloneMatch.fighters[0], cloneMatch.fighters[1], cloneMatch);
  assert.equal(cloneMatch.clones.length, 1);
  assert.equal(cloneMatch.clones[0].maxLife, Powers.CONFIG.CLONE.duration);
  assert.equal(cloneMatch.clones[0].health, Powers.CONFIG.CLONE.health);
  advance(Powers.CONFIG.CLONE.spawnDelay + 0.02, cloneMatch);
  assert.equal(Powers.hitClone(cloneMatch.fighters[1], [400, 554], 16, cloneMatch), true);
  assert.equal(cloneMatch.clones[0].health, Powers.CONFIG.CLONE.health - 1);
  Powers.hitClone(cloneMatch.fighters[1], [400, 554], 16, cloneMatch);
  assert.equal(cloneMatch.clones[0].health, Powers.CONFIG.CLONE.health - 1);
  advance(0.13, cloneMatch);
  Powers.hitClone(cloneMatch.fighters[1], [400, 554], 16, cloneMatch);
  assert.equal(cloneMatch.clones[0].health, Powers.CONFIG.CLONE.health - 2);
  advance(Powers.CONFIG.CLONE.duration, cloneMatch);
  assert.equal(cloneMatch.clones.length, 0);
});

test('round reset clears every active entity, cooldown, and temporary status', () => {
  const match = world();
  const [first, second] = match.fighters;
  first.powerCooldown = 4;
  first.berserkT = 2;
  first.invisibleT = 1;
  match.projectiles.push({});
  match.clones.push({});
  match.traps.push({});
  match.statues.push({});
  match.shockwaves.push({});
  match.effects.push({});
  Powers.resetRound(match, match.fighters);
  assert.deepEqual([match.projectiles, match.clones, match.traps, match.statues, match.shockwaves, match.effects], [[], [], [], [], [], []]);
  assert.equal(first.powerCooldown, 0);
  assert.equal(first.berserkT, 0);
  assert.equal(first.invisibleT, 0);
  assert.equal(first.power, null);
  assert.equal(second.power, null);
});

test('power activation is disabled in standard mode and for uncontrolled fighters', () => {
  const match = world();
  match.powerMode = false;
  assert.equal(Powers.activate(match.fighters[0], match.fighters[1], match), false);
  match.powerMode = true;
  match.fighters[0].canControl = false;
  assert.equal(Powers.activate(match.fighters[0], match.fighters[1], match), false);
});

test('temporary speed, invisibility, and berserk effects return to normal', () => {
  const match = world([fighter(1, 400, 'DASH'), fighter(2, 800, 'INVISIBILITY')]);
  Powers.activate(match.fighters[0], match.fighters[1], match);
  assert.ok(match.fighters[0].dashT > 0);
  advance(Powers.CONFIG.DASH.duration, match);
  assert.equal(match.fighters[0].dashT, 0);

  match.fighters[1].powerCooldown = 0;
  Powers.activate(match.fighters[1], match.fighters[0], match);
  assert.ok(match.fighters[1].invisibleT > 0);
  advance(Powers.CONFIG.INVISIBILITY.duration, match);
  assert.equal(match.fighters[1].invisibleT, 0);

  match.fighters[0].power = 'BERSERK';
  match.fighters[0].powerCooldown = 0;
  Powers.activate(match.fighters[0], match.fighters[1], match);
  assert.ok(match.fighters[0].berserkT > 0);
  advance(Powers.CONFIG.BERSERK.duration, match);
  assert.equal(match.fighters[0].berserkT, 0);
});

test('translucency grants temporary immunity from power damage', () => {
  const match = world([fighter(1, 400, 'PROJECTILE'), fighter(2, 470, 'INVISIBILITY')]);
  match.fighters[1].invisibleT = 2;
  Powers.activate(match.fighters[0], match.fighters[1], match);
  advance(0.1, match);
  assert.equal(match.fighters[1].health, 100);
  assert.equal(match.hits.length, 0);
});

test('frozen fighters take reduced damage from power attacks', () => {
  const match = world([fighter(1, 400, 'PROJECTILE'), fighter(2, 470, 'FREEZE')]);
  match.fighters[1].freezeT = 1;
  Powers.activate(match.fighters[0], match.fighters[1], match);
  advance(0.1, match);
  assert.equal(match.fighters[1].health, 100 - Powers.CONFIG.PROJECTILE.damage * Powers.damageMultiplier(match.fighters[1], match));
});
