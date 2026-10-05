'use strict';

const PowerSystem = require('./power-system');

const GS = Object.freeze({ MENU: 0, INTRO: 1, FIGHT: 2, ROUND_END: 3, AWARD: 4, MATCH_END: 5 });
const INPUTS = Object.freeze(['left', 'right', 'jump', 'down', 'punch', 'kick', 'upper', 'special']);
const GROUND_Y = 612;
const LEFT = 70;
const RIGHT = 1210;
const MOVE_SPEED = 340;
const GRAVITY = 2200;
const JUMP_SPEED = -780;
const WINS_REQUIRED = 2;
const ATTACKS = Object.freeze({
  3: Object.freeze({ startup: 0.1, active: 0.14, recovery: 0.18, damage: 8, knockback: 260, launch: 140, stun: 0.3, radius: 16, heavy: false, range: 94 }),
  4: Object.freeze({ startup: 0.17, active: 0.16, recovery: 0.3, damage: 14, knockback: 430, launch: 300, stun: 0.45, radius: 18, heavy: true, range: 108 }),
  9: Object.freeze({ startup: 0.07, active: 0.2, recovery: 0.36, damage: 16, knockback: 220, launch: 620, stun: 0.55, radius: 32, heavy: true, range: 82 })
});
const FIGHTER_FIELDS = Object.freeze([
  'x', 'y', 'vx', 'vy', 'facing', 'sx', 'state', 'health', 'grounded', 'anim', 'at',
  'attacking', 'hasHit', 'whiff', 'hs', 'flash', 'bflash', 'fall', 'freeze', 'su', 'ac',
  'rc', 'dmg', 'kb', 'launch', 'stun', 'rad', 'heavy', 'canControl', 'power',
  'powerCooldown', 'dashT', 'slowT', 'slowFactor', 'pullT', 'pullTargetId', 'freezeT',
  'invisibleT', 'berserkT'
]);

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const approach = (value, target, delta) => value < target
  ? Math.min(value + delta, target)
  : Math.max(value - delta, target);
const newInput = () => Object.fromEntries(INPUTS.map(key => [key, false]));

function createFighter(id, game) {
  return {
    id, x: id === 1 ? 420 : 860, y: GROUND_Y, vx: 0, vy: 0,
    facing: id === 1 ? 1 : -1, sx: id === 1 ? 1 : -1, state: 0,
    health: 100, grounded: true, anim: 0, at: 0, attacking: false, hasHit: false,
    whiff: false, hs: 0, flash: 0, bflash: 0, fall: -1, freeze: 0,
    su: 0, ac: 0, rc: 0, dmg: 0, kb: 0, launch: 0, stun: 0, rad: 0,
    heavy: false, canControl: false, power: null, powerCooldown: 0,
    dashT: 0, slowT: 0, slowFactor: 1, pullT: 0, pullTargetId: null,
    freezeT: 0, invisibleT: 0, berserkT: 0, previousInput: newInput(),
    applyHit(damage, knockback, launch, stun, direction) {
      if (this.state === 5 && this.facing === -direction) {
        this.health = Math.max(0, this.health - damage * 0.15);
        this.vx = direction * knockback * 0.45;
        this.bflash = 0.18;
      } else {
        this.health = Math.max(0, this.health - damage);
        this.flash = 0.16;
        this.attacking = false;
        this.state = 6;
        this.hs = stun;
        this.vx = direction * knockback;
        this.vy = -launch;
      }
      if (this.health <= 0 && this.state !== 7) {
        this.health = 0;
        this.state = 7;
        this.fall = -1;
        this.grounded = false;
        this.vx = direction * 560;
        this.vy = -480;
        game.finishRound(this.id === 1 ? 2 : 1);
      }
      return this.state === 5;
    }
  };
}

