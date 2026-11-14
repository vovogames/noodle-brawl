// =====================================================================================================================
// sim.js — the rules of the noodle brawler.
//
// Everything that decides the outcome of a fight lives here: movement, moves and their frame data, damage, hitstun,
// knockback distance, enemy AI and waves. The game advances in fixed 60 Hz steps; one step reads one input bitmask.
// There is no wall clock and no Math.random(), so the same list of inputs always produces exactly the same fight.
//
// The six "feel" switches (fx.js) only read this state. They must never change it: test.cjs replays one run with every
// combination of switches and compares N.hash(world) at the end.
//
// Coordinates: pixels, y grows downward, the ground is the line y = C.GY. A fighter's (x, y) is the point between its feet.
//
// Exposed on the global NOODLE object (N):
//   N.K       input bits            N.world(seed, opts)   make a new world
//   N.C       tuning constants      N.step(world, mask)   advance one step, returns that step's events
//   N.MOVES   attacks + frame data  N.hash(world)         fingerprint of the battle state
//   N.TYPES   fighter types         N.hurtbox / N.attackBox / N.alive   helpers used by the drawing code
//   N.LEVELS  wave layouts          N.rng(seed)           a small seeded random generator (for decoration)
// =====================================================================================================================
(function (global) {
  const N = (global.NOODLE = global.NOODLE || {});

  // Input bits, one per button. A step's input is these OR-ed together (e.g. K.R | K.A = moving right and jabbing).
  const K = (N.K = {
    L: 1, //  left
    R: 2, //  right
    J: 4, //  jump
    A: 8, //  light punch (jab)
    B: 16, // heavy punch
    D: 32, // dash
  });

  // Tuning constants. Speeds are pixels per step, times are in steps (1/60 s).
  const C = (N.C = {
    GY: 880, //               y of the ground line
    WORLD: [80, 4300], //     left / right edge of the short (film) level
    GRAV: 1.15, //            gravity while rising
    FALL: 1.45, //            gravity while falling (a bit heavier: snappier jumps)
    CUTG: 2.6, //             gravity while rising after the jump button was released (variable jump height)
    JUMPV: -21.5, //          jump take-off speed
    COYOTE: 6, //             steps after running off an edge during which a jump still counts
    BUFFER: 6, //             steps a button press is remembered before it can be used
    RUNMAX: 8.5, //           top run speed
    ACC: 1.15, //             run acceleration on the ground
    AIRACC: 0.75, //          steering acceleration in the air
    FRIC: 1.5, //             slow-down on the ground with no direction held
    DASHV: 21, //             dash speed at the start
    DASHF: 11, //             dash length in steps
    DASHCD: 26, //            dash cooldown
    INV: 40, //               player's invulnerable steps after being hit
    KO: 50, //                steps an enemy lies down before it breaks apart
    PKO: 100, //              steps the player lies down before getting up
  });

  // Attacks. Frame data: `start` = wind-up steps, `active` = steps the hitbox exists, `rec` = recovery steps.
  // `box` = hitbox [x0, y0, x1, y1] relative to the feet (x mirrored by facing). `dmg` damage, `stun` hitstun steps,
  // `push` total knockback distance. `pose` names the key pose in noodle.js. `step` = forward lunge speed during the hit.
  const MOVES = (N.MOVES = {
    LIGHT: { start: 4, active: 3, rec: 10, dmg: 8, stun: 14, push: 26, box: [22, -172, 92, -128], pose: 'jab', air: true },
    HEAVY: { start: 11, active: 4, rec: 18, dmg: 20, stun: 26, push: 74, box: [19, -180, 118, -116], pose: 'cross', step: 3.4 },
    G_JAB: { start: 16, active: 3, rec: 22, dmg: 6, stun: 18, push: 40, box: [18, -168, 84, -128], pose: 'jab' },
    F_SLAM: { start: 24, active: 4, rec: 28, dmg: 12, stun: 22, push: 70, box: [16, -176, 104, -100], pose: 'cross', step: 2 },
    S_SWING: { start: 20, active: 4, rec: 24, dmg: 10, stun: 20, push: 56, box: [10, -210, 150, -96], pose: 'swing' },
  });

  // Fighter types. `w` × `h` = hurtbox size. Enemies also have a walk `speed`, their attack `move`, the `range` they
  // attack from, and `take` = how much of a hit's stun and push they receive (the fat one only takes 55%: it's heavy).
  const TYPES = (N.TYPES = {
    player: { hp: 100, w: 56, h: 194 },
    grunt: { hp: 16, speed: 3.6, w: 56, h: 194, move: 'G_JAB', range: 74, take: 1 },
    fat: { hp: 56, speed: 2.3, w: 84, h: 200, move: 'F_SLAM', range: 92, take: 0.55 },
    stick: { hp: 36, speed: 3.0, w: 56, h: 194, move: 'S_SWING', range: 136, take: 0.85 },
  });

  // Waves. When the player walks past `at`, the camera locks onto one screen ([at − 520, at − 520 + ARENA]) and the
  // wave's enemies walk in from both sides. Each foe entry is [kind, side (+1 = from the right, −1 = from the left), hp?].
  const ARENA = (N.ARENA = 1477); // = view width / zoom in draw.js: exactly one screen
  N.WAVES = [
    { at: 1100, foes: [['grunt', 1], ['grunt', -1], ['grunt', 1]] },
    { at: 2300, foes: [['fat', 1], ['grunt', -1], ['grunt', 1]] },
    { at: 3500, foes: [['stick', 1], ['grunt', -1], ['grunt', 1], ['grunt', -1]] },
  ];
  // `film`: the short level the video was cut from (its recorded runs depend on it — don't change it).
  // `full`: the playable level, 5 waves; the first foe of the last wave is the boss (a fat one with 140 hp).
  N.LEVELS = {
    film: { waves: N.WAVES, end: 4300 },
    full: {
      end: 6900,
      waves: [
        { at: 1100, foes: [['grunt', 1], ['grunt', -1], ['grunt', 1], ['grunt', -1]] },
        { at: 2300, foes: [['fat', 1], ['grunt', -1], ['grunt', 1], ['grunt', -1]] },
        { at: 3500, foes: [['stick', 1], ['grunt', -1], ['fat', -1], ['grunt', 1]] },
        { at: 4700, foes: [['stick', 1], ['stick', -1], ['grunt', 1], ['grunt', -1], ['grunt', 1]] },
        { at: 5900, foes: [['fat', 1, 140], ['stick', -1], ['stick', 1], ['grunt', -1], ['grunt', 1]], boss: true },
      ],
    },
  };

  // ------------------------------------------------------------------------------------------------- fighters & world

  // A fighter. Short field names are used everywhere (also by the drawing code and the film), so here they are:
  //   st      state: 'idle' | 'run' | 'air' | 'dash' | 'attack' | 'hurt' | 'ko' | 'gone'
  //   t       steps spent in the current state (for attacks: the frame of the move)
  //   move    the attack being performed (a key of MOVES), hit = ids already hit by it (one hit per target per swing)
  //   face    +1 facing right, −1 facing left;   ground = standing on the ground;   coyote = see C.COYOTE
  //   stun    hitstun steps left;   kbv / kbn / kbi = knockback start speed / length in steps / steps done
  //   jbuf / abuf / bbuf = buffered jump / light / heavy presses (steps left);   cut = jump released early
  //   dashcd  dash cooldown;   inv = invulnerable steps;   ko = steps left lying down
  //   cool    enemy attack cooldown;   token = this enemy may attack now;   wave / slot = which wave, position in it
  function makeFighter(world, kind, team, x, face) {
    const type = TYPES[kind];
    return {
      id: world.nextId++, kind, team, x, y: C.GY, vx: 0, vy: 0, face, ground: true, coyote: 0,
      st: 'idle', t: 0, move: null, hit: [], hp: type.hp, maxhp: type.hp, stun: 0,
      kbv: 0, kbn: 0, kbi: 0, dashcd: 0, ko: 0, inv: 0,
      jbuf: 0, abuf: 0, bbuf: 0, cut: false, cool: 30, token: false, wave: -1, slot: 0,
    };
  }

  // Make a world. Options:
  //   level: 'film' (default) | 'full'
  //   For the film's staged shots: px = player x, foes = [[kind, x, hp?], …] placed at once (no waves),
  //   ai: false → foes just stand there, rise: true → knocked-out foes get up again, php = the player's hp.
  N.world = function (seed = 1, opts = {}) {
    const level = N.LEVELS[opts.level || 'film'];
    const world = {
      tick: 0, seed, rs: seed >>> 0, events: [], prev: 0, nextId: 0,
      wave: 0, lock: null, clear: 0, fighters: [], waves: level.waves, bounds: [C.WORLD[0], level.end],
      noAI: opts.ai === false, rise: !!opts.rise, noWaves: opts.waves === false || !!opts.foes,
    };
    world.fighters.push(makeFighter(world, 'player', 0, opts.px ?? 360, 1));
    if (opts.php) world.fighters[0].hp = opts.php;
    for (const [kind, x, hp] of opts.foes || []) {
      const foe = makeFighter(world, kind, 1, x, -1);
      foe.cool = 60;
      if (hp) foe.hp = foe.maxhp = hp;
      world.fighters.push(foe);
    }
    return world;
  };

  // The world's own random numbers (mulberry32), so enemy decisions replay exactly.
  function random(world) {
    let a = (world.rs = (world.rs + 0x6d2b79f5) | 0);
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  // ------------------------------------------------------------------------------------------------------- boxes

  // A move's hitbox in world coordinates: [left, top, right, bottom].
  function attackRect(fighter, box) {
    const a = fighter.x + fighter.face * box[0];
    const c = fighter.x + fighter.face * box[2];
    return [Math.min(a, c), fighter.y + box[1], Math.max(a, c), fighter.y + box[3]];
  }
  function hurtbox(fighter) {
    const type = TYPES[fighter.kind];
    return [fighter.x - type.w / 2, fighter.y - type.h, fighter.x + type.w / 2, fighter.y];
  }
  const overlap = (p, q) => p[0] < q[2] && q[0] < p[2] && p[1] < q[3] && q[1] < p[3];
  const alive = (fighter) => fighter.st !== 'ko' && fighter.st !== 'gone';

  N.hurtbox = hurtbox;
  N.alive = alive;
  // The hitbox of the attack being performed, or null outside its active frames.
  N.attackBox = (fighter) => {
    const move = fighter.st === 'attack' && MOVES[fighter.move];
    if (!move) return null;
    return fighter.t >= move.start && fighter.t < move.start + move.active ? attackRect(fighter, move.box) : null;
  };

  // --------------------------------------------------------------------------------------------- shared mechanics

  function startMove(world, fighter, name) {
    fighter.st = 'attack';
    fighter.move = name;
    fighter.t = 0;
    fighter.hit = [];
    fighter.abuf = fighter.bbuf = 0;
    world.events.push({ type: 'swing', id: fighter.id, move: name, tick: world.tick });
  }
  function endState(fighter) {
    fighter.st = fighter.ground ? 'idle' : 'air';
    fighter.move = null;
    fighter.t = 0;
  }

  // Gravity, movement, landing, coyote time, level edges.
  function physics(world, fighter) {
    const gravity = fighter.vy < 0 ? (fighter.cut ? C.CUTG : C.GRAV) : C.FALL;
    if (fighter.st !== 'dash') fighter.vy = Math.min(fighter.vy + gravity, 26);
    fighter.x += fighter.vx;
    fighter.y += fighter.vy;
    if (fighter.y >= C.GY) {
      if (!fighter.ground && fighter.vy > 2) world.events.push({ type: 'land', id: fighter.id, tick: world.tick, v: fighter.vy });
      fighter.y = C.GY;
      fighter.vy = 0;
      fighter.ground = true;
      fighter.cut = false;
    } else if (fighter.ground) {
      fighter.ground = false;
      fighter.coyote = C.COYOTE;
    }
    if (!fighter.ground && fighter.coyote > 0) fighter.coyote--;
    fighter.x = Math.max(world.bounds[0], Math.min(world.bounds[1], fighter.x));
  }

  // Knockback slows down linearly over the hitstun, so the total distance is exactly the move's `push`.
  // (How that movement *looks* — fast, then a little bounce — is fx.js's business; the end point is this.)
  function knockback(fighter) {
    if (fighter.kbi < fighter.kbn) {
      fighter.x += -fighter.face * fighter.kbv * (1 - fighter.kbi / fighter.kbn);
      fighter.kbi++;
    }
  }

  // Check an attacker's active hitbox against everyone on the other team and apply the hits.
  function resolveHits(world, attacker, move) {
    const hitRect = attackRect(attacker, move.box);
    for (const target of world.fighters) {
      if (target.team === attacker.team || !alive(target) || target.inv > 0) continue;
      if (attacker.hit.includes(target.id) || !overlap(hitRect, hurtbox(target))) continue;
      attacker.hit.push(target.id);

      const take = target.team === 0 ? 1 : TYPES[target.kind].take;
      const stun = Math.round(move.stun * (0.4 + 0.6 * take));
      const push = move.push * take;
      target.hp = Math.max(0, target.hp - move.dmg);
      target.face = -attacker.face; // turn to face the attacker
      target.st = 'hurt';
      target.t = 0;
      target.stun = stun;
      target.move = null;
      target.kbn = stun;
      target.kbi = 0;
      target.kbv = (2 * push) / (stun + 1);
      if (!target.ground) target.vy = Math.min(target.vy, -4);

      // the event carries the contact point (for hit marks) and whether this hit knocked the target out
      const hb = hurtbox(target);
      world.events.push({
        type: 'hit', tick: world.tick, att: attacker.id, def: target.id, move: attacker.move, dir: attacker.face,
        x: attacker.face > 0 ? Math.max(hb[0], hitRect[0]) + 6 : Math.min(hb[2], hitRect[2]) - 6,
        y: (Math.max(hitRect[1], hb[1]) + Math.min(hitRect[3], hb[3])) / 2,
        ko: target.hp === 0,
      });
      if (target.team === 0) target.inv = C.INV;
      if (target.hp === 0) {
        target.st = 'ko';
        target.ko = target.team === 0 ? C.PKO : C.KO;
        target.t = 0;
        world.events.push({ type: 'ko', id: target.id, tick: world.tick });
      }
    }
  }

  // One step of the states every fighter shares: attacking, hurt, knocked out. Returns true if the fighter was busy
  // (so the caller skips its own movement / decisions this step).
  function updateBusy(world, fighter) {
    if (fighter.st === 'attack') {
      const move = MOVES[fighter.move];
      fighter.t++;
      if (fighter.ground) {
        fighter.vx *= 0.7;
        if (move.step && fighter.t >= move.start - 2 && fighter.t < move.start + move.active) fighter.vx = fighter.face * move.step;
      }
      if (fighter.t >= move.start && fighter.t < move.start + move.active) resolveHits(world, fighter, move);
      physics(world, fighter);
      if (fighter.t >= move.start + move.active + move.rec) endState(fighter);
      return true;
    }
    if (fighter.st === 'hurt') {
      fighter.t++;
      knockback(fighter);
      fighter.vx = 0;
      physics(world, fighter);
      if (--fighter.stun <= 0) endState(fighter);
      return true;
    }
    if (fighter.st === 'ko') {
      fighter.t++;
      knockback(fighter);
      fighter.vx = 0;
      physics(world, fighter);
      if (--fighter.ko <= 0) {
        if (fighter.team === 0 || world.rise) {
          // the player (or a film dummy) gets up with full hp
          fighter.st = 'idle';
          fighter.t = 0;
          fighter.hp = fighter.maxhp;
          fighter.inv = fighter.team === 0 ? C.INV * 2 : 0;
          world.events.push({ type: 'rise', id: fighter.id, tick: world.tick });
        } else {
          fighter.st = 'gone'; // an enemy breaks apart (drawn by noodle.js) and is removed later
          world.events.push({ type: 'gone', id: fighter.id, tick: world.tick });
        }
      }
      return true;
    }
    return fighter.st === 'gone';
  }

  // ------------------------------------------------------------------------------------------------------ player

  function updatePlayer(world, player, mask) {
    const pressed = mask & ~world.prev; // buttons that went down this step

    // remember presses for a few steps, so a slightly early press still works
    player.jbuf = pressed & K.J ? C.BUFFER : Math.max(0, player.jbuf - 1);
    player.abuf = pressed & K.A ? C.BUFFER : Math.max(0, player.abuf - 1);
    player.bbuf = pressed & K.B ? C.BUFFER : Math.max(0, player.bbuf - 1);
    if (player.dashcd > 0) player.dashcd--;
    if (player.inv > 0) player.inv--;

    const dir = (mask & K.R ? 1 : 0) - (mask & K.L ? 1 : 0);
    if (!(mask & K.J) && player.vy < 0) player.cut = true; // jump released while rising: fall sooner
    if (player.st === 'attack' && !player.ground && dir) {
      player.vx = Math.max(-C.RUNMAX, Math.min(C.RUNMAX, player.vx + dir * C.AIRACC * 0.5)); // a little steering during air jabs
    }
    if (updateBusy(world, player)) return;

    if (player.st === 'dash') {
      player.t++;
      const left = 1 - player.t / C.DASHF;
      player.vx = player.face * C.DASHV * (0.35 + 0.65 * left);
      player.vy = 0;
      physics(world, player);
      if (player.t >= C.DASHF) {
        player.st = player.ground ? 'idle' : 'air';
        player.vx = player.face * C.RUNMAX;
      }
      return;
    }

    // running / steering
    if (dir) player.face = dir;
    if (player.ground) {
      if (dir) player.vx += Math.sign(dir * C.RUNMAX - player.vx) * Math.min(C.ACC, Math.abs(dir * C.RUNMAX - player.vx));
      else player.vx -= Math.sign(player.vx) * Math.min(C.FRIC, Math.abs(player.vx));
    } else if (dir) {
      player.vx = Math.max(-C.RUNMAX, Math.min(C.RUNMAX, player.vx + dir * C.AIRACC));
    }

    // jump (also allowed a few steps after leaving the ground: coyote time)
    if (player.jbuf && (player.ground || player.coyote > 0)) {
      player.vy = C.JUMPV;
      player.ground = false;
      player.coyote = 0;
      player.jbuf = 0;
      player.cut = false;
      world.events.push({ type: 'jump', id: player.id, tick: world.tick });
    }

    if (pressed & K.D && player.dashcd === 0) {
      player.st = 'dash';
      player.t = 0;
      player.dashcd = C.DASHCD;
      player.face = dir || player.face;
      world.events.push({ type: 'dash', id: player.id, tick: world.tick });
      physics(world, player);
      return;
    }
    if (player.bbuf && player.ground) {
      startMove(world, player, 'HEAVY');
      physics(world, player);
      return;
    }
    if (player.abuf) {
      startMove(world, player, 'LIGHT');
      physics(world, player);
      return;
    }

    physics(world, player);
    player.st = player.ground ? (Math.abs(player.vx) > 0.4 ? 'run' : 'idle') : 'air';
  }

  // ------------------------------------------------------------------------------------------------------ enemies

  // Enemy AI: the two nearest enemies hold an "attack token" and close in; the rest keep their distance, so the player
  // is never mobbed by everyone at once.
  function updateEnemy(world, enemy, player) {
    if (updateBusy(world, enemy)) return;
    if (world.noAI) {
      enemy.vx = 0;
      physics(world, enemy);
      enemy.st = 'idle';
      return;
    }
    const type = TYPES[enemy.kind];
    const dx = player.x - enemy.x;
    const distance = Math.abs(dx);
    if (enemy.cool > 0) enemy.cool--;
    enemy.face = dx >= 0 ? 1 : -1;

    // where this enemy wants to stand
    let target;
    if (!alive(player)) target = player.x - enemy.face * (300 + enemy.slot * 70);
    else if (enemy.token) target = distance > type.range ? player.x - enemy.face * type.range * 0.85 : enemy.x;
    else target = player.x - enemy.face * (250 + enemy.slot * 60);
    const d = target - enemy.x;
    enemy.vx = Math.abs(d) > 8 ? Math.sign(d) * Math.min(type.speed * (enemy.token ? 1 : 0.7), Math.abs(d)) : 0;

    // attack: in range, holding a token, cooled down — and then only now and then (8% per step), so it isn't robotic
    const inRange = distance <= type.range && Math.abs(player.y - enemy.y) < 120;
    if (enemy.token && alive(player) && inRange && enemy.cool === 0 && random(world) < 0.08) {
      startMove(world, enemy, type.move);
      enemy.cool = 50 + Math.floor(random(world) * 50);
      enemy.vx = 0;
      physics(world, enemy);
      return;
    }
    physics(world, enemy);
    enemy.st = Math.abs(enemy.vx) > 0.3 ? 'run' : 'idle';
  }

  // Start a wave when the player reaches it, end it when its enemies are gone, and hand out the attack tokens.
  function updateWaves(world, player) {
    const wave = world.noWaves ? null : world.waves[world.wave];
    if (!world.lock && wave && player.x >= wave.at) {
      const left = wave.at - 520;
      world.lock = [left, left + ARENA];
      world.events.push({ type: 'wave', n: world.wave, tick: world.tick });
      wave.foes.forEach(([kind, side, hp], i) => {
        const x = side > 0 ? left + ARENA + 80 + i * 70 : left - 80 - i * 70; // just off screen
        const foe = makeFighter(world, kind, 1, x, -side);
        foe.wave = world.wave;
        foe.slot = i;
        foe.cool = 40 + i * 25;
        if (hp) foe.hp = foe.maxhp = hp;
        if (wave.boss && i === 0) foe.boss = true;
        world.fighters.push(foe);
      });
    }
    if (!world.noWaves && world.lock && !world.fighters.some((f) => f.wave === world.wave && f.st !== 'gone')) {
      world.events.push({ type: 'waveclear', n: world.wave, tick: world.tick });
      world.lock = null;
      world.wave++;
      if (world.wave === world.waves.length) {
        world.clear = world.tick;
        world.events.push({ type: 'clear', tick: world.tick });
      }
    }
    // tokens: the two nearest standing enemies may attack (ties broken by id, so it replays exactly)
    const foes = world.fighters
      .filter((f) => f.team === 1 && alive(f))
      .sort((a, b) => Math.abs(a.x - player.x) - Math.abs(b.x - player.x) || a.id - b.id);
    foes.forEach((f, i) => {
      f.token = i < 2;
    });
  }

  // ------------------------------------------------------------------------------------------------------ the step

  // Advance the world by one step with this step's input bitmask. Returns the events of the step
  // (swing, hit, ko, gone, rise, land, jump, dash, wave, waveclear, clear) — fx.js and the sound read them.
  N.step = function (world, mask) {
    world.events = [];
    const player = world.fighters[0];
    updatePlayer(world, player, mask);
    updateWaves(world, player);
    for (const fighter of world.fighters) if (fighter.team !== 0) updateEnemy(world, fighter, player);

    // standing bodies don't overlap: push pairs apart sideways (enemies keep a bit more room between themselves)
    const standing = world.fighters.filter(alive);
    for (let i = 0; i < standing.length; i++) {
      for (let j = i + 1; j < standing.length; j++) {
        const a = standing[i];
        const b = standing[j];
        const minGap = (TYPES[a.kind].w + TYPES[b.kind].w) * (a.team === b.team ? 0.62 : 0.55);
        if (Math.abs(a.x - b.x) < minGap && Math.abs(a.y - b.y) < 150) {
          const side = Math.sign(b.x - a.x) || (a.id < b.id ? 1 : -1);
          const half = (minGap - Math.abs(b.x - a.x)) * 0.5;
          a.x -= side * half;
          b.x += side * half;
        }
      }
    }
    if (world.lock) player.x = Math.max(world.lock[0] + 90, Math.min(world.lock[1] - 90, player.x)); // stay in the arena

    // remove enemies that are gone once their break-apart has had 90 steps to play out (drawn by noodle.js)
    world.fighters = world.fighters.filter((f) => f.st !== 'gone' || world.tick - (f.goneAt ?? (f.goneAt = world.tick)) < 90);
    world.prev = mask;
    world.tick++;
    return world.events;
  };

  // A fingerprint of the battle state only (positions, hp, states) — exactly what the feel switches must never change.
  N.hash = function (world) {
    let s = `${world.tick}|${world.wave}|${world.clear}`;
    for (const f of world.fighters) s += `|${f.id},${f.x.toFixed(3)},${f.y.toFixed(3)},${f.hp},${f.st},${f.t}`;
    let h = 2166136261; // FNV-1a
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(16);
  };

  // A seeded random generator for decoration (break-apart bits, hit stars). Not used by the rules.
  N.rng = function (seed) {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  };
})(typeof window !== 'undefined' ? window : globalThis);
