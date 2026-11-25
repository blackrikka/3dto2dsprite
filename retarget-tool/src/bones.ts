import type * as THREE from 'three';
import type { MapRow, Rig } from './types';

export const CENTER_KEYS = ['hips', 'spine', 'chest', 'upperChest', 'neck', 'head'] as const;
export const SIDE_KEYS = ['Shoulder', 'UpperArm', 'LowerArm', 'Hand', 'UpperLeg', 'LowerLeg', 'Foot', 'Toes'] as const;
export const FINGERS = ['Thumb', 'Index', 'Middle', 'Ring', 'Little'] as const;
export const SEGS = ['Proximal', 'Intermediate', 'Distal'] as const;
export type Finger = (typeof FINGERS)[number];
export type Side = 'left' | 'right';

/**
 * 캐노니컬 키 (표 행 순서): 중앙 6 → 좌/우 몸통 8씩 → 좌/우 손가락 15씩.
 * 주의: 스펙의 "55개" 와 달리 열거된 키는 6 + 16 + 30 = 52 개이므로 52 를 쓴다.
 */
export const CANON_KEYS: string[] = [
  ...CENTER_KEYS,
  ...(['left', 'right'] as const).flatMap((s) => SIDE_KEYS.map((k) => s + k)),
  ...(['left', 'right'] as const).flatMap((s) => FINGERS.flatMap((f) => SEGS.map((g) => s + f + g))),
];

const LABEL_KO: Record<string, string> = {
  hips: '엉덩이', spine: '척추', chest: '가슴', upperChest: '윗가슴', neck: '목', head: '머리',
  Shoulder: '어깨', UpperArm: '위팔', LowerArm: '아래팔', Hand: '손', UpperLeg: '허벅지',
  LowerLeg: '정강이', Foot: '발', Toes: '발가락',
};
const FINGER_KO: Record<string, string> = { Thumb: '엄지', Index: '검지', Middle: '중지', Ring: '약지', Little: '새끼' };

/** 캐노니컬 키 → 한국어 라벨 */
export function labelOf(key: string): string {
  const m = /^(left|right)(.*)$/.exec(key);
  const side = m ? (m[1] === 'left' ? '왼쪽 ' : '오른쪽 ') : '';
  const body = m ? m[2] : key;
  const fm = /^(Thumb|Index|Middle|Ring|Little)(Proximal|Intermediate|Distal)$/.exec(body);
  if (fm) return `${side}${FINGER_KO[fm[1]]} ${SEGS.indexOf(fm[2] as (typeof SEGS)[number]) + 1}`;
  return side + (LABEL_KO[body] ?? body);
}

export interface Parsed {
  side: 'left' | 'right' | '';
  core: string;
  finger?: { f: Finger; seg: 0 | 1 | 2; guessed: boolean };
}

const PREFIX_RE = [/^mixamorig\d*/, /^valvebipedbip01/, /^bip0*1/, /^ccbase/, /^jbip[clr]?/, /^def/, /^org/];
const EXCLUDE_RE = /ik|twist|捩|roll|cancel|キャンセル|end|nub|tip|dummy|ダミー|pole|target/;
const FINGER_WORDS: [RegExp, Finger][] = [
  [/thumb|親指/, 'Thumb'],
  [/index|人差指|人指/, 'Index'],
  [/middle|中指/, 'Middle'],
  [/ring|薬指/, 'Ring'],
  [/little|pinky|小指/, 'Little'],
];

/** 본 이름을 좌우/핵심 이름/손가락 정보로 분해한다. null 이면 대응 대상에서 제외. */
export function parseName(raw: string): Parsed | null {
  let s = raw.normalize('NFKC');
  s = s.split(/[:|]/).pop() ?? '';

  // 2. 방향
  let side: Parsed['side'] = '';
  if (/^[左右]/.test(s)) {
    side = s[0] === '左' ? 'left' : 'right';
    s = s.slice(1);
  } else {
    const lr = /left|right/i.exec(s);
    const sm = lr ? null : /(^|[^a-z])([lr])([^a-z]|$)/i.exec(s);
    const cap = !lr && !sm ? /^[LR](?=[A-Z])/.exec(s) : null;
    if (lr) {
      side = lr[0].toLowerCase() === 'left' ? 'left' : 'right';
      s = s.slice(0, lr.index) + s.slice(lr.index + lr[0].length);
    } else if (sm) {
      side = sm[2].toLowerCase() === 'l' ? 'left' : 'right';
      s = s.slice(0, sm.index) + sm[1] + sm[3] + s.slice(sm.index + sm[0].length);
    } else if (cap) {
      side = cap[0] === 'L' ? 'left' : 'right';
      s = s.slice(1);
    }
  }

  // 3. 핵심 이름
  let core = s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  for (let changed = true; changed; ) {
    changed = false;
    for (const re of PREFIX_RE) {
      const next = core.replace(re, '');
      if (next !== core) {
        core = next;
        changed = true;
      }
    }
  }

  // 4. 제외
  if (EXCLUDE_RE.test(core)) return null;
  if (core.endsWith('先') && !core.endsWith('つま先')) return null;

  // 5. 손가락
  const fw = FINGER_WORDS.find(([re]) => re.test(core));
  if (fw) {
    const f = fw[1];
    let seg: 0 | 1 | 2 = 0;
    let guessed = false;
    const word = /proximal|intermediate|distal/.exec(core);
    if (word) {
      seg = (['proximal', 'intermediate', 'distal'].indexOf(word[0])) as 0 | 1 | 2;
    } else {
      guessed = true;
      const dm = /(\d+)$/.exec(core);
      if (dm) {
        const n = Number(dm[1]);
        // MMD 의 親指 는 0/1/2 (영문 Thumb 은 1/2/3 으로 본다)
        if (f === 'Thumb' && core.includes('親指')) {
          if (n > 2) return null;
          seg = n as 0 | 1 | 2;
        } else {
          if (n > 3) return null;
          seg = (n === 0 ? 0 : n - 1) as 0 | 1 | 2;
        }
      }
    }
    return { side, core, finger: { f, seg, guessed } };
  }
  return { side, core };
}