class GameSimulation {
  constructor(powerMode) {
    this.powerMode = powerMode;
    this.fighters = [createFighter(1, this), createFighter(2, this)];
    this.projectiles = [];
    this.clones = [];
    this.traps = [];
    this.statues = [];
    this.effects = [];
    this.fxTime = 0;
    this.state = GS.INTRO;
    this.time = 60;
    this.round = 1;
    this.endDelay = 0;
    this.roundDelay = 1.45;
    this.roundWins = [0, 0];
    this.winner = 0;
    this.slowmo = 0;
    this.ts = 1;
    this.shake = 0;
    this.ox = 0;
    this.oy = 0;
    this.inputs = [newInput(), newInput()];
    this.ann = { text: 'ROUND 1', dur: 0.8, t: 0 };
    this.fx = [];
    this.H = {
      p1n: 'PLAYER 1', p2n: 'PLAYER 2', p1w: 0, p2w: 0,
      d1: 100, d2: 100, time: 60, round: 1, h1: 100, h2: 100
    };
    this.powerWorld = {
      powerMode: this.powerMode, left: LEFT, right: RIGHT, groundY: GROUND_Y,
      fighters: this.fighters, projectiles: this.projectiles, clones: this.clones,
      traps: this.traps, statues: this.statues, effects: this.effects,
      onHit: (_damage, heavy, _point, blocked) => {
        this.recordHit(_damage, heavy, _point, blocked);
      }
    };
    if (this.powerMode) PowerSystem.assignRound(this.fighters);
  }

  setInput(playerId, bits) {
    this.inputs[playerId - 1] = Object.fromEntries(
      INPUTS.map((key, index) => [key, Boolean(bits & (1 << index))])
    );
  }

  step(dt = 1 / 60) {
    dt = clamp(dt, 0, 1 / 20);
    this.fxTime += dt;
    if (this.ann) {
      this.ann.t += dt;
      if (this.ann.t > 0.25 + this.ann.dur + 0.3) this.ann = null;
    }
    for (let index = this.fx.length - 1; index >= 0; index--) {
      const effect = this.fx[index];
      effect.t += dt;
      if (effect.k === 'd') effect.y -= 42 * dt;
      if (effect.t > (effect.k === 's' ? 0.22 : 0.7)) this.fx.splice(index, 1);
    }

    if (this.state === GS.INTRO) {
      this.roundDelay -= dt;
      if (this.roundDelay <= 0) {
        this.state = GS.FIGHT;
        this.ann = { text: 'FIGHT!', dur: 0.6, t: 0 };
        for (const fighter of this.fighters) fighter.canControl = true;
      }
    } else if (this.state === GS.FIGHT) {
      for (let index = 0; index < this.fighters.length; index++) {
        this.stepFighter(this.fighters[index], this.fighters[1 - index], this.inputs[index], dt);
      }
      this.separateFighters();
      if (this.powerMode) PowerSystem.update(dt, this.powerWorld);
      if (this.state === GS.FIGHT) {
        this.time -= dt;
        if (this.time <= 0) this.finishRound(this.timeWinner());
      }
    } else if (this.state === GS.ROUND_END) {
      this.endDelay -= dt;
      if (this.endDelay <= 0) this.finishRoundTransition();
    } else if (this.state === GS.AWARD) {
      this.endDelay -= dt;
      if (this.endDelay <= 0) {
        if (this.roundWins[0] >= WINS_REQUIRED || this.roundWins[1] >= WINS_REQUIRED) {
          this.state = GS.MATCH_END;
          this.winner = this.roundWins[0] === this.roundWins[1] ? 0 : this.roundWins[0] > this.roundWins[1] ? 1 : 2;
          this.ann = { text: (this.winner ? `PLAYER ${this.winner}\nWINS THE MATCH!` : 'MATCH DRAW'), dur: 3, t: 0 };
        } else {
          this.round++;
          this.startRound();
        }
      }
    }

    this.updateHud();
  }

