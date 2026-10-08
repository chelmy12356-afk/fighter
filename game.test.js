const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const PowerSystem = require('./power-system');

function loadGame() {
  const noop = () => {};
  const context2d = new Proxy({}, {
    get(target, key) {
      if (!(key in target)) target[key] = noop;
      return target[key];
    },
    set(target, key, value) {
      target[key] = value;
      return true;
    }
  });
  const elements = new Map();
  function createElementState(id) {
    const handlers = new Map();
    return {
      id, hidden: true, checked: false, value: '', textContent: '', disabled: false,
      classList: { add: noop, remove: noop },
      addEventListener(event, callback) {
        if (!handlers.has(event)) handlers.set(event, []);
        handlers.get(event).push(callback);
      },
      click() { for (const callback of handlers.get('click') || []) callback({ preventDefault: noop }); },
      focus: noop,
      getContext: () => context2d
    };
  }
  function getElementById(id) {
    if (!elements.has(id)) elements.set(id, createElementState(id));
    return elements.get(id);
  }
  const document = {
    getElementById,
    createElement: () => ({ width: 0, height: 0, getContext: () => context2d }),
    fonts: { load: noop }
  };
  const html = fs.readFileSync(path.join(__dirname, 'stickman_clash.html'), 'utf8');
  const inlineScript = html.split('<script>\n')[1].split('</script>')[0];
  const listeners = new Map();
  const sandbox = {
    document, PowerSystem, performance: { now: () => 0 },
    requestAnimationFrame: noop, setInterval: noop,
    addEventListener: (event, callback) => {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(callback);
    },
    location: { protocol: 'http:', host: 'localhost' },
    WebSocket: { OPEN: 1, CLOSING: 2 },
    Math, Set, Map, Object, Array, String, Number, JSON, console
  };
  vm.createContext(sandbox);
  vm.runInContext(inlineScript, sandbox);
  return {
    sandbox,
    evaluate: source => vm.runInContext(source, sandbox),
    dispatch(event, data) { for (const callback of listeners.get(event) || []) callback(data); },
    element: getElementById
  };
}

test('standard mode keeps F punch and G kick while powers are a separate mode', () => {
  const game = loadGame();
  game.evaluate('startMatch(true, false); M.p1.canControl = true; keys.add("KeyF"); M.p1.physics(1/60)');
  assert.equal(game.evaluate('M.powerMode'), false);
  assert.equal(game.evaluate('M.p1.state'), 3);

  game.evaluate('keys.clear(); startMatch(true, false); M.p1.canControl = true; keys.add("KeyG"); M.p1.physics(1/60)');
  assert.equal(game.evaluate('M.p1.state'), 4);
});

test('lethal hits break apart fighters in both modes and online snapshots trigger once', () => {
  for (const powerMode of [false, true]) {
    const game = loadGame();
    game.evaluate(`startMatch(true, ${powerMode}); M.state = GS.FIGHT; M.p2.die(1); drawBlackFlash()`);
    assert.equal(game.evaluate('M.p2.broken'), true);
    assert.equal(game.evaluate('M.p2.vx'), 1500);
    assert.equal(game.evaluate('breakupPieces.length'), 14);
    assert.equal(game.evaluate('blackFlash.bolts.length'), 18);
    const boltX = game.evaluate('blackFlash.bolts[0][1][0]');
    game.evaluate('updateBreakupPieces(0.04)');
    assert.notEqual(game.evaluate('blackFlash.bolts[0][1][0]'), boltX);
  }

  const game = loadGame();
  game.evaluate(`M.net.connected = true;
    applySnapshot({type:'state',state:2,time:60,round:1,endDelay:0,winner:0,ts:1,slowmo:0,shake:0,ox:0,oy:0,H:{},fighters:[{state:0},{state:0}]});
    applySnapshot({type:'state',state:3,time:60,round:1,endDelay:1.9,winner:1,ts:1,slowmo:0,shake:0,ox:0,oy:0,H:{},fighters:[{state:0},{state:7,x:860,y:612,fall:-1,facing:-1,vx:1500}]});`);
  assert.equal(game.evaluate('M.p2.broken'), true);
  assert.equal(game.evaluate('breakupPieces.length'), 14);
  assert.equal(game.evaluate('blackFlash.bolts.length'), 18);
  game.evaluate(`blackFlash.t=.37; applySnapshot({type:'state',state:3,time:60,round:1,endDelay:1.8,winner:1,ts:1,slowmo:0,shake:0,ox:0,oy:0,H:{},fighters:[{state:0},{state:7,x:860,y:612,fall:-1,facing:-1,vx:1500}]})`);
  assert.equal(game.evaluate('breakupPieces.length'), 14);
  assert.equal(game.evaluate('blackFlash.t'), 0.37);
});