/** 별칭 (side 없는 키 기준, 정규화된 핵심 이름과 비교) */
export const ALIASES: Record<string, string[]> = {
  hips: ['hips', 'pelvis', 'hip', 'グルーブ', 'センター'],
  spine: ['spine', 'spine0', 'abdomen', '上半身'],
  chest: ['spine1', 'spine01', 'chest', '上半身2'],
  upperChest: ['spine2', 'spine02', 'spine3', 'upperchest', '上半身3'],
  neck: ['neck', '首'],
  head: ['head', '頭'],
  Shoulder: ['shoulder', 'clavicle', 'collar', '肩'],
  UpperArm: ['upperarm', 'uparm', 'arm', '腕'],
  LowerArm: ['forearm', 'lowerarm', 'elbow', 'ひじ', '肘'],
  Hand: ['hand', 'wrist', '手首'],
  UpperLeg: ['upleg', 'upperleg', 'thigh', '足'],
  LowerLeg: ['leg', 'lowerleg', 'calf', 'shin', 'knee', 'ひざ', '膝'],
  Foot: ['foot', 'ankle', '足首'],
  Toes: ['toes', 'toe', 'toebase', 'つま先'],
};
/** 센터/グルーブ 은 정확 일치여도 0.9 */
const EXACT_SCORE: Record<string, number> = { グルーブ: 0.9, センター: 0.9 };

/** 본 이름 → 캐노니컬 키와 신뢰도 (0~1). 대응 대상이 아니면 null */
export function classify(raw: string): { key: string; score: number } | null {
  const p = parseName(raw);
  if (!p) return null;
  if (p.finger) {
    if (!p.side) return null;
    return { key: p.side + p.finger.f + SEGS[p.finger.seg], score: p.finger.guessed ? 0.9 : 1 };
  }
  let best: { key: string; score: number; len: number } | null = null;
  for (const [k, aliases] of Object.entries(ALIASES)) {
    const isCenter = (CENTER_KEYS as readonly string[]).includes(k);
    if (isCenter ? p.side !== '' : p.side === '') continue;
    for (const a of aliases) {
      let score = 0;
      if (p.core === a) score = EXACT_SCORE[a] ?? 1;
      else if ((a.length >= 3 || /[^\x00-\x7f]/.test(a)) && p.core.includes(a)) score = 0.6;
      if (!score) continue;
      if (!best || score > best.score || (score === best.score && a.length > best.len)) {
        best = { key: isCenter ? k : p.side + k, score, len: a.length };
      }
    }
  }
  return best ? { key: best.key, score: best.score } : null;
}

function depthOf(b: THREE.Object3D): number {
  let d = 0;
  for (let p = b.parent; p; p = p.parent) d++;
  return d;
}

/** 소스/타깃 Rig 의 본을 캐노니컬 키에 자동 대응시킨다. 행 순서 = CANON_KEYS. */
export function autoMap(src: Rig, tgt: Rig): MapRow[] {
  const pick = (rig: Rig) => {
    const m = new Map<string, { name: string; score: number; depth: number }>();
    for (const b of rig.bones) {
      const c = classify(b.name);
      if (!c) continue;
      const depth = depthOf(b);
      const cur = m.get(c.key);
      if (!cur || c.score > cur.score || (c.score === cur.score && depth < cur.depth)) {
        m.set(c.key, { name: b.name, score: c.score, depth });
      }
    }
    return m;
  };
  const sm = pick(src);
  const tm = pick(tgt);
  const rows: MapRow[] = CANON_KEYS.map((key) => {
    const s = sm.get(key);
    const t = tm.get(key);
    return {
      key,
      label: labelOf(key),
      source: s?.name ?? null,
      target: t?.name ?? null,
      enabled: !!(s && t),
      confidence: s && t ? Math.min(s.score, t.score) : 0,
    };
  });
  // 같은 본이 두 행에 잡히면 신뢰도 높은 행만 유지
  for (const side of ['source', 'target'] as const) {
    const order = rows
      .map((r, i) => ({ i, name: r[side], c: r.confidence }))
      .filter((x) => x.name)
      .sort((a, b) => b.c - a.c);
    const claimed = new Set<string>();
    for (const o of order) {
      if (claimed.has(o.name!)) {
        rows[o.i][side] = null;
        rows[o.i].enabled = false;
        rows[o.i].confidence = 0;
      } else claimed.add(o.name!);
    }
  }
  return rows;
}

export function matchedCount(rows: MapRow[]): number {
  return rows.filter((r) => !r.custom && r.source && r.target).length;
}