  stepFighter(fighter, opponent, input, frameDt) {
    const previous = fighter.previousInput;
    if (this.powerMode && fighter.freezeT > 0) {
      fighter.previousInput = { ...input };
      return;
    }
    if (fighter.freeze > 0) {
      fighter.freeze = Math.max(0, fighter.freeze - frameDt);
      return;
    }

    const dt = frameDt * (this.powerMode && fighter.slowT > 0 ? fighter.slowFactor : 1);
    fighter.anim += dt;
    fighter.flash = Math.max(0, fighter.flash - dt);
    fighter.bflash = Math.max(0, fighter.bflash - dt);
    if (this.powerMode && input.special && !previous.special) {
      PowerSystem.activate(fighter, opponent, this.powerWorld);
    }

    if ((fighter.state === 0 || fighter.state === 1) && Math.abs(opponent.x - fighter.x) > 4) {
      fighter.facing = opponent.x > fighter.x ? 1 : -1;
    }
    if ([0, 1].includes(fighter.state)) this.groundControl(fighter, input, previous, dt);
    else if (fighter.state === 2) this.airControl(fighter, input, previous, dt);
    else if ([3, 4, 9].includes(fighter.state)) this.updateAttack(fighter, opponent, dt);
    else if (fighter.state === 5) {
      if (input.down && fighter.grounded) fighter.vx = approach(fighter.vx, 0, 2200 * dt);
      else fighter.state = 0;
    } else if (fighter.state === 6) {
      fighter.hs -= dt;
      if (fighter.grounded) fighter.vx = approach(fighter.vx, 0, 1400 * dt);
      if (fighter.hs <= 0) fighter.state = fighter.grounded ? 0 : 2;
    } else if (fighter.state === 7) {
      if (fighter.fall >= 0 && fighter.fall < 1) fighter.fall = Math.min(1, fighter.fall + dt * 2.2);
      if (fighter.grounded) fighter.vx = approach(fighter.vx, 0, 600 * dt);
    } else if (fighter.state === 8) fighter.vx = approach(fighter.vx, 0, 2000 * dt);

    if (this.powerMode && fighter.pullT > 0 && fighter.state !== 7) {
      const puller = this.fighters.find(other => other.id === fighter.pullTargetId);
      if (puller) fighter.vx = PowerSystem.getPullVelocity(fighter, puller);
    }
    fighter.vy += GRAVITY * dt;
    fighter.x += fighter.vx * dt;
    fighter.y += fighter.vy * dt;
    if (fighter.y >= GROUND_Y) {
      fighter.y = GROUND_Y;
      fighter.vy = 0;
      fighter.grounded = true;
      if (fighter.state === 2) fighter.state = 0;
    } else fighter.grounded = false;
    fighter.x = clamp(fighter.x, LEFT, RIGHT);
    fighter.sx = fighter.facing;
    fighter.previousInput = { ...input };
  }

  groundControl(fighter, input, previous, dt) {
    if (input.down) {
      fighter.state = 5;
      fighter.vx = 0;
      return;
    }
    if (input.jump && !previous.jump) {
      fighter.vy = JUMP_SPEED;
      fighter.grounded = false;
      fighter.state = 2;
      fighter.vx = (Number(input.right) - Number(input.left)) * MOVE_SPEED * 0.95;
      return;
    }
    if (input.upper && !previous.upper) return this.startAttack(fighter, 9);
    if (input.punch && !previous.punch) return this.startAttack(fighter, 3);
    if (input.kick && !previous.kick) return this.startAttack(fighter, 4);
    const speed = this.movementMultiplier(fighter);
    const direction = Number(input.right) - Number(input.left);
    if (direction) {
      fighter.state = 1;
      fighter.vx = direction * MOVE_SPEED * speed;
    } else {
      fighter.state = 0;
      fighter.vx = approach(fighter.vx, 0, 2400 * dt);
    }
  }

  airControl(fighter, input, previous, dt) {
    const direction = Number(input.right) - Number(input.left);
    if (direction) fighter.vx = approach(fighter.vx, direction * MOVE_SPEED * this.movementMultiplier(fighter), 1500 * dt);
    if (input.punch && !previous.punch) this.startAttack(fighter, 3);
    else if (input.kick && !previous.kick) this.startAttack(fighter, 4);
  }