test('power mode assigns unique powers and activates Shift abilities locally and online', () => {
  const game = loadGame();
  game.evaluate('startMatch(true, true); M.p1.canControl = true; M.p1.power = "PROJECTILE"; M.p2.power = "TRAP"');
  game.dispatch('keydown', { code: 'ShiftLeft', repeat: false, preventDefault() {} });
  game.evaluate('M.p1.physics(1/60)');
  assert.equal(game.evaluate('M.powerMode'), true);
  assert.notEqual(game.evaluate('M.p1.power'), game.evaluate('M.p2.power'));
  assert.equal(game.evaluate('M.projectiles.length'), 1);
  assert.equal(game.evaluate('M.p1.powerCooldown'), 6);
  assert.equal(game.evaluate('ann.text'), 'PROJECTILE!');

  game.evaluate('M.net.role = "host"; M.net.connected = true; startMatch(false, true); M.p1.x = 700; M.p1.canControl = true; frame(16)');
  assert.equal(game.evaluate('M.p1.x'), 700);
  game.evaluate('applySnapshot({type:"state",state:2,time:60,round:1,endDelay:0,winner:0,ts:1,slowmo:0,shake:0,ox:0,oy:0,H:{},powerMode:true,powerEntities:{traps:[{ownerId:2}],shockwaves:[{ownerId:1,r:20,maxR:240}],fxTime:0},fighters:[{},{}]})');
  assert.equal(game.evaluate('M.traps.length'), 1);
  assert.equal(game.evaluate('M.shockwaves.length'), 1);
  assert.equal(game.evaluate('typeof makeSnapshot'), 'undefined');
});

test('Host Online Powers opens room setup with powers enabled, not a local match', () => {
  const game = loadGame();
  game.dispatch('keydown', { code: 'Digit7', repeat: false, preventDefault() {} });
  assert.equal(game.element('powers-mode').checked, true);
  assert.equal(game.element('online-panel').hidden, false);
  assert.equal(game.evaluate('M.state'), 0);
  assert.equal(game.evaluate('M.net.role'), null);
});

test('CPU activates each assigned power when its ability is useful', () => {
  for (const power of PowerSystem.NAMES) {
    const game = loadGame();
    const distance = power === 'DASH' ? 300 : power === 'TRAP' ? 100 : 200;
    game.evaluate(`startMatch(true, true); M.p2.power = ${JSON.stringify(power)}; M.p2.x = M.p1.x + ${distance}; M.p2.canControl = true; M.p2.aiOn = true; ${power === 'INVISIBILITY' ? 'M.p1.attacking = true;' : ''} M.p2.physics(1/60)`);
    assert.equal(game.evaluate('M.p2.powerCooldown'), PowerSystem.CONFIG[power].cooldown, power);
    if (power === 'PROJECTILE') {
      assert.equal(game.evaluate('M.projectiles.length'), 1);
      assert.equal(game.evaluate('M.projectiles[0].ownerId'), 2);
    }
  }
});

test('invisible player is translucent and cannot be hit by regular attacks', () => {
  const game = loadGame();
  game.evaluate('startMatch(true, true); M.p2.invisibleT = 1');
  assert.equal(game.evaluate('M.p2.hurt([M.p2.x, M.p2.y - 58], 20)'), false);
});

