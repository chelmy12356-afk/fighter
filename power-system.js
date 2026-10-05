/**
 * PowerSystem — round powers for a 2-fighter stick-figure fighting game.
 *
 * Public API is unchanged from the original, so your game loop keeps working:
 *   CONFIG, NAMES, assignRound, resetFighter, resetRound, activate,
 *   damageMultiplier, update, hitClone, draw, clamp
 *
 * New (all optional):
 *   COLORS                 – one signature colour per power (for your HUD)
 *   drawBack / drawFront   – draw() split in two: call drawBack BEFORE the fighters
 *                            and drawFront AFTER them for correct layering.
 *                            draw() still does both in one go.
 *   getCooldownRatio(f)    – 0..1 (1 = ready), for a cooldown bar
 *   getModifiers(f)        – { move, attackSpeed, damage, knockback } multipliers
 *   getPullVelocity(t, p)  – signed x-velocity for a fighter being pulled
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.PowerSystem = api;
})(typeof globalThis === 'undefined' ? this : globalThis, function () {
  'use strict';

  /* ════════════════════════════════ TUNING ════════════════════════════════ */

  const CONFIG = Object.freeze({
    // `distance` is unused by the logic (kept so old references don't break).
    TELEPORT: Object.freeze({ cooldown: 10, distance: 150, landingOffset: 72 }),
    PROJECTILE: Object.freeze({
      cooldown: 6, speed: 680, lifetime: 2.1, damage: 14, knockback: 300, stun: 0.3,
      hitHalfWidth: 30
    }),
    DASH: Object.freeze({ cooldown: 8, duration: 2, speedMultiplier: 1.6 }),
    'TIME SLOW': Object.freeze({ cooldown: 15, duration: 3, speedFactor: 0.35 }),
    PULL: Object.freeze({ cooldown: 10, duration: 0.8, speed: 430 }),
    CLONE: Object.freeze({
      cooldown: 15,
      duration: 4,            // how long the clone lives (s)
      health: 4,              // LOW on purpose: one solid hit usually kills it
      speed: 260,
      // combat
      attackRange: 78, attackDamage: 6, knockback: 110, stun: 0.18,
      attackInterval: 0.7,    // min time between two attack starts
      attackDuration: 0.3,    // windup + strike
      windup: 0.18,           // telegraph before the hit lands (player can dodge)
      // CPU behaviour
      spawnDelay: 0.35,       // materialising, can't act or be hit
      spawnOffset: 54,        // appears this far in front of the owner
      reaction: 0.16,         // how often it re-reads the target's position (lag = human-like)
      waryChance: 0.3,        // chance to back off when the target is mid-attack
      retreatChance: 0.4,     // chance to hit-and-run after an attack
      retreatTime: 0.4,
      retreatSpeed: 0.75,
      hitStagger: 0.25
    }),
    INVISIBILITY: Object.freeze({ cooldown: 15, duration: 4 }),
    FREEZE: Object.freeze({
      cooldown: 18, duration: 2.4, frozenDamageMultiplier: 0.5, statueLifetime: 8,
      reFreezeDuration: 1.4, statueRadius: 38, maxStatues: 2   // maxStatues is per owner
    }),
    BERSERK: Object.freeze({
      cooldown: 20, duration: 4, movementMultiplier: 0.9, attackSpeedMultiplier: 1.3,
      damageMultiplier: 1.3, knockbackMultiplier: 1.2
    }),
    TRAP: Object.freeze({
      cooldown: 12, lifetime: 12, range: 86, damage: 18, knockback: 160, stun: 0.9,
      maxTraps: 3,            // per owner
      armTime: 0.5,           // a fresh trap is harmless for this long
      triggerRadius: 28
    }),
    // Trade places with the opponent. Fails (no cooldown spent) if you're already on top of each other.
    SWAP: Object.freeze({ cooldown: 9, minDistance: 50 }),
    // A dome bursts out of you, shoves the opponent away, shatters clones and wipes enemy projectiles.
    SHOCKWAVE: Object.freeze({
      cooldown: 12, radius: 240, speed: 560,   // dome grows to `radius` px at `speed` px/s
      damage: 8, knockback: 260, stun: 0.35,
      shoveDistance: 110, shoveTime: 0.25,     // guaranteed slide, even if the hit is blocked
      shake: 10                                // passed to world.onShake(intensity, seconds) if you define it
    })
  });

  const COLORS = Object.freeze({
    TELEPORT: '#b784ff',
    PROJECTILE: '#5eeaff',
    DASH: '#ffe66d',
    'TIME SLOW': '#7aa2ff',
    PULL: '#ff8ad8',
    CLONE: '#8deeff',
    INVISIBILITY: '#d3dcff',
    FREEZE: '#9cf3ff',
    BERSERK: '#ff8a3d',
    TRAP: '#ff5d73',
    SWAP: '#4dffb8',
    SHOCKWAVE: '#111318'
  });

  const NAMES = Object.freeze(Object.keys(CONFIG));
  const DEAD = 7;
  const ATTACK = 3;
  const MAX_PROJECTILES = 16;
  const MAX_CLONES = 2;
  const MAX_EFFECTS = 96;
  const BODY_HEIGHT = 125;
  const TAU = Math.PI * 2;
  const EMPTY = Object.freeze([]);

  /* ═══════════════════════════════ HELPERS ═══════════════════════════════ */

  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const lerp = (a, b, t) => a + (b - a) * t;
  const isDead = fighter => !fighter || fighter.state === DEAD;
  const byId = (world, id) => world.fighters.find(f => f.id === id);
  const foeOf = (world, id) => world.fighters.find(f => f.id !== id);
  const rng = world => (typeof world.random === 'function' ? world.random() : Math.random());

  function ensureWorld(world) {
    for (const key of ['projectiles', 'clones', 'traps', 'statues', 'shockwaves', 'effects']) {
      if (!Array.isArray(world[key])) world[key] = [];
    }
    return world;
  }

  /* ═════════════════════════════ ROUND SETUP ═════════════════════════════ */

  function assignRound(fighters, random = Math.random) {
    if (fighters.length !== 2) throw new Error('A power round requires exactly two fighters.');
    const first = Math.floor(clamp(random() * NAMES.length, 0, NAMES.length - 1));
    let second = Math.floor(clamp(random() * (NAMES.length - 1), 0, NAMES.length - 2));
    if (second >= first) second++;
    fighters[0].power = NAMES[first];
    fighters[1].power = NAMES[second];
    for (const fighter of fighters) resetFighter(fighter);
    return [fighters[0].power, fighters[1].power];
  }

  function resetFighter(fighter) {
    fighter.powerCooldown = 0;
    fighter.dashT = 0;
    fighter.dashGhostT = 0;
    fighter.fxLastX = null;
    fighter.slowT = 0;
    fighter.slowFactor = 1;
    fighter.pullT = 0;
    fighter.pullTargetId = null;
    fighter.freezeT = 0;
    fighter.invisibleT = 0;
    fighter.berserkT = 0;
  }

  function resetRound(world, fighters) {
    world.projectiles = [];
    world.clones = [];
    world.traps = [];
    world.statues = [];
    world.shockwaves = [];
    world.effects = [];
    world.fxTime = 0;
    for (const fighter of fighters) {
      fighter.power = null;
      resetFighter(fighter);
    }
  }

  /* ═════════════════════════════ EFFECT QUEUE ═════════════════════════════ */

  // Pure visuals. Uses Math.random so it never disturbs a seeded game RNG.
  function effect(world, type, x, y, duration = 0.55, extra) {
    if (world.effects.length >= MAX_EFFECTS) world.effects.shift();
    world.effects.push(Object.assign(
      { type, x, y, life: duration, maxLife: duration, seed: Math.random() }, extra));
  }

  /* ════════════════════════════ DAMAGE HELPERS ════════════════════════════ */

  // Returns true when the hit was applied (even if the target blocked it).
  function damage(attacker, target, amount, knockback, stun, world, point) {
    if (isDead(target) || target.invisibleT > 0 || typeof target.applyHit !== 'function') return false;
    amount *= damageMultiplier(target, world);
    const direction = target.x < attacker.x ? -1 : 1;
    const blocked = target.applyHit(amount, knockback, 0, stun, direction);
    if (typeof world.onHit === 'function') {
      world.onHit(amount, true, point || [target.x, target.y - 50], blocked);
    }
    return true;
  }

  function damageMultiplier(target, world) {
    return world.powerMode && target.freezeT > 0 ? CONFIG.FREEZE.frozenDamageMultiplier : 1;
  }

  function damageClone(world, clone, amount, sourceX, knock) {
    if (clone.spawnT > 0 || clone.invulnT > 0 || clone.health <= 0) return false;
    clone.health -= amount;
    clone.invulnT = 0.12;
    clone.hurtFlash = 0.18;
    clone.staggerT = CONFIG.CLONE.hitStagger;
    clone.attackT = 0;          // getting hit cancels its attack
    clone.hasHit = true;
    clone.retreatT = 0;
    clone.kbVx = (Math.sign(clone.x - sourceX) || 1) * knock;
    return true;
  }

  function removeClone(world, index, reason) {
    const clone = world.clones[index];
    world.clones.splice(index, 1);
    if (reason === 'death') effect(world, 'cloneDeath', clone.x, clone.y - 55, 0.55, { color: COLORS.CLONE });
    else effect(world, 'clone', clone.x, clone.y - 55, 0.4, { color: COLORS.CLONE });
  }

  /* ═════════════════════════════ ACTIVATION ═════════════════════════════ */

  const HANDLERS = {
    TELEPORT(user, foe, world, cfg) {
      const fromX = user.x;
      const lo = world.left + 24, hi = world.right - 24;
      let side = -(foe.facing || 1);                       // behind the opponent
      let x = clamp(foe.x + side * cfg.landingOffset, lo, hi);
      if (Math.abs(x - foe.x) < cfg.landingOffset * 0.6) { // pinned by a wall: land in front instead
        side = -side;
        x = clamp(foe.x + side * cfg.landingOffset, lo, hi);
      }
      user.x = x;
      user.vx = 0;
      user.facing = Math.sign(foe.x - x) || -side;
      effect(world, 'teleport', fromX, user.y, 0.55, { color: COLORS.TELEPORT });
      effect(world, 'teleport', x, user.y, 0.55, { color: COLORS.TELEPORT });
    },

    PROJECTILE(user, foe, world) {
      if (world.projectiles.length >= MAX_PROJECTILES) world.projectiles.shift();
      const x = user.x + user.facing * 35, y = user.y - 58;
      world.projectiles.push({
        ownerId: user.id, x, y, vx: user.facing * CONFIG.PROJECTILE.speed,
        life: CONFIG.PROJECTILE.lifetime, visualT: 0, trail: []
      });
      effect(world, 'muzzle', x, y, 0.3, { color: COLORS.PROJECTILE, dir: user.facing });
    },

    DASH(user, foe, world, cfg) {
      user.dashT = cfg.duration;
      user.fxLastX = null;
      effect(world, 'dash', user.x, user.y - 52, 0.5, { color: COLORS.DASH, dir: user.facing || 1 });
    },

    'TIME SLOW'(user, foe, world, cfg) {
      foe.slowT = cfg.duration;
      foe.slowFactor = cfg.speedFactor;
      effect(world, 'slow', foe.x, foe.y - 60, 0.8, { color: COLORS['TIME SLOW'] });
    },

    PULL(user, foe, world, cfg) {
      foe.pullT = cfg.duration;
      foe.pullTargetId = user.id;
      effect(world, 'pull', foe.x, foe.y - 55, 0.55, { color: COLORS.PULL });
    },

    CLONE(user, foe, world, cfg) {
      // One clone per owner; the global cap only matters if you add more fighters.
      for (let i = world.clones.length - 1; i >= 0; i--) {
        if (world.clones[i].ownerId === user.id) removeClone(world, i, 'fade');
      }
      while (world.clones.length >= MAX_CLONES) removeClone(world, 0, 'fade');
      const x = clamp(user.x + user.facing * cfg.spawnOffset, world.left + 20, world.right - 20);
      world.clones.push({
        ownerId: user.id, x, y: world.groundY, facing: user.facing || 1, pose: null,
        health: cfg.health, maxHealth: cfg.health, life: cfg.duration, maxLife: cfg.duration,
        // state: 0 idle · 1 walking · 3 attacking (same numbering as fighters)
        state: 0, attackT: 0, attackCooldown: 0.15, hasHit: false,
        // CPU brain
        spawnT: cfg.spawnDelay, spawnMax: cfg.spawnDelay,
        thinkT: 0, aimX: foe.x, lastSeenX: foe.x, wary: false, searching: false,
        retreatT: 0, staggerT: 0, invulnT: 0, hurtFlash: 0, kbVx: 0, walkT: 0
      });
      effect(world, 'clone', x, world.groundY - 50, 0.6, { color: COLORS.CLONE });
    },

    INVISIBILITY(user, foe, world, cfg) {
      user.invisibleT = cfg.duration;
      effect(world, 'invisible', user.x, user.y - 55, 0.6, { color: COLORS.INVISIBILITY });
    },

    FREEZE(user, foe, world, cfg) {
      foe.freezeT = cfg.duration;
      foe.dashT = 0;                         // a frozen fighter can't keep dashing or be dragged
      foe.pullT = 0;
      foe.pullTargetId = null;
      const mine = world.statues.filter(s => s.ownerId === user.id);
      if (mine.length >= cfg.maxStatues) world.statues.splice(world.statues.indexOf(mine[0]), 1);
      world.statues.push({
        ownerId: user.id, targetId: foe.id, x: foe.x, y: foe.y, facing: foe.facing || 1,
        life: cfg.statueLifetime, armed: false
      });
      effect(world, 'freeze', foe.x, foe.y - 54, 0.8, { color: COLORS.FREEZE });
    },

    BERSERK(user, foe, world, cfg) {
      user.berserkT = cfg.duration;
      effect(world, 'berserk', user.x, user.y - 55, 0.8, { color: COLORS.BERSERK });
    },

    TRAP(user, foe, world, cfg) {
      const mine = world.traps.filter(t => t.ownerId === user.id);
      if (mine.length >= cfg.maxTraps) world.traps.splice(world.traps.indexOf(mine[0]), 1);
      const x = clamp(user.x + user.facing * cfg.range, world.left + 10, world.right - 10);
      world.traps.push({
        ownerId: user.id, x, y: world.groundY, life: cfg.lifetime, maxLife: cfg.lifetime,
        armT: cfg.armTime
      });
      effect(world, 'trap', x, world.groundY - 10, 0.5, { color: COLORS.TRAP });
    },

    SWAP(user, foe, world, cfg) {
      const ux = user.x, fx = foe.x;
      if (Math.abs(ux - fx) < cfg.minDistance) return false;   // nothing to swap: keep the cooldown
      const lo = world.left + 24, hi = world.right - 24;
      user.x = clamp(fx, lo, hi);
      foe.x = clamp(ux, lo, hi);
      user.vx = 0;
      foe.vx = 0;
      user.facing = Math.sign(foe.x - user.x) || user.facing || 1;   // both end up facing each other
      foe.facing = Math.sign(user.x - foe.x) || foe.facing || 1;
      effect(world, 'teleport', ux, user.y, 0.55, { color: COLORS.SWAP });
      effect(world, 'teleport', fx, foe.y, 0.55, { color: COLORS.SWAP });
      effect(world, 'swap', ux, user.y, 0.55, { color: COLORS.SWAP, x2: fx });
    },

    SHOCKWAVE(user, foe, world, cfg) {
      world.shockwaves.push({
        ownerId: user.id, x: user.x, y: user.y, r: 0, maxR: cfg.radius,
        hit: [], shoves: [], seed: Math.random()
      });
      effect(world, 'shockBurst', user.x, user.y, 0.4, { color: COLORS.SHOCKWAVE });
      if (typeof world.onShake === 'function') world.onShake(cfg.shake, 0.3);
    }
  };

  function activate(user, opponent, world) {
    if (!world || !world.powerMode || !user || !opponent) return false;
    ensureWorld(world);
    if (!user.canControl || !user.power || user.powerCooldown > 0 ||
        isDead(user) || isDead(opponent) || user.freezeT > 0) return false;
    const config = CONFIG[user.power];
    const handler = HANDLERS[user.power];
    if (!config || !handler) return false;
    if (handler(user, opponent, world, config) === false) return false;
    user.powerCooldown = config.cooldown;     // only spent when the power really fired
    effect(world, 'label', user.x, user.y - 148, 0.9, { text: user.power, color: COLORS[user.power] });
    return true;
  }

  /* ═══════════════════════════════ UPDATE ═══════════════════════════════ */

  function update(dt, world) {
    if (!world || !world.powerMode || !world.fighters) return;
    ensureWorld(world);
    dt = clamp(dt, 0, 1 / 20);                // a lag spike must not teleport projectiles
    world.fxTime = (world.fxTime || 0) + dt;
    tickFighters(world, dt);
    updateProjectiles(world, dt);
    updateClones(world, dt);
    updateTraps(world, dt);
    updateStatues(world, dt);
    updateShockwaves(world, dt);
    for (let i = world.effects.length - 1; i >= 0; i--) {
      world.effects[i].life -= dt;
      if (world.effects[i].life <= 0) world.effects.splice(i, 1);
    }
  }

  function tickFighters(world, dt) {
    for (const f of world.fighters) {
      const before = f.powerCooldown || 0;
      f.powerCooldown = Math.max(0, before - dt);
      if (before > 0 && f.powerCooldown === 0 && f.power && !isDead(f)) {
        effect(world, 'ready', f.x, f.y, 0.6, { color: COLORS[f.power] });   // "power is back" ping
      }
      f.dashT = Math.max(0, f.dashT - dt);
      f.slowT = Math.max(0, f.slowT - dt);
      f.slowFactor = f.slowT > 0 ? CONFIG['TIME SLOW'].speedFactor : 1;
      f.pullT = Math.max(0, f.pullT - dt);
      if (f.pullT === 0) f.pullTargetId = null;
      f.freezeT = Math.max(0, f.freezeT - dt);
      f.invisibleT = Math.max(0, f.invisibleT - dt);
      f.berserkT = Math.max(0, f.berserkT - dt);

      // dash afterimages (measured from real movement, so no extra fighter fields are needed)
      if (f.dashT > 0 && f.fxLastX != null && Math.abs(f.x - f.fxLastX) / Math.max(dt, 1e-3) > 120) {
        f.dashGhostT -= dt;
        if (f.dashGhostT <= 0) {
          f.dashGhostT = 0.06;
          effect(world, 'ghost', f.x, f.y, 0.28,
            { color: COLORS.DASH, dir: f.facing || 1, phase: world.fxTime * 14 });
        }
      }
      f.fxLastX = f.x;
    }
  }

  /* ── projectiles ── */

  function projectileHit(world, p, prevX) {
    const half = CONFIG.PROJECTILE.hitHalfWidth;
    const lo = Math.min(prevX, p.x) - half, hi = Math.max(prevX, p.x) + half;
    let best = null, bestDist = Infinity;
    const consider = (obj, kind) => {
      if (obj.x < lo || obj.x > hi || p.y < obj.y - BODY_HEIGHT || p.y > obj.y + 8) return;
      const d = Math.abs(obj.x - prevX);
      if (d < bestDist) { best = { kind, obj }; bestDist = d; }
    };
    const foe = foeOf(world, p.ownerId);
    if (!isDead(foe) && foe.invisibleT <= 0) consider(foe, 'fighter');   // invisible = shots pass through
    for (const c of world.clones) if (c.ownerId !== p.ownerId && c.spawnT <= 0) consider(c, 'clone');
    return best;
  }

  function updateProjectiles(world, dt) {
    const cfg = CONFIG.PROJECTILE;
    for (let i = world.projectiles.length - 1; i >= 0; i--) {
      const p = world.projectiles[i];
      const owner = byId(world, p.ownerId);
      const foe = foeOf(world, p.ownerId);
      if (!owner || isDead(foe)) { world.projectiles.splice(i, 1); continue; }

      const prevX = p.x;
      p.x += p.vx * dt;
      p.life -= dt;
      p.trail.push({ x: p.x, y: p.y });
      if (p.trail.length > 10) p.trail.shift();
      p.visualT -= dt;
      if (p.visualT <= 0) {
        p.visualT = 0.1;
        effect(world, 'spark', p.x, p.y + (Math.random() - 0.5) * 10, 0.2, { color: COLORS.PROJECTILE });
      }

      const hit = projectileHit(world, p, prevX);
      if (hit) {
        if (hit.kind === 'fighter') {
          damage(owner, hit.obj, cfg.damage, cfg.knockback, cfg.stun, world, [p.x, p.y]);
        } else {
          damageClone(world, hit.obj, cfg.damage, p.x - Math.sign(p.vx), 240);
        }
        effect(world, 'impact', p.x, p.y, 0.35, { color: COLORS.PROJECTILE });
        world.projectiles.splice(i, 1);
      } else if (p.life <= 0 || p.x < world.left || p.x > world.right) {
        world.projectiles.splice(i, 1);
      }
    }
  }

  /* ── clones: an independent little CPU fighter ── */

  function updateClones(world, dt) {
    for (let i = world.clones.length - 1; i >= 0; i--) {
      const c = world.clones[i];
      const owner = byId(world, c.ownerId);
      const foe = foeOf(world, c.ownerId);
      if (!owner || isDead(owner) || isDead(foe)) { removeClone(world, i, 'fade'); continue; }
      if (c.health <= 0) { removeClone(world, i, 'death'); continue; }
      c.life -= dt;
      if (c.life <= 0) { removeClone(world, i, 'fade'); continue; }
      c.y = world.groundY;
      // If the owner is time-slowed, their clone is slowed too.
      const timeScale = owner.slowT > 0 ? CONFIG['TIME SLOW'].speedFactor : 1;
      thinkClone(c, foe, world, dt * timeScale);
    }
  }

  function stepClone(c, dir, dist, left, right) {
    const nx = clamp(c.x + dir * dist, left, right);
    const moved = Math.abs(nx - c.x);
    c.x = nx;
    c.walkT += moved * 0.09;
    return moved;
  }

  function cloneStrike(c, foe, world) {
    const cfg = CONFIG.CLONE;
    const dx = foe.x - c.x;
    const inFront = dx * c.facing >= -12;                // can't hit what's behind it
    if (inFront && Math.abs(dx) <= cfg.attackRange + 14 && Math.abs(foe.y - c.y) < 90) {
      const point = [c.x + c.facing * 40, c.y - 70];
      if (damage(c, foe, cfg.attackDamage, cfg.knockback, cfg.stun, world, point)) {
        effect(world, 'impact', point[0], point[1], 0.3, { color: COLORS.CLONE });
      }
    }
  }

  function thinkClone(c, foe, world, dt) {
    const cfg = CONFIG.CLONE;
    const left = world.left + 20, right = world.right - 20;

    c.invulnT = Math.max(0, c.invulnT - dt);
    c.hurtFlash = Math.max(0, c.hurtFlash - dt);
    c.attackCooldown = Math.max(0, c.attackCooldown - dt);
    c.staggerT = Math.max(0, c.staggerT - dt);

    // knockback slide
    if (Math.abs(c.kbVx) > 4) {
      c.x = clamp(c.x + c.kbVx * dt, left, right);
      c.kbVx *= Math.max(0, 1 - 9 * dt);
    } else c.kbVx = 0;

    if (c.spawnT > 0) { c.spawnT = Math.max(0, c.spawnT - dt); c.state = 0; return; }
    if (c.staggerT > 0) { c.state = 0; return; }

    // perception: re-read the target at human-ish intervals, lose it if invisible
    const canSee = foe.invisibleT <= 0;
    if (canSee) c.lastSeenX = foe.x;
    c.searching = !canSee;
    c.thinkT -= dt;
    if (c.thinkT <= 0) {
      c.thinkT = cfg.reaction * (0.7 + rng(world) * 0.6);
      c.aimX = canSee ? foe.x : c.lastSeenX + (rng(world) - 0.5) * 220;
      c.wary = canSee && foe.state === ATTACK && rng(world) < cfg.waryChance;
    }

    // attack in progress: windup (telegraph) → strike
    if (c.attackT > 0) {
      c.attackT = Math.max(0, c.attackT - dt);
      c.state = ATTACK;
      if (!c.hasHit && cfg.attackDuration - c.attackT >= cfg.windup) {
        c.hasHit = true;
        cloneStrike(c, foe, world);
      }
      if (c.attackT === 0) {
        c.state = 0;
        if (rng(world) < cfg.retreatChance) c.retreatT = cfg.retreatTime * (0.7 + rng(world) * 0.6);
      }
      return;
    }

    const gap = Math.abs(foe.x - c.x);

    // hit-and-run: back away while still facing the target
    if (c.retreatT > 0) {
      c.retreatT -= dt;
      const away = -(Math.sign(foe.x - c.x) || c.facing);
      c.facing = -away;
      const moved = stepClone(c, away, cfg.speed * cfg.retreatSpeed * dt, left, right);
      if (moved < 0.1 || gap > cfg.attackRange + 140) c.retreatT = 0;   // cornered or far enough
      c.state = 1;
      return;
    }

    const wantDir = Math.sign(c.aimX - c.x) || c.facing;
    c.facing = wantDir;
    const approachGap = cfg.attackRange * 0.9;
    let moved = 0;

    if (!canSee) {
      const d = Math.abs(c.aimX - c.x);                  // searching: wander to where it last saw you
      if (d > 14) moved = stepClone(c, wantDir, Math.min(cfg.speed * 0.7 * dt, d), left, right);
    } else if (c.wary && gap < cfg.attackRange + 50) {
      c.wary = false;                                    // you're swinging: it backs off
      c.retreatT = 0.3 + rng(world) * 0.2;
    } else if (c.attackCooldown <= 0 && gap <= cfg.attackRange) {
      c.facing = Math.sign(foe.x - c.x) || c.facing;     // in range and ready: commit to the swing
      c.attackT = cfg.attackDuration;
      c.attackCooldown = cfg.attackInterval;
      c.hasHit = false;
      c.state = ATTACK;
      return;
    } else if (gap > approachGap) {
      moved = stepClone(c, wantDir, Math.min(cfg.speed * dt, gap - approachGap), left, right);
    } else if (gap < cfg.attackRange * 0.5) {
      moved = stepClone(c, -wantDir, cfg.speed * 0.45 * dt, left, right);   // too close: make room
    }
    c.state = moved > 0.05 ? 1 : 0;
  }

  /* ── traps / statues ── */

  function updateTraps(world, dt) {
    const cfg = CONFIG.TRAP;
    for (let i = world.traps.length - 1; i >= 0; i--) {
      const trap = world.traps[i];
      trap.life -= dt;
      trap.armT = Math.max(0, (trap.armT || 0) - dt);
      if (trap.life <= 0) { world.traps.splice(i, 1); continue; }
      if (trap.armT > 0) continue;

      const owner = byId(world, trap.ownerId) || { x: trap.x };
      const foe = foeOf(world, trap.ownerId);
      if (!isDead(foe) && foe.invisibleT <= 0 && foe.grounded && Math.abs(foe.x - trap.x) < cfg.triggerRadius) {
        damage(owner, foe, cfg.damage, cfg.knockback, cfg.stun, world, [trap.x, trap.y - 12]);
        effect(world, 'impact', trap.x, trap.y - 12, 0.35, { color: COLORS.TRAP });
        world.traps.splice(i, 1);
        continue;
      }
      // enemy clones walk into traps too
      const clone = world.clones.find(c => c.ownerId !== trap.ownerId && c.spawnT <= 0 &&
        Math.abs(c.x - trap.x) < cfg.triggerRadius);
      if (clone) {
        damageClone(world, clone, cfg.damage, trap.x, 200);
        effect(world, 'impact', trap.x, trap.y - 12, 0.35, { color: COLORS.TRAP });
        world.traps.splice(i, 1);
      }
    }
  }

  function updateStatues(world, dt) {
    const cfg = CONFIG.FREEZE;
    for (let i = world.statues.length - 1; i >= 0; i--) {
      const statue = world.statues[i];
      statue.life -= dt;
      const target = byId(world, statue.targetId);
      if (!target || isDead(target) || statue.life <= 0) { world.statues.splice(i, 1); continue; }
      const distance = Math.hypot(target.x - statue.x, target.y - statue.y);
      if (!statue.armed && distance > cfg.statueRadius + 24) {
        statue.armed = true;                             // walked away: the statue now re-freezes on contact
      } else if (statue.armed && target.freezeT <= 0 && distance < cfg.statueRadius) {
        target.freezeT = cfg.reFreezeDuration;
        effect(world, 'freeze', target.x, target.y - 54, 0.6, { color: COLORS.FREEZE });
      }
    }
  }

  /* ── shockwave dome ── */

  function updateShockwaves(world, dt) {
    const cfg = CONFIG.SHOCKWAVE;
    const shoveSpeed = cfg.shoveDistance / cfg.shoveTime;
    for (let i = world.shockwaves.length - 1; i >= 0; i--) {
      const w = world.shockwaves[i];
      const owner = byId(world, w.ownerId) || { x: w.x };
      const foe = foeOf(world, w.ownerId);

      if (w.r < w.maxR) {
        w.r = Math.min(w.maxR, w.r + cfg.speed * dt);

        // the front reaches the opponent: hit + guaranteed shove away from the caster
        if (!isDead(foe) && foe.invisibleT <= 0 && !w.hit.includes(foe) &&
            Math.hypot(foe.x - w.x, foe.y - 55 - w.y) <= w.r + 25) {
          w.hit.push(foe);
          damage(owner, foe, cfg.damage, cfg.knockback, cfg.stun, world, [foe.x, foe.y - 55]);
          foe.pullT = 0;                                   // being blasted breaks a pull
          foe.pullTargetId = null;
          w.shoves.push({ target: foe, dir: Math.sign(foe.x - w.x) || owner.facing || 1, left: cfg.shoveDistance });
          effect(world, 'impact', foe.x, foe.y - 55, 0.4, { color: COLORS.SHOCKWAVE });
        }
        // enemy clones are blasted too (their health is low, so they usually shatter)
        for (const c of world.clones) {
          if (c.ownerId === w.ownerId || c.spawnT > 0 || w.hit.includes(c)) continue;
          if (Math.hypot(c.x - w.x, c.y - 55 - w.y) <= w.r + 25) {
            w.hit.push(c);
            damageClone(world, c, cfg.damage, w.x, 560);
            effect(world, 'impact', c.x, c.y - 55, 0.35, { color: COLORS.SHOCKWAVE });
          }
        }
        // enemy projectiles that touch the dome are wiped out
        for (let j = world.projectiles.length - 1; j >= 0; j--) {
          const p = world.projectiles[j];
          if (p.ownerId !== w.ownerId && Math.hypot(p.x - w.x, p.y - w.y) <= w.r + 15) {
            effect(world, 'impact', p.x, p.y, 0.3, { color: COLORS.PROJECTILE });
            world.projectiles.splice(j, 1);
          }
        }
      }

      for (let s = w.shoves.length - 1; s >= 0; s--) {
        const shove = w.shoves[s];
        const step = Math.min(shove.left, shoveSpeed * dt);
        shove.target.x = clamp(shove.target.x + shove.dir * step, world.left + 24, world.right - 24);
        shove.left -= step;
        if (shove.left <= 0.01 || isDead(shove.target)) w.shoves.splice(s, 1);
      }

      if (w.r >= w.maxR && w.shoves.length === 0) world.shockwaves.splice(i, 1);
    }
  }

  /* ═════════════════════════ CLONE HIT DETECTION ═════════════════════════ */

  // Call this from your melee code. Returns true when the swing hit a clone
  // (so you can skip hitting the real fighter with the same swing).
  function hitClone(attacker, point, radius, world) {
    if (!world || !world.clones) return false;
    let best = null, bestDist = Infinity;
    for (const c of world.clones) {
      if (c.ownerId === attacker.id || c.spawnT > 0) continue;   // can't hit it while it materialises
      const d = Math.hypot(c.x - point[0], c.y - 58 - point[1]);
      if (d < 46 + radius && d < bestDist) { best = c; bestDist = d; }
    }
    if (!best) return false;
    damageClone(world, best, Number(attacker.dmg) || 1, attacker.x, 260);
    effect(world, 'impact', point[0], point[1], 0.3, { color: COLORS.CLONE });
    return true;
  }

  /* ═════════════════════════ OPTIONAL GAME-LOOP HELPERS ═════════════════════════ */

  function getCooldownRatio(fighter) {
    const cfg = fighter && CONFIG[fighter.power];
    return cfg ? clamp(1 - fighter.powerCooldown / cfg.cooldown, 0, 1) : 0;
  }

  // One place for every stat modifier a power can apply to a fighter.
  function getModifiers(fighter) {
    const m = { move: 1, attackSpeed: 1, damage: 1, knockback: 1 };
    if (!fighter) return m;
    if (fighter.freezeT > 0) { m.move = 0; m.attackSpeed = 0; return m; }
    if (fighter.dashT > 0) m.move *= CONFIG.DASH.speedMultiplier;
    if (fighter.slowT > 0) { m.move *= CONFIG['TIME SLOW'].speedFactor; m.attackSpeed *= CONFIG['TIME SLOW'].speedFactor; }
    if (fighter.berserkT > 0) {
      const b = CONFIG.BERSERK;
      m.move *= b.movementMultiplier;
      m.attackSpeed *= b.attackSpeedMultiplier;
      m.damage *= b.damageMultiplier;
      m.knockback *= b.knockbackMultiplier;
    }
    return m;
  }

  function getPullVelocity(target, puller) {
    if (!(target.pullT > 0) || !puller) return 0;
    if (Math.abs(puller.x - target.x) < 70) return 0;    // stop just in front of the puller
    return Math.sign(puller.x - target.x) * CONFIG.PULL.speed;
  }

  /* ═══════════════════════════════ DRAWING ═══════════════════════════════ */

  const ring = (ctx, x, y, r) => { ctx.beginPath(); ctx.arc(x, y, Math.max(0.1, r), 0, TAU); ctx.stroke(); };
  const ellipseStroke = (ctx, x, y, rx, ry) => { ctx.beginPath(); ctx.ellipse(x, y, Math.max(0.1, rx), Math.max(0.1, ry), 0, 0, TAU); ctx.stroke(); };
  const glow = (ctx, color, blur) => { ctx.strokeStyle = color; ctx.fillStyle = color; ctx.shadowColor = color; ctx.shadowBlur = blur; };
  const rand01 = (seed, n) => { const s = Math.sin(seed * 12.9898 + n * 78.233) * 43758.5453; return s - Math.floor(s); };

  function rays(ctx, x, y, r0, r1, n, rot) {
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const a = rot + (i / n) * TAU;
      ctx.moveTo(x + Math.cos(a) * r0, y + Math.sin(a) * r0);
      ctx.lineTo(x + Math.cos(a) * r1, y + Math.sin(a) * r1);
    }
    ctx.stroke();
  }

  // Stick figure drawn at the feet, facing +x. Used by clones and dash afterimages.
  function stickFigure(ctx, phase, reach, lean) {
    const s = Math.sin(phase);
    ctx.beginPath();
    ctx.moveTo(-3, -46); ctx.lineTo(-10 + s * 13, -24); ctx.lineTo(-14 + s * 22, 0);
    ctx.moveTo(3, -46); ctx.lineTo(10 - s * 13, -25); ctx.lineTo(14 - s * 22, 0);
    ctx.moveTo(lean, -81); ctx.lineTo(0, -46);
    ctx.moveTo(lean * 0.9, -75); ctx.lineTo(-12 - s * 4 + lean, -61);
    ctx.moveTo(lean * 0.9, -75); ctx.lineTo(10 + lean, -65); ctx.lineTo(reach + lean, -69);
    ctx.stroke();
    ctx.beginPath(); ctx.arc(lean * 1.2, -94, 13, 0, TAU); ctx.stroke();
  }

  function iceFigure(ctx, fillAlpha) {
    ctx.fillStyle = 'rgba(90,220,255,' + fillAlpha + ')';
    ctx.strokeStyle = '#a9f2ff';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(-25, 0); ctx.lineTo(-20, -71); ctx.lineTo(-11, -86);
    ctx.lineTo(11, -86); ctx.lineTo(20, -71); ctx.lineTo(25, 0);
    ctx.closePath(); ctx.fill(); ctx.stroke();
    ctx.beginPath(); ctx.arc(0, -94, 13, 0, TAU); ctx.fill(); ctx.stroke();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = 'rgba(255,255,255,.6)';
    ctx.beginPath();
    ctx.moveTo(-20, -71); ctx.lineTo(0, -40); ctx.lineTo(20, -71);
    ctx.moveTo(0, -86); ctx.lineTo(0, -40);
    ctx.moveTo(-11, -86); ctx.lineTo(-4, -40);
    ctx.stroke();
    ctx.lineWidth = 3;
    ctx.strokeStyle = '#ffffff';
    ctx.beginPath(); ctx.moveTo(-14, -80); ctx.lineTo(-17, -58); ctx.moveTo(-6, -102); ctx.lineTo(-9, -96); ctx.stroke();
  }

  /* ── one-shot effects ── */

  function drawEffect(ctx, v) {
    const p = 1 - clamp(v.life / v.maxLife, 0, 1);   // progress 0 → 1
    const a = 1 - p;
    const col = v.color || '#75eaff';
    const dir = v.dir || 1;
    ctx.save();
    ctx.globalAlpha = a;
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    glow(ctx, col, 12);
    switch (v.type) {
      case 'teleport': {
        const w = 4 + 22 * a;
        const g = ctx.createLinearGradient(0, v.y - 150, 0, v.y);
        g.addColorStop(0, 'rgba(255,255,255,0)');
        g.addColorStop(1, col);
        ctx.fillStyle = g;
        ctx.globalAlpha = a * 0.8;
        ctx.fillRect(v.x - w / 2, v.y - 150, w, 150);
        ctx.globalAlpha = a;
        ellipseStroke(ctx, v.x, v.y, 14 + p * 44, 5 + p * 12);
        ctx.fillStyle = '#ffffff';
        for (let i = 0; i < 7; i++) {
          const r1 = rand01(v.seed, i), r2 = rand01(v.seed, i + 20);
          ctx.fillRect(v.x + (r1 - 0.5) * 56, v.y - p * 130 * (0.4 + r2), 3, 3 + r2 * 5);
        }
        break;
      }
      case 'muzzle':
        ring(ctx, v.x, v.y, 6 + p * 24);
        rays(ctx, v.x, v.y, 6, 14 + p * 24, 6, v.seed * 6);
        break;
      case 'spark':
        ctx.beginPath(); ctx.arc(v.x, v.y, 1 + 4 * a, 0, TAU); ctx.fill();
        break;
      case 'impact':
        ring(ctx, v.x, v.y, 14 + p * 30);
        rays(ctx, v.x, v.y, 8 + p * 12, 18 + p * 40, 8, v.seed * 6);
        break;
      case 'dash':
        for (let i = 0; i < 5; i++) {
          const yy = v.y + (i - 2) * 13, len = 34 + rand01(v.seed, i) * 40;
          const x0 = v.x - dir * (8 + p * 34);
          ctx.beginPath(); ctx.moveTo(x0, yy); ctx.lineTo(x0 - dir * len, yy); ctx.stroke();
        }
        break;
      case 'slow': {
        ring(ctx, v.x, v.y, 10 + p * 56);
        ring(ctx, v.x, v.y, 18);
        const ang = -p * TAU * 1.5 - Math.PI / 2;
        ctx.beginPath();
        ctx.moveTo(v.x, v.y); ctx.lineTo(v.x + Math.cos(ang) * 14, v.y + Math.sin(ang) * 14);
        ctx.moveTo(v.x, v.y); ctx.lineTo(v.x + Math.cos(ang * 0.2) * 9, v.y + Math.sin(ang * 0.2) * 9);
        ctx.stroke();
        break;
      }
      case 'pull':
        for (let i = 0; i < 6; i++) {
          const ang = v.seed * TAU + (i / 6) * TAU, r = 78 * (1 - p) + 16;
          ctx.beginPath();
          ctx.moveTo(v.x + Math.cos(ang) * r, v.y + Math.sin(ang) * r);
          ctx.lineTo(v.x + Math.cos(ang) * (r + 16), v.y + Math.sin(ang) * (r + 16));
          ctx.stroke();
        }
        break;
      case 'clone':
        ring(ctx, v.x, v.y, 8 + p * 40);
        ring(ctx, v.x, v.y, 4 + p * 22);
        for (let i = 0; i < 6; i++) {
          const r1 = rand01(v.seed, i);
          ctx.fillRect(v.x + (r1 - 0.5) * 50, v.y + 40 - p * 90 * (0.5 + r1), 3, 3);
        }
        break;
      case 'invisible':
        ring(ctx, v.x, v.y, 52 * (1 - p) + 6);
        for (let i = 0; i < 6; i++) {
          const ang = (i / 6) * TAU + p * 2, r = 20 + p * 34;
          ctx.fillRect(v.x + Math.cos(ang) * r, v.y + Math.sin(ang) * r, 3, 3);
        }
        break;
      case 'freeze':
        ring(ctx, v.x, v.y, 12 + p * 40);
        for (let i = 0; i < 6; i++) {
          const ang = (i / 6) * TAU + p * 0.6, len = 16 + p * 34;
          const ex = v.x + Math.cos(ang) * len, ey = v.y + Math.sin(ang) * len;
          ctx.beginPath(); ctx.moveTo(v.x, v.y); ctx.lineTo(ex, ey);
          const bx = v.x + Math.cos(ang) * len * 0.6, by = v.y + Math.sin(ang) * len * 0.6;
          ctx.moveTo(bx, by); ctx.lineTo(bx + Math.cos(ang + 0.7) * 8, by + Math.sin(ang + 0.7) * 8);
          ctx.moveTo(bx, by); ctx.lineTo(bx + Math.cos(ang - 0.7) * 8, by + Math.sin(ang - 0.7) * 8);
          ctx.stroke();
        }
        break;
      case 'berserk':
        ring(ctx, v.x, v.y, 10 + p * 44);
        ctx.lineWidth = 5;
        rays(ctx, v.x, v.y, 14 + p * 20, 30 + p * 50, 10, v.seed * 6);
        break;
      case 'trap':
        ellipseStroke(ctx, v.x, v.y + 10, 10 + p * 40, 3 + p * 7);
        for (let i = 0; i < 5; i++) {
          const r1 = rand01(v.seed, i);
          ctx.fillRect(v.x + (r1 - 0.5) * 50, v.y + 8 - p * 30 * (0.4 + r1), 3, 3);
        }
        break;
      case 'cloneDeath':
        for (let i = 0; i < 12; i++) {
          const ang = rand01(v.seed, i) * TAU, d = p * (30 + rand01(v.seed, i + 30) * 60);
          const sx = v.x + Math.cos(ang) * d, sy = v.y + Math.sin(ang) * d;
          ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(sx + Math.cos(ang) * 8, sy + Math.sin(ang) * 8); ctx.stroke();
        }
        ring(ctx, v.x, v.y, 10 + p * 36);
        break;
      case 'swap': {
        const x0 = v.x, x1 = v.x2, y0 = v.y - 60;
        const mx = (x0 + x1) / 2, lift = 40 + Math.abs(x1 - x0) * 0.12;
        ctx.beginPath(); ctx.moveTo(x0, y0); ctx.quadraticCurveTo(mx, y0 - lift, x1, y0); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(x0, y0); ctx.quadraticCurveTo(mx, y0 + lift * 0.5, x1, y0); ctx.stroke();
        const u = clamp(p * 1.4, 0, 1);                              // two sparks race across, crossing paths
        const q = (s, a0, c, a1) => (1 - s) * (1 - s) * a0 + 2 * (1 - s) * s * c + s * s * a1;
        ctx.beginPath(); ctx.arc(q(u, x0, mx, x1), q(u, y0, y0 - lift, y0), 6, 0, TAU); ctx.fill();
        ctx.beginPath(); ctx.arc(q(u, x1, mx, x0), q(u, y0, y0 + lift * 0.5, y0), 6, 0, TAU); ctx.fill();
        break;
      }
      case 'shockBurst':
        ctx.globalAlpha = a * 0.7;
        ctx.beginPath(); ctx.arc(v.x, v.y, 10 + p * 40, Math.PI, TAU); ctx.fill();   // flash at the caster's feet
        ctx.globalAlpha = a;
        ctx.lineWidth = 4;
        rays(ctx, v.x, v.y - 10, 16 + p * 30, 34 + p * 50, 12, v.seed * 6);
        break;
      case 'ready':
        ellipseStroke(ctx, v.x, v.y, 16 + p * 30, 5 + p * 8);
        ctx.beginPath();
        ctx.moveTo(v.x - 8, v.y - 4 - p * 30); ctx.lineTo(v.x, v.y - 12 - p * 30); ctx.lineTo(v.x + 8, v.y - 4 - p * 30);
        ctx.stroke();
        break;
      case 'ghost':
        ctx.globalAlpha = a * 0.4;
        ctx.translate(v.x, v.y);
        ctx.scale(dir, 1);
        ctx.lineWidth = 5;
        ctx.lineJoin = 'round';
        stickFigure(ctx, v.phase || 0, 18, 6);
        break;
      case 'label':
        ctx.globalAlpha = clamp(a * 1.7, 0, 1);
        ctx.font = 'bold 15px system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.lineWidth = 4;
        ctx.shadowBlur = 0;
        ctx.strokeStyle = 'rgba(0,0,0,.65)';
        ctx.strokeText(v.text || '', v.x, v.y - p * 28);
        ctx.fillStyle = col;
        ctx.fillText(v.text || '', v.x, v.y - p * 28);
        break;
      default:
        ring(ctx, v.x, v.y, 12 + p * 36);
    }
    ctx.restore();
  }

  /* ── world objects ── */

  function drawTrap(ctx, trap, t) {
    const cfg = CONFIG.TRAP;
    const armed = !(trap.armT > 0);
    const blink = trap.life < 2 ? (Math.sin(t * 20) > 0 ? 1 : 0.35) : 1;
    ctx.save();
    ctx.globalAlpha = (armed ? 0.95 : 0.85) * blink;
    if (armed) {                                                   // pulsing danger zone
      ctx.save();
      ctx.globalAlpha *= 0.3 + 0.2 * Math.sin(t * 6);
      ctx.strokeStyle = COLORS.TRAP; ctx.lineWidth = 2;
      ellipseStroke(ctx, trap.x, trap.y - 1, cfg.triggerRadius, 7);
      ctx.restore();
    }
    ctx.fillStyle = '#2a1318';
    ctx.beginPath(); ctx.ellipse(trap.x, trap.y - 1, 20, 5, 0, 0, TAU); ctx.fill();
    ctx.fillStyle = COLORS.TRAP;
    ctx.strokeStyle = '#ffd2d8';
    ctx.lineWidth = 2;
    ctx.shadowColor = COLORS.TRAP;
    ctx.shadowBlur = armed ? 12 : 4;
    for (const [dx, h] of [[-12, 15], [0, 22], [12, 15]]) {
      ctx.beginPath();
      ctx.moveTo(trap.x + dx - 6, trap.y - 1);
      ctx.lineTo(trap.x + dx, trap.y - 1 - h);
      ctx.lineTo(trap.x + dx + 6, trap.y - 1);
      ctx.closePath(); ctx.fill(); ctx.stroke();
    }
    ctx.restore();
  }

  function drawStatue(ctx, s, t) {
    const cfg = CONFIG.FREEZE;
    const fade = clamp(s.life / 1.2, 0, 1);
    ctx.save();
    ctx.globalAlpha = fade * (s.armed ? 0.55 + 0.2 * Math.sin(t * 6) : 0.22);   // re-freeze zone
    ctx.strokeStyle = COLORS.FREEZE; ctx.lineWidth = 2;
    ctx.setLineDash([5, 5]); ctx.lineDashOffset = -t * 12;
    ellipseStroke(ctx, s.x, s.y, cfg.statueRadius, cfg.statueRadius * 0.28);
    ctx.restore();
    ctx.save();
    ctx.translate(s.x, s.y);
    ctx.scale(s.facing || 1, 1);
    ctx.globalAlpha = Math.min(0.88, s.life / 1.2);
    ctx.shadowColor = '#57dcff'; ctx.shadowBlur = 16;
    iceFigure(ctx, 0.32);
    ctx.restore();
  }

  function drawClone(ctx, c, t) {
    const cfg = CONFIG.CLONE;
    const spawn = c.spawnMax > 0 ? 1 - clamp(c.spawnT / c.spawnMax, 0, 1) : 1;
    const fadeOut = clamp(c.life / 0.5, 0, 1);
    const flicker = c.life < 1 ? (Math.sin(t * 60) > 0 ? 1 : 0.45) : 0.9 + 0.1 * Math.sin(t * 31 + c.x);
    const alpha = 0.62 * spawn * fadeOut * flicker;
    const flash = c.hurtFlash > 0;

    ctx.save();                                                   // ground shadow
    ctx.globalAlpha = alpha * 0.6;
    ctx.fillStyle = 'rgba(0,0,0,.35)';
    ctx.beginPath(); ctx.ellipse(c.x, c.y + 2, 22, 6, 0, 0, TAU); ctx.fill();
    ctx.restore();

    ctx.save();
    ctx.translate(c.x, c.y);
    ctx.scale(c.facing || 1, 0.6 + 0.4 * spawn);                  // stretches up as it materialises
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = flash ? '#ffffff' : COLORS.CLONE;
    ctx.shadowColor = COLORS.CLONE;
    ctx.shadowBlur = flash ? 22 : 14;
    ctx.lineWidth = 5;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    let reach = 13, lean = 0;
    const striking = c.attackT > 0 && cfg.attackDuration - c.attackT >= cfg.windup;
    if (c.attackT > 0) {
      const elapsed = cfg.attackDuration - c.attackT;
      if (elapsed < cfg.windup) {                                 // wind-up: arm pulls back (the tell)
        const w = elapsed / cfg.windup;
        reach = lerp(13, -9, w); lean = -5 * w;
      } else { reach = 38; lean = 7; }
    } else if (c.staggerT > 0) { reach = 2; lean = -9; }
    stickFigure(ctx, c.walkT, reach, lean);

    if (striking) {                                               // slash arc
      ctx.globalAlpha = alpha * 1.3;
      ctx.lineWidth = 4;
      ctx.beginPath(); ctx.arc(24, -68, 36, -1.0, 0.9); ctx.stroke();
    }
    ctx.restore();

    // bars + status
    ctx.save();
    ctx.globalAlpha = clamp(alpha * 1.8, 0, 1);
    ctx.fillStyle = 'rgba(8,14,26,.8)';
    ctx.fillRect(c.x - 16, c.y - 124, 32, 5);
    ctx.fillStyle = COLORS.CLONE;
    ctx.fillRect(c.x - 15, c.y - 123, 30 * clamp(c.health / c.maxHealth, 0, 1), 3);
    ctx.fillStyle = 'rgba(255,255,255,.55)';
    ctx.fillRect(c.x - 15, c.y - 118, 30 * clamp(c.life / c.maxLife, 0, 1), 1.5);
    if (c.searching) {
      ctx.fillStyle = COLORS.CLONE;
      ctx.font = 'bold 16px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('?', c.x, c.y - 132);
    }
    ctx.restore();
  }

  function drawProjectile(ctx, p, t) {
    const trail = p.trail || EMPTY;
    const dir = Math.sign(p.vx) || 1;
    ctx.save();
    ctx.lineCap = 'round';
    ctx.strokeStyle = COLORS.PROJECTILE;
    ctx.shadowColor = COLORS.PROJECTILE;
    ctx.shadowBlur = 16;
    for (let i = 1; i < trail.length; i++) {                      // tapering comet tail
      const k = i / trail.length;
      ctx.globalAlpha = k * 0.55;
      ctx.lineWidth = 3 + k * 14;
      ctx.beginPath(); ctx.moveTo(trail[i - 1].x, trail[i - 1].y); ctx.lineTo(trail[i].x, trail[i].y); ctx.stroke();
    }
    ctx.globalAlpha = 0.9;
    ctx.fillStyle = COLORS.PROJECTILE;
    ctx.shadowBlur = 24;
    ctx.beginPath(); ctx.arc(p.x, p.y, 13, 0, TAU); ctx.fill();
    ctx.shadowBlur = 0;
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#ffffff';
    ctx.beginPath(); ctx.arc(p.x, p.y, 6, 0, TAU); ctx.fill();
    ctx.globalAlpha = 0.8;
    ctx.strokeStyle = '#d8fbff';
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 5]); ctx.lineDashOffset = -t * 60 * dir;
    ring(ctx, p.x, p.y, 19);
    ctx.restore();
  }

  function drawShockwave(ctx, w) {
    if (w.r < 1) return;
    const k = clamp(w.r / w.maxR, 0, 1);              // 0 → 1 as the dome grows
    const a = 1 - k * k;                              // fades out near the edge
    ctx.save();
    ctx.globalAlpha = a;
    const g = ctx.createRadialGradient(w.x, w.y, w.r * 0.45, w.x, w.y, w.r);
    g.addColorStop(0, 'rgba(5,6,8,0.08)');
    g.addColorStop(1, 'rgba(5,6,8,0.88)');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(w.x, w.y, w.r, Math.PI, TAU); ctx.closePath(); ctx.fill();   // dome body

    glow(ctx, '#aeb8ca', 18);
    ctx.lineCap = 'round';
    ctx.lineWidth = 3 + 9 * (1 - k);                  // bright rim thins as it spreads
    ctx.beginPath(); ctx.arc(w.x, w.y, w.r, Math.PI, TAU); ctx.stroke();

    glow(ctx, '#626d80', 8);
    ctx.lineWidth = 2;                                  // two echo rings trailing behind the rim
    for (let i = 1; i <= 2; i++) {
      const rr = w.r - i * 16;
      if (rr > 6) {
        ctx.globalAlpha = a * (0.5 - i * 0.15);
        ctx.beginPath(); ctx.arc(w.x, w.y, rr, Math.PI, TAU); ctx.stroke();
      }
    }

    ctx.strokeStyle = '#aeb8ca';
    ctx.shadowColor = '#aeb8ca';
    ctx.shadowBlur = 8;
    ctx.globalAlpha = a * 0.8;                        // floor ripple + dust streaks
    ctx.lineWidth = 3;
    ellipseStroke(ctx, w.x, w.y, w.r, w.r * 0.1);
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let i = 0; i < 12; i++) {
      const side = i % 2 ? 1 : -1;
      const d = w.r * (0.3 + 0.7 * rand01(w.seed, i)), yy = w.y - 3 - rand01(w.seed, i + 40) * 6;
      ctx.moveTo(w.x + side * d, yy); ctx.lineTo(w.x + side * (d + 22), yy);
    }
    ctx.stroke();
    ctx.restore();
  }

  /* ── fighter auras ── */

  function drawBerserkAura(ctx, f, t) {
    const k = clamp(f.berserkT / 0.5, 0, 1);
    const pulse = 0.5 + 0.5 * Math.sin(t * 14);
    ctx.save();
    ctx.globalAlpha = (0.35 + 0.2 * pulse) * k;
    const g = ctx.createRadialGradient(f.x, f.y - 60, 8, f.x, f.y - 60, 80);
    g.addColorStop(0, 'rgba(255,120,40,.6)');
    g.addColorStop(1, 'rgba(255,60,20,0)');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.ellipse(f.x, f.y - 60, 60, 86, 0, 0, TAU); ctx.fill();
    ctx.globalAlpha = 0.75 * k;
    ctx.fillStyle = COLORS.BERSERK;
    ctx.shadowColor = '#ff5a1f'; ctx.shadowBlur = 12;
    for (let i = 0; i < 7; i++) {                                  // flames licking up from the feet
      const bx = f.x - 24 + i * 8;
      const h = 30 + 22 * Math.abs(Math.sin(t * 16 + i * 1.9));
      const sway = Math.sin(t * 11 + i) * 4;
      ctx.beginPath(); ctx.moveTo(bx - 5, f.y); ctx.lineTo(bx + sway, f.y - h); ctx.lineTo(bx + 5, f.y); ctx.fill();
    }
    ctx.restore();
  }

  function drawDashAura(ctx, f, t) {
    const dir = f.facing || 1;
    const k = clamp(f.dashT / 0.3, 0, 1);
    ctx.save();
    ctx.globalAlpha = 0.6 * k;
    glow(ctx, COLORS.DASH, 10);
    ctx.lineWidth = 3; ctx.lineCap = 'round';
    for (let i = 0; i < 4; i++) {                                  // speed lines trailing behind
      const yy = f.y - 22 - i * 25;
      const len = 34 + 30 * rand01(i + 1, Math.floor(t * 18));
      ctx.beginPath(); ctx.moveTo(f.x - dir * 22, yy); ctx.lineTo(f.x - dir * (22 + len), yy); ctx.stroke();
    }
    ctx.restore();
  }

  function drawSlowAura(ctx, f, t) {
    const k = clamp(f.slowT / 0.4, 0, 1);
    ctx.save();
    glow(ctx, COLORS['TIME SLOW'], 10);
    ctx.lineWidth = 2.5;
    const r = (t * 0.8) % 1;                                       // slow, heavy ripple on the floor
    ctx.globalAlpha = 0.7 * k * (1 - r);
    ellipseStroke(ctx, f.x, f.y, 20 + r * 50, 5 + r * 12);
    ctx.globalAlpha = 0.85 * k;                                    // clock above the head, hands run backwards
    ring(ctx, f.x, f.y - 148, 13);
    ctx.beginPath();
    ctx.moveTo(f.x, f.y - 148); ctx.lineTo(f.x + Math.cos(-t * 1.5 - 1.57) * 9, f.y - 148 + Math.sin(-t * 1.5 - 1.57) * 9);
    ctx.moveTo(f.x, f.y - 148); ctx.lineTo(f.x + Math.cos(-t * 0.2 - 1.57) * 6, f.y - 148 + Math.sin(-t * 0.2 - 1.57) * 6);
    ctx.stroke();
    ctx.restore();
  }

  function drawPullTethers(ctx, fighters, t) {
    for (const target of fighters) {
      if (!(target.pullT > 0)) continue;
      const puller = fighters.find(f => f.id === target.pullTargetId);
      if (!puller) continue;
      const x0 = puller.x, y0 = puller.y - 62, x1 = target.x, y1 = target.y - 62;
      ctx.save();
      ctx.globalAlpha = clamp(target.pullT / 0.2, 0, 1) * 0.9;
      glow(ctx, COLORS.PULL, 12);
      ctx.lineWidth = 3; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      ctx.beginPath();
      for (let i = 0; i <= 14; i++) {                              // crackling energy cable
        const u = i / 14;
        const x = lerp(x0, x1, u);
        const y = lerp(y0, y1, u) + Math.sin(u * 12 - t * 30) * 9 * Math.sin(u * Math.PI);
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
      ring(ctx, x1, y1, 20);                                       // grip on the victim
      const dir = Math.sign(x0 - x1) || 1;
      for (let k = 0; k < 4; k++) {                                // chevrons flowing toward the puller
        const u = (t * 2.2 + k / 4) % 1;
        const x = lerp(x1, x0, u), y = lerp(y1, y0, u);
        ctx.beginPath();
        ctx.moveTo(x - dir * 6, y - 6); ctx.lineTo(x, y); ctx.lineTo(x - dir * 6, y + 6);
        ctx.stroke();
      }
      ctx.restore();
    }
  }

  function drawFreezeShell(ctx, f, t) {
    const k = clamp(f.freezeT / 0.3, 0, 1);
    ctx.save();
    ctx.translate(f.x, f.y);
    ctx.scale(1.12, 1.08);
    ctx.globalAlpha = 0.5 * k;
    ctx.shadowColor = '#57dcff'; ctx.shadowBlur = 18;
    iceFigure(ctx, 0.28);
    if (f.freezeT < 0.6) {                                          // cracks appear right before it thaws
      ctx.globalAlpha = 0.9 * k;
      ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(-6, -90); ctx.lineTo(2, -72); ctx.lineTo(-4, -58); ctx.lineTo(8, -40);
      ctx.moveTo(14, -78); ctx.lineTo(6, -62);
      ctx.stroke();
    }
    ctx.restore();
  }

  function drawInvisibleShimmer(ctx, f, t) {
    const fade = clamp(f.invisibleT / 0.5, 0, 1);
    ctx.save();
    ctx.globalAlpha = (0.14 + 0.1 * Math.sin(t * 9)) * fade + 0.04;
    ctx.strokeStyle = COLORS.INVISIBILITY; ctx.lineWidth = 2;
    ctx.setLineDash([6, 6]); ctx.lineDashOffset = -t * 30;
    ellipseStroke(ctx, f.x, f.y - 56, 22, 64);
    ctx.setLineDash([]);
    ctx.globalAlpha *= 1.4;
    for (let i = 0; i < 3; i++) {                                   // heat-haze ripples
      const yy = f.y - 30 - i * 30;
      ctx.beginPath();
      for (let x = -18; x <= 18; x += 4) {
        const y = yy + Math.sin(x * 0.4 + t * 8 + i) * 2.5;
        if (x === -18) ctx.moveTo(f.x + x, y); else ctx.lineTo(f.x + x, y);
      }
      ctx.stroke();
    }
    ctx.restore();
  }

  /* ── entry points ── */

  // Everything that should appear BEHIND the fighters.
  function drawBack(ctx, world) {
    if (!world) return;
    const t = world.fxTime || 0;
    const fighters = world.fighters || EMPTY;
    for (const trap of world.traps || EMPTY) drawTrap(ctx, trap, t);
    for (const statue of world.statues || EMPTY) drawStatue(ctx, statue, t);
    for (const f of fighters) {
      if (f.berserkT > 0) drawBerserkAura(ctx, f, t);
      if (f.dashT > 0) drawDashAura(ctx, f, t);
      if (f.slowT > 0) drawSlowAura(ctx, f, t);
    }
    drawPullTethers(ctx, fighters, t);
    for (const clone of world.clones || EMPTY) drawClone(ctx, clone, t);
  }

  // Everything that should appear IN FRONT of the fighters.
  function drawFront(ctx, world) {
    if (!world) return;
    const t = world.fxTime || 0;
    for (const f of world.fighters || EMPTY) {
      if (f.freezeT > 0) drawFreezeShell(ctx, f, t);
      if (f.invisibleT > 0) drawInvisibleShimmer(ctx, f, t);
    }
    for (const w of world.shockwaves || EMPTY) drawShockwave(ctx, w);
    for (const p of world.projectiles || EMPTY) drawProjectile(ctx, p, t);
    for (const v of world.effects || EMPTY) drawEffect(ctx, v);
  }

  function draw(ctx, world) {
    drawBack(ctx, world);
    drawFront(ctx, world);
  }

  return Object.freeze({
    CONFIG,
    COLORS,
    NAMES,
    assignRound,
    resetFighter,
    resetRound,
    activate,
    damageMultiplier,
    update,
    hitClone,
    draw,
    drawBack,
    drawFront,
    getCooldownRatio,
    getModifiers,
    getPullVelocity,
    clamp
  });
});