  movementMultiplier(fighter) {
    let speed = 1;
    if (this.powerMode && fighter.berserkT > 0) speed *= PowerSystem.CONFIG.BERSERK.movementMultiplier;
    if (this.powerMode && fighter.dashT > 0) speed *= PowerSystem.CONFIG.DASH.speedMultiplier;
    return speed;
  }

  startAttack(fighter, state) {
    const attack = ATTACKS[state];
    fighter.attacking = true;
    fighter.at = 0;
    fighter.hasHit = false;
    fighter.whiff = false;
    fighter.state = state;
    fighter.su = attack.startup;
    fighter.ac = attack.active;
    fighter.rc = attack.recovery;
    fighter.dmg = attack.damage;
    fighter.kb = attack.knockback;
    fighter.launch = attack.launch;
    fighter.stun = attack.stun;
    fighter.rad = attack.radius;
    fighter.heavy = attack.heavy;
    if (this.powerMode && fighter.berserkT > 0) {
      const config = PowerSystem.CONFIG.BERSERK;
      fighter.su /= config.attackSpeedMultiplier;
      fighter.ac /= config.attackSpeedMultiplier;
      fighter.rc /= config.attackSpeedMultiplier;
      fighter.dmg *= config.damageMultiplier;
      fighter.kb *= config.knockbackMultiplier;
    }
  }

  updateAttack(attacker, target, dt) {
    attacker.at += dt;
    if (attacker.grounded) attacker.vx = approach(attacker.vx, 0, 1800 * dt);
    if (attacker.at >= attacker.su && attacker.at < attacker.su + attacker.ac &&
        !attacker.hasHit && target.state !== 7 && this.canAttackHit(attacker, target)) {
      const attack = ATTACKS[attacker.state];
      const dx = target.x - attacker.x;
      const horizontal = dx * attacker.facing;
      const vertical = Math.abs(target.y - attacker.y);
      const inRange = horizontal >= -8 && Math.abs(dx) <= attack.range && vertical < 120;
      if (this.powerMode && PowerSystem.hitClone(attacker, this.strikePoint(attacker), attacker.rad, this.powerWorld)) {
        attacker.hasHit = true;
      } else if (inRange && !(this.powerMode && target.invisibleT > 0)) {
        const damage = attacker.dmg * (this.powerMode ? PowerSystem.damageMultiplier(target, this.powerWorld) : 1);
        const blocked = target.applyHit(damage, attacker.kb, attacker.launch, attacker.stun,
          target.x < attacker.x ? -1 : 1);
        attacker.hasHit = true;
        this.recordHit(damage, attacker.heavy, this.strikePoint(attacker), blocked);
      }
    }
    if (attacker.at >= attacker.su + attacker.ac + attacker.rc) {
      attacker.attacking = false;
      attacker.state = attacker.grounded ? 0 : 2;
    }
  }

  strikePoint(fighter) {
    const attack = ATTACKS[fighter.state];
    return [fighter.x + fighter.facing * attack.range * 0.48, fighter.y - 70];
  }

  canAttackHit(attacker, target) {
    if (attacker.state === 9) return GROUND_Y - target.y > 28;
    if (!attacker.grounded && target.state === 9 && target.at < target.su + target.ac) return false;
    return true;
  }

  recordHit(damage, heavy, point, blocked) {
    if (!Array.isArray(point)) return;
    if (blocked) {
      this.fx.push({ k: 's', x: point[0], y: point[1], t: 0, strong: false, bl: true });
      while (this.fx.length > 120) this.fx.shift();
      this.shake = Math.max(this.shake, 0.08);
      return;
    }
    this.shake = Math.max(this.shake, heavy ? 0.25 : 0.14);
    this.fx.push({ k: 's', x: point[0], y: point[1], t: 0, strong: !!heavy, bl: false });
    this.fx.push({ k: 'd', x: point[0], y: point[1] - 30, t: 0, text: String(damage | 0), big: !!heavy });
    while (this.fx.length > 120) this.fx.shift();
    for (const fighter of this.fighters) {
      fighter.freeze = Math.max(fighter.freeze, heavy ? 0.09 : 0.06);
    }
  }