test('frozen fighters take reduced damage from regular punches', () => {
  const game = loadGame();
  game.evaluate('startMatch(true, true); M.p1.x = 400; M.p2.x = 455; M.p2.freezeT = 1; M.p1.canControl = true; M.p1.startAtk(3); M.p1.at = M.p1.su; M.p1.physics(1/60)');
  assert.equal(game.evaluate('M.p2.health'), 100 - 8 * PowerSystem.CONFIG.FREEZE.frozenDamageMultiplier);
});

test('Berserk slightly slows movement while preserving the powered attack state', () => {
  const game = loadGame();
  game.evaluate('startMatch(true, true); M.p1.canControl = true; M.p1.berserkT = 2; keys.add("KeyD"); M.p1.physics(1/60)');
  assert.equal(game.evaluate('M.p1.vx'), 340 * PowerSystem.CONFIG.BERSERK.movementMultiplier);
  assert.ok(PowerSystem.CONFIG.BERSERK.movementMultiplier < 1);
  assert.ok(PowerSystem.CONFIG.BERSERK.attackSpeedMultiplier > 1);
});

test('Dash boosts steering speed without an automatic burst and lasts longer', () => {
  const game = loadGame();
  game.evaluate('startMatch(true, true); M.p1.canControl = true; M.p1.power = "DASH"; PowerSystem.activate(M.p1, M.p2, M)');
  assert.equal(game.evaluate('M.p1.vx'), 0);
  game.evaluate('keys.add("KeyD"); M.p1.physics(1/60)');
  assert.equal(game.evaluate('M.p1.vx'), 340 * PowerSystem.CONFIG.DASH.speedMultiplier);
  assert.equal(game.evaluate('M.p1.dashT'), PowerSystem.CONFIG.DASH.duration);
  assert.ok(PowerSystem.CONFIG.DASH.duration > 1);
  assert.ok(PowerSystem.CONFIG.DASH.speedMultiplier < 2);
});

test('clone independently seeks and attacks the opponent for a short lifetime', () => {
  const game = loadGame();
  game.evaluate('startMatch(true, true); M.p1.x = 700; M.p2.x = 755; M.p1.power = "CLONE"; M.p1.canControl = true; PowerSystem.activate(M.p1, M.p2, M)');
  assert.equal(game.evaluate('M.clones.length'), 1);
  game.evaluate('for(let i=0;i<35;i++)PowerSystem.update(0.02, M)');
  assert.equal(game.evaluate('M.p1.state'), 0);
  assert.equal(game.evaluate('M.clones[0].ownerId'), 1);
  assert.equal(game.evaluate('M.clones[0].hasHit'), true);
  assert.equal(game.evaluate('M.p2.health'), 94);
  assert.equal(game.evaluate('M.clones[0].maxLife'), PowerSystem.CONFIG.CLONE.duration);
  game.evaluate('for(let i=0;i<200;i++)PowerSystem.update(0.02, M)');
  assert.equal(game.evaluate('M.clones.length'), 0);
});

test('starting a new power round clears effects and reassigns different powers', () => {
  const game = loadGame();
  game.evaluate('startMatch(true, true); M.projectiles.push({}); M.clones.push({}); M.traps.push({}); M.statues.push({}); M.effects.push({}); startRound()');
  assert.equal(game.evaluate('M.projectiles.length + M.clones.length + M.traps.length + M.statues.length + M.effects.length'), 0);
  assert.notEqual(game.evaluate('M.p1.power'), game.evaluate('M.p2.power'));
  assert.equal(game.evaluate('M.p1.powerCooldown + M.p2.powerCooldown'), 0);
});

test('match result buttons restart the same mode or return to the menu', () => {
  const game = loadGame();
  game.evaluate('startMatch(true, true); M.state = GS.MATCH_END; syncResultPanel()');
  assert.equal(game.element('result-panel').hidden, false);
  game.element('play-again').click();
  assert.equal(game.evaluate('M.powerMode'), true);
  assert.equal(game.evaluate('M.vsCpu'), true);
  assert.equal(game.evaluate('M.state'), 1);

  game.evaluate('M.state = GS.MATCH_END; syncResultPanel()');
  game.element('back-to-menu').click();
  assert.equal(game.evaluate('M.state'), 0);
  assert.equal(game.evaluate('M.powerMode'), false);
  assert.equal(game.element('result-panel').hidden, true);
});
