// =====================================================================================================================
// noodle.js — the noodle figure: how a fighter's state becomes a body.
//
//   1. target pose   For each state (stand, run, air, dash, attack, hurt, knocked out) a function returns where seven
//                    points should be: hip, chest, head, front / back hand (hF, hB), front / back foot (fF, fB).
//                    Poses are in local coordinates: x forward (the way the fighter faces), y down, origin between the feet.
//   2. springs       Each point chases its target through a small spring, so limbs lag, overshoot and flop a little —
//                    that is the "noodle". Stepped once per game step in N.update(world), so it replays exactly.
//   3. joints        Knees and elbows come from two-bone IK (N.joints), so limbs never stretch.
//   4. drawing       Limbs are drawn as smooth curves through the joint (N.drawFigure). Drawing only reads the state.
//
// Also here: N.bendHit (feel switch ④, the body bends on a hit) and the break-apart of a knocked-out enemy.
// =====================================================================================================================
(function (global) {
  const N = global.NOODLE;

  const S = (N.S = 0.8); //      overall figure scale (Bobo: 再矮一点 → 0.8)
  const HEAD_R = 22; //          head radius, drawn at full size so the head reads a little bigger than the body
  // segment lengths before scaling
  const L = (N.L = { thigh: 62, shin: 62, torso: 80, neck: 15, head: 23, upper: 50, fore: 50 });
  const POINTS = ['hip', 'chest', 'head', 'hF', 'hB', 'fF', 'fB'];
  // spring stiffness per point (1 = follows its target exactly); one damping for all
  const STIFFNESS = { hip: 0.7, chest: 0.5, head: 0.38, hF: 0.36, hB: 0.36, fF: 0.85, fB: 0.85 };
  const DAMPING = 0.58;
  // how far a point is thrown by the body's own acceleration (the arms flop forward when you stop)
  const INERTIA = { hip: 0, chest: 0.35, head: 0.7, hF: 1.1, hB: 1.1, fF: 0, fB: 0 };

  // ------------------------------------------------------------------------------------------------- small helpers
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const mix = (a, b, k) => a + (b - a) * k;
  const ease = (k) => k * k * (3 - 2 * k); // smoothstep
  const ease01 = (k) => ease(clamp(k, 0, 1));
  const P = (x, y) => ({ x, y });
  const lerpP = (a, b, k) => P(mix(a.x, b.x, k), mix(a.y, b.y, k));
  const add = (a, x, y) => P(a.x + x, a.y + y);
  function blend(poseA, poseB, k) {
    const out = {};
    for (const p of POINTS) out[p] = lerpP(poseA[p], poseB[p], k);
    return out;
  }

  // -------------------------------------------------------------------------------------------------- key poses

  function stand(t) {
    const breath = Math.sin(t * 0.055) * 2;
    const hip = P(2, -114 + breath * 0.5);
    const chest = add(hip, 6, -L.torso + breath);
    return {
      hip, chest, head: add(chest, 5, -L.neck - L.head),
      hF: add(chest, 34, 10), hB: add(chest, 16, 22), // guard: fists up in front
      fF: P(22, 0), fB: P(-24, 0),
    };
  }

  // phase: the walk cycle angle (advances with distance travelled). Opposite arm swings with each leg.
  function run(phase) {
    const sF = Math.sin(phase), cF = Math.cos(phase), sB = -sF, cB = -cF;
    const hip = P(6, -112 + 4 * Math.cos(2 * phase));
    const chest = add(hip, 18, -L.torso + 2); // leaning forward
    return {
      hip, chest, head: add(chest, 9, -L.neck - L.head),
      hF: add(chest, 10 + sB * 34, 46 - Math.max(0, cB) * 14),
      hB: add(chest, 4 + sF * 34, 48 - Math.max(0, cF) * 14),
      fF: P(sF * 58, -Math.max(0, cF) * 44), // a foot lifts while it swings forward
      fB: P(sB * 58, -Math.max(0, cB) * 44),
    };
  }

  function air(vy) {
    const k = clamp((vy + 12) / 24, 0, 1); // 0 = rising (knees tucked) → 1 = falling (legs reaching down)
    const hip = P(0, -118);
    const chest = add(hip, 6, -L.torso);
    return {
      hip, chest, head: add(chest, 6, -L.neck - L.head),
      hF: lerpP(add(chest, 30, -26), add(chest, 44, 4), k),
      hB: lerpP(add(chest, -26, -14), add(chest, -36, 8), k),
      fF: lerpP(P(26, -44), P(16, -6), k),
      fB: lerpP(P(-12, -22), P(-22, 0), k),
    };
  }

  function dash() {
    const hip = P(-4, -102);
    const chest = add(hip, 34, -L.torso + 10);
    return {
      hip, chest, head: add(chest, 16, -L.neck - L.head + 4),
      hF: add(chest, -44, 34), hB: add(chest, -60, 18), // arms trailing behind
      fF: P(50, -8), fB: P(-60, -16),
    };
  }

  // How far an attack is "out": −1…0 during the wind-up, 1 on the active frames, easing back to 0 over recovery.
  function extension(fighter, move) {
    if (fighter.t < move.start) return -fighter.t / move.start;
    if (fighter.t < move.start + move.active) return 1;
    return 1 - ease(clamp((fighter.t - move.start - move.active) / move.rec, 0, 1));
  }

  // jab: the front hand shoots straight out at shoulder height
  function jab(fighter, base, move) {
    const e = extension(fighter, move), out = Math.max(e, 0), windup = Math.max(-e, 0);
    const pose = Object.assign({}, base);
    pose.chest = add(base.chest, 10 * out - 4 * windup, 0);
    pose.head = add(base.head, 12 * out - 4 * windup, 0);
    const shoulder = add(pose.chest, 4, 8);
    pose.hF = lerpP(add(pose.chest, 26 - 10 * windup, 8), add(shoulder, 98, -2), out);
    pose.hB = add(pose.chest, 12, 18);
    return pose;
  }

  // cross (heavy): wind the back hand up behind, step in, throw it across with the whole body
  function cross(fighter, base, move) {
    const e = extension(fighter, move), out = Math.max(e, 0), windup = Math.max(-e, 0);
    const pose = Object.assign({}, base);
    pose.hip = add(base.hip, -8 * windup + 16 * out, 6 * windup + 4 * out);
    pose.chest = add(pose.hip, 6 - 14 * windup + 26 * out, -L.torso + 6 * windup);
    pose.head = add(pose.chest, 6 + 8 * out, -L.neck - L.head);
    pose.fF = P(22 + 30 * out, 0);
    pose.fB = P(-24 - 8 * windup, 0);
    const shoulder = add(pose.chest, 2, 8);
    pose.hB = out > 0
      ? lerpP(add(pose.chest, -24, 16), add(shoulder, 99, -4), out)
      : add(pose.chest, -24 * windup + 14 * (1 - windup), 18 - 4 * windup);
    pose.hF = lerpP(add(pose.chest, 32, 8), add(pose.chest, -4, 20), out); // front hand pulls back as a counterweight
    return pose;
  }

  // swing (the stick): hand raised behind the head on the wind-up, brought down in front on the active frames
  function swing(fighter, base, move) {
    const e = extension(fighter, move), out = Math.max(e, 0), windup = Math.max(-e, 0);
    const pose = Object.assign({}, base);
    pose.chest = add(base.chest, -8 * windup + 18 * out, 4 * out);
    pose.head = add(pose.chest, 5 + 8 * out, -L.neck - L.head);
    const up = add(pose.chest, -26, -64), down = add(pose.chest, 78, 30), rest = add(pose.chest, 30, 14);
    pose.hF = out > 0 ? lerpP(up, down, Math.min(1, out * 1.0)) : lerpP(rest, up, windup);
    if (fighter.t >= move.start + move.active) pose.hF = lerpP(rest, down, out);
    pose.hB = add(pose.chest, 6, 24);
    pose.fF = P(22 + 20 * out, 0);
    return pose;
  }
  const ATTACK_POSES = { jab, cross, swing };

  // hurt: thrown back for a moment, arms up, settling over 16 steps
  function hurt(fighter, base) {
    const k = Math.max(0, 1 - fighter.t / 16) ** 1.5;
    const pose = Object.assign({}, base);
    pose.hip = add(base.hip, -10 * k, 4 * k);
    pose.chest = add(pose.hip, 6 - 30 * k, -L.torso + 8 * k);
    pose.head = add(pose.chest, 5 - 26 * k, -L.neck - L.head + 10 * k);
    pose.hF = lerpP(base.hF, add(pose.chest, -6, -40), k);
    pose.hB = lerpP(base.hB, add(pose.chest, -40, -20), k);
    return pose;
  }

  // knocked out: from the hurt pose to lying on the back over 16 steps
  const LYING = {
    hip: P(-26, -14), chest: P(-104, -14), head: P(-146, -20),
    hF: P(-70, -6), hB: P(-128, -40), fF: P(54, -8), fB: P(44, -20),
  };
  function knockedOut(fighter, base) {
    return blend(hurt({ t: 0 }, base), LYING, ease(clamp(fighter.t / 16, 0, 1)));
  }

  // Film only (world.deadpan, the v0.1 shots): a hit gets no reaction at all; afterwards the front hand scratches the head.
  function scratchHead(pose, k, t) {
    const spot = add(pose.head, -10, -6 + Math.sin(t * 0.9) * 5);
    pose.hF = lerpP(pose.hF, spot, k);
    return pose;
  }

  // The target pose for a fighter this step. `rig` = its spring state (see N.update).
  function targetPose(fighter, rig, world) {
    if (world && world.deadpan && fighter.team !== 0 && fighter.st !== 'ko' && fighter.st !== 'gone') {
      if (fighter.st === 'hurt') {
        rig.scr = 70;
        return stand(rig.t);
      }
      if (rig.scr > 0) {
        rig.scr--;
        return scratchHead(stand(rig.t), ease01(Math.min(rig.scr, 70 - rig.scr) / 12), rig.t);
      }
    }
    const move = fighter.st === 'attack' && N.MOVES[fighter.move];
    if (fighter.st === 'ko' || fighter.st === 'gone') return knockedOut(fighter, stand(rig.t));
    if (fighter.st === 'hurt') return hurt(fighter, stand(rig.t));
    if (fighter.st === 'dash') return dash();
    if (!fighter.ground) return move ? ATTACK_POSES[move.pose](fighter, air(fighter.vy), move) : air(fighter.vy);
    const base = rig.run > 0.01 ? blend(stand(rig.t), run(rig.ph), rig.run) : stand(rig.t);
    return move ? ATTACK_POSES[move.pose](fighter, base, move) : base;
  }

  // ------------------------------------------------------------------------------------------------- the springs

  // Step every fighter's spring rig. world.rig[id] holds, per fighter:
  //   t = age in steps, ph = walk phase, run = 0…1 blend from stand to run, pvx / pvy = last velocity,
  //   o[point] = current offset from the feet (world-space x, so turning swings the limbs across), v[point] = its velocity,
  //   b / bv = the "belly" spring that bows the torso, soft / softK = a short window of looser springs after a hit.
  N.update = function (world) {
    world.rig = world.rig || {};
    for (const fighter of world.fighters) {
      let rig = world.rig[fighter.id];
      const runAmount = fighter.ground && fighter.st === 'run' ? clamp(Math.abs(fighter.vx) / N.C.RUNMAX, 0, 1) : 0;
      if (!rig) rig = world.rig[fighter.id] = { t: 0, ph: 0, run: 0, pvx: 0, pvy: 0, o: {}, v: {}, b: 0, bv: 0, soft: 0, softK: 0 };
      rig.t++;
      rig.run += (runAmount - rig.run) * 0.25;
      rig.bv = (rig.bv - rig.b * 0.22) * 0.82; // belly: a 1-D spring (N.bendHit kicks it)
      rig.b += rig.bv;
      let soft = 1;
      if (rig.soft > 0) {
        soft = 1 - rig.softK * 0.65 * (rig.soft / 16);
        rig.soft--;
      }
      if (fighter.ground) rig.ph += Math.abs(fighter.vx) * Math.PI * 2 / 300;

      const target = targetPose(fighter, rig, world);
      const ax = fighter.vx - rig.pvx, ay = fighter.vy - rig.pvy; // the body's acceleration this step
      rig.pvx = fighter.vx;
      rig.pvy = fighter.vy;
      const move = fighter.st === 'attack' && N.MOVES[fighter.move];
      const punchingHand = move && (move.pose === 'cross' ? 'hB' : 'hF');
      const snapHand = move && move.pose !== 'swing' && fighter.t >= move.start - 1 && fighter.t < move.start + move.active + 2;
      if (fighter.st === 'gone') {
        stepBreakApart(world, fighter, rig);
        continue;
      }
      for (const p of POINTS) {
        const tx = target[p].x * S * fighter.face, ty = target[p].y * S;
        if (!rig.o[p]) {
          rig.o[p] = P(tx, ty);
          rig.v[p] = P(0, 0);
          continue;
        }
        let k = STIFFNESS[p] * (p === 'fF' || p === 'fB' ? 1 : soft);
        if (snapHand && p === punchingHand) k = 1; // the punching hand lands exactly where the hitbox is
        if (fighter.ground && (p === 'fF' || p === 'fB')) k = Math.max(k, 0.9); // planted feet don't slide
        const o = rig.o[p], v = rig.v[p];
        v.x = (v.x + (tx - o.x) * k - ax * INERTIA[p] * 0.5) * DAMPING;
        v.y = (v.y + (ty - o.y) * k - ay * INERTIA[p] * 0.3) * DAMPING;
        if (k >= 1) {
          o.x = tx;
          o.y = ty;
          v.x = v.y = 0;
        } else {
          o.x += v.x;
          o.y += v.y;
        }
      }
    }
  };

  // Feel switch ④, body bend: kick the springs in the hit direction (head and hands further than the hips), bow the belly
  // into a "C", and loosen the springs for 16 steps so the body wobbles back. `strength` scales it, `softness` 0…1.
  N.bendHit = function (world, id, dir, strength, softness) {
    const rig = world.rig[id];
    if (!rig || !rig.v.chest) return;
    const kick = (p, x, y) => {
      rig.v[p].x += x;
      rig.v[p].y += y;
    };
    const s = strength;
    kick('hip', dir * 4 * s, 0);
    kick('chest', dir * 9 * s, 1 * s);
    kick('head', dir * 16 * s, -5 * s);
    kick('hF', dir * 18 * s, -12 * s);
    kick('hB', dir * 22 * s, -8 * s);
    rig.bv += dir * 9 * s;
    rig.soft = 16;
    rig.softK = softness;
  };

  // A knocked-out enemy breaks into its line segments, which drift up a little, spin and fade (decoration, seeded per id).
  function stepBreakApart(world, fighter, rig) {
    if (!rig.bits) {
      const j = N.joints(world, fighter);
      const rand = N.rng(fighter.id * 7919 + 13);
      const segments = [
        [j.hip, j.kF], [j.kF, j.fF], [j.hip, j.kB], [j.kB, j.fB], [j.hip, j.chest],
        [j.sh, j.eF], [j.eF, j.hF], [j.sh, j.eB], [j.eB, j.hB],
      ];
      rig.bits = segments.map(([a, b]) => ({
        x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, hx: (b.x - a.x) / 2, hy: (b.y - a.y) / 2,
        vx: (rand() - 0.5) * 3, vy: -1 - rand() * 2.5, va: (rand() - 0.5) * 0.12, a: 0,
      }));
      rig.bits.push({ head: true, x: j.head.x, y: j.head.y, vx: (rand() - 0.5) * 2, vy: -2 - rand() * 2, va: 0, a: 0 });
      rig.age = 0;
    }
    rig.age++;
    for (const bit of rig.bits) {
      bit.x += bit.vx;
      bit.y += bit.vy;
      bit.vy *= 0.97;
      bit.vx *= 0.97;
      bit.a += bit.va;
    }
  }

  // ------------------------------------------------------------------------------------------------------ joints

  // Two-bone IK: from root `a` reaching for `t` with bone lengths l1, l2. `bend` (+1 / −1) picks which side the middle
  // joint goes. Returns the middle joint m and the reachable end point e.
  function twoBoneIK(a, t, l1, l2, bend) {
    const dx = t.x - a.x, dy = t.y - a.y;
    const d = Math.hypot(dx, dy) || 1e-6;
    const reach = Math.min(d, l1 + l2 - 0.5);
    const ux = dx / d, uy = dy / d;
    const along = (l1 * l1 - l2 * l2 + reach * reach) / (2 * reach);
    const h = Math.sqrt(Math.max(0, l1 * l1 - along * along));
    return {
      m: P(a.x + ux * along - uy * h * bend, a.y + uy * along + ux * h * bend),
      e: P(a.x + ux * reach, a.y + uy * reach),
    };
  }

  // All joints of a fighter in world coordinates: hip, chest, head, shoulder (sh), knees (kF, kB), feet (fF, fB),
  // elbows (eF, eB), hands (hF, hB); `bend` = the belly spring (how much the torso bows).
  N.joints = function (world, fighter) {
    const rig = world.rig[fighter.id];
    const W = (p) => P(fighter.x + rig.o[p].x, fighter.y + rig.o[p].y);
    const hip = W('hip'), chest = W('chest'), head = W('head');
    const sh = P(chest.x + fighter.face * 3 * S, chest.y + 8 * S);
    const fF = W('fF'), fB = W('fB'), hF = W('hF'), hB = W('hB');
    const legF = twoBoneIK(hip, fF, L.thigh * S, L.shin * S, -fighter.face); // knees bend forward
    const legB = twoBoneIK(hip, fB, L.thigh * S, L.shin * S, -fighter.face);
    const armF = twoBoneIK(sh, hF, L.upper * S, L.fore * S, fighter.face); // elbows bend back and down
    const armB = twoBoneIK(sh, hB, L.upper * S, L.fore * S, fighter.face);
    return {
      bend: rig.b, hip, chest, head, sh,
      kF: legF.m, fF: legF.e, kB: legB.m, fB: legB.e, eF: armF.m, hF: armF.e, eB: armB.m, hB: armB.e,
    };
  };

  // ----------------------------------------------------------------------------------------------------- drawing

  // a quadratic curve from a to b that passes through m (the control point is chosen so the curve hits m)
  function curveThrough(ctx, a, m, b) {
    ctx.moveTo(a.x, a.y);
    ctx.quadraticCurveTo(2 * m.x - (a.x + b.x) / 2, 2 * m.y - (a.y + b.y) / 2, b.x, b.y);
  }

  // Draw one fighter. col = { body, back, shadow } colours. `extra` widens every stroke: the hit flash draws a black pass
  // with extra = 9 and then a white pass on top, which leaves a hollow outline. noShadow skips the ground shadow.
  N.drawFigure = function (ctx, world, fighter, col, extra = 0, noShadow = false) {
    const rig = world.rig[fighter.id];
    ctx.lineCap = ctx.lineJoin = 'round';
    const stroke = (colour, width, path) => {
      ctx.strokeStyle = colour;
      ctx.lineWidth = width;
      ctx.beginPath();
      path();
      ctx.stroke();
    };

    if (fighter.st === 'gone') { // breaking apart
      if (!rig.bits) return;
      ctx.save();
      ctx.globalAlpha = Math.max(0, 1 - rig.age / 70);
      for (const bit of rig.bits) {
        if (bit.head) {
          ctx.fillStyle = col.body;
          ctx.beginPath();
          ctx.arc(bit.x, bit.y, HEAD_R * (1 - rig.age / 140), 0, 7);
          ctx.fill();
          continue;
        }
        const c = Math.cos(bit.a), s = Math.sin(bit.a);
        const hx = bit.hx * c - bit.hy * s, hy = bit.hx * s + bit.hy * c;
        stroke(col.body, 10, () => {
          ctx.moveTo(bit.x - hx, bit.y - hy);
          ctx.lineTo(bit.x + hx, bit.y + hy);
        });
      }
      ctx.restore();
      return;
    }

    const j = N.joints(world, fighter);
    const lw = 12 + extra;
    const fat = fighter.kind === 'fat';
    const blinking = fighter.team === 0 && fighter.inv > 0 && fighter.st !== 'ko' && (fighter.inv >> 2) % 2; // invulnerable
    if (blinking) {
      ctx.save();
      ctx.globalAlpha = 0.3;
    }
    if (!noShadow) {
      const height = Math.max(0, N.C.GY - fighter.y);
      ctx.fillStyle = col.shadow;
      ctx.beginPath();
      ctx.ellipse(fighter.x + (j.hip.x - fighter.x) * 0.4, N.C.GY + 4, (fat ? 70 : 52) * (1 - Math.min(height, 300) / 500), 8, 0, 0, 7);
      ctx.fill();
    }
    // back limbs first, then torso and head, then the front limbs on top
    stroke(col.back, lw, () => curveThrough(ctx, j.hip, j.kB, j.fB));
    stroke(col.back, lw - 1, () => curveThrough(ctx, j.sh, j.eB, j.hB));
    // torso: bows with the belly spring; the fat one is one thick round stroke
    stroke(col.body, fat ? 46 + extra : lw + 3, () => {
      const mx = (j.hip.x + j.chest.x) / 2 - fighter.face * (fat ? -10 : 4) + Math.max(-40, Math.min(40, j.bend * 2.4));
      const my = (j.hip.y + j.chest.y) / 2;
      ctx.moveTo(j.hip.x, j.hip.y - (fat ? 10 : 0));
      ctx.quadraticCurveTo(mx, my, j.chest.x, j.chest.y + (fat ? 8 : 0));
      if (!fat) ctx.lineTo(j.head.x * 0.3 + j.chest.x * 0.7, j.head.y * 0.3 + j.chest.y * 0.7); // neck
    });
    ctx.fillStyle = col.body;
    ctx.beginPath();
    ctx.arc(j.head.x, j.head.y, HEAD_R + extra / 2, 0, 7);
    ctx.fill();
    stroke(col.body, lw, () => curveThrough(ctx, j.hip, j.kF, j.fF));
    stroke(col.body, lw - 1, () => curveThrough(ctx, j.sh, j.eF, j.hF));
    if (fighter.kind === 'stick') { // the stick continues the forearm, 120 px
      const dx = j.hF.x - j.eF.x, dy = j.hF.y - j.eF.y, d = Math.hypot(dx, dy) || 1;
      stroke(col.body, 8 + extra, () => {
        ctx.moveTo(j.hF.x - (dx / d) * 14, j.hF.y - (dy / d) * 14);
        ctx.lineTo(j.hF.x + (dx / d) * 120, j.hF.y + (dy / d) * 120);
      });
    }
    ctx.fillStyle = col.body; // the front fist
    ctx.beginPath();
    ctx.arc(j.hF.x, j.hF.y, 8 + extra / 2, 0, 7);
    ctx.fill();
    if (blinking) ctx.restore();
    return j;
  };
})(typeof window !== 'undefined' ? window : globalThis);