  separateFighters() {
    const [first, second] = this.fighters;
    if (first.state === 7 || second.state === 7 || Math.abs(first.y - second.y) >= 90) return;
    const distance = second.x - first.x;
    if (Math.abs(distance) < 44) {
      const shift = (44 - Math.abs(distance)) * 0.5 * (distance < 0 ? -1 : 1);
      first.x = clamp(first.x - shift, LEFT, RIGHT);
      second.x = clamp(second.x + shift, LEFT, RIGHT);
    }
  }

  timeWinner() {
    return this.fighters[0].health === this.fighters[1].health
      ? 0
      : this.fighters[0].health > this.fighters[1].health ? 1 : 2;
  }

  finishRound(winner) {
    this.state = GS.ROUND_END;
    this.winner = winner;
    this.endDelay = 1.9;
    for (const fighter of this.fighters) {
      fighter.canControl = false;
      if (winner && fighter.id === winner && fighter.state !== 7) {
        fighter.state = 8;
        fighter.attacking = false;
      }
    }
    if (winner) this.ann = { text: 'K.O.!', dur: 1.3, t: 0 };
    else this.ann = { text: 'TIME UP', dur: 0.9, t: 0 };
  }

  finishRoundTransition() {
    if (this.winner) this.roundWins[this.winner - 1]++;
    this.H.p1w = this.roundWins[0];
    this.H.p2w = this.roundWins[1];
    this.state = GS.AWARD;
    this.endDelay = 2;
    this.ann = {
      text: this.winner ? `PLAYER ${this.winner} WINS!` : 'DRAW',
      dur: 1,
      t: 0
    };
  }

  startRound() {
    this.state = GS.INTRO;
    this.time = 60;
    this.H.time = 60;
    this.H.round = this.round;
    this.winner = 0;
    this.endDelay = 0;
    this.roundDelay = 1.45;
    this.ann = { text: `ROUND ${this.round}`, dur: 0.8, t: 0 };
    PowerSystem.resetRound(this.powerWorld, this.fighters);
    for (let i = 0; i < this.fighters.length; i++) {
      const fighter = this.fighters[i];
      Object.assign(fighter, createFighter(i + 1, this));
    }
    this.projectiles = this.powerWorld.projectiles;
    this.clones = this.powerWorld.clones;
    this.traps = this.powerWorld.traps;
    this.statues = this.powerWorld.statues;
    this.effects = this.powerWorld.effects;
    this.powerWorld.fighters = this.fighters;
    this.inputs = [newInput(), newInput()];
    if (this.powerMode) PowerSystem.assignRound(this.fighters);
  }

  restart() {
    this.roundWins = [0, 0];
    this.round = 1;
    this.H.p1w = 0;
    this.H.p2w = 0;
    this.startRound();
  }

  updateHud() {
    this.H.h1 = this.fighters[0].health;
    this.H.h2 = this.fighters[1].health;
    this.H.d1 = this.H.h1;
    this.H.d2 = this.H.h2;
    this.H.time = Math.max(0, Math.ceil(this.time));
    this.H.round = this.round;
  }

  snapshot() {
    return {
      type: 'state',
      state: this.state,
      time: this.time,
      round: this.round,
      endDelay: this.endDelay,
      winner: this.winner,
      ts: this.ts,
      slowmo: this.slowmo,
      shake: this.shake,
      ox: this.ox,
      oy: this.oy,
      H: { ...this.H },
      powerMode: this.powerMode,
      powerEntities: {
        projectiles: this.projectiles,
        clones: this.clones,
        traps: this.traps,
        statues: this.statues,
        effects: this.effects,
        fxTime: this.fxTime
      },
      fx: this.fx.map(effect => ({ ...effect })),
      fighters: this.fighters.map(fighter => Object.fromEntries(
        FIGHTER_FIELDS.map(field => [field, fighter[field]])
      )),
      ann: this.ann && { ...this.ann }
    };
  }
}

module.exports = { GameSimulation, INPUTS, GS };
