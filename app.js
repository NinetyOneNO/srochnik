/* СРОЧНИК — прототип Telegram MiniApp.
   Игра про армейский быт: наряды, чипок, боевой дух и путь до дембеля. */

'use strict';

const SAVE_KEY = 'srochnik.save.v1';
const ENERGY_MS = 8000;
const HP_MS = 30000;
const EVENT_CHANCE = 0.16;
const MAX_LOG = 40;
const MAX_LEVEL_XP = 6000;
const LEVELS_PER_RANK = 10;
const CONTRACT_XP = MAX_LEVEL_XP / 2;
const ACTION_COOLDOWN_SCALE = 2;

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
const rand = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const nf = new Intl.NumberFormat('ru-RU');
const fmt = (n) => nf.format(Math.round(n));
const rub = (n) => `${fmt(n)} ₽`;

function plural(n, one, few, many) {
  const abs = Math.abs(n) % 100;
  const last = abs % 10;
  if (abs > 10 && abs < 20) return many;
  if (last > 1 && last < 5) return few;
  if (last === 1) return one;
  return many;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[ch]));
}

function hashString(value) {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function fmtRemain(ms) {
  const total = Math.max(1, Math.ceil(ms / 1000));
  if (total >= 60) {
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
  }
  return `${total} с`;
}

/* ---------- Telegram ---------- */

const tg = window.Telegram?.WebApp || null;

function tgUser() {
  try {
    return tg?.initDataUnsafe?.user || null;
  } catch (e) {
    return null;
  }
}

function haptic(kind = 'light') {
  const h = tg?.HapticFeedback;
  if (!h) return;
  try {
    if (kind === 'error') h.notificationOccurred('error');
    else if (kind === 'success') h.notificationOccurred('success');
    else h.impactOccurred('light');
  } catch (e) {
    /* haptics may be unavailable */
  }
}

/* ---------- game data ---------- */

const RANKS = [
  { xp: 0, title: 'Рядовой', emoji: '🪖' },
  { xp: 400, title: 'Ефрейтор', emoji: '🎖️' },
  { xp: 1000, title: 'Младший сержант', emoji: '🎖️' },
  { xp: 1800, title: 'Сержант', emoji: '🥇' },
  { xp: 2900, title: 'Старшина', emoji: '🏅' },
  { xp: 4300, title: 'Прапорщик', emoji: '⭐' },
  { xp: 6000, title: 'Дембель', emoji: '😎' }
];

const ACTIONS = [
  {
    id: 'charge',
    icon: '🏃',
    title: 'Зарядка',
    desc: 'Пробежка вокруг плаца',
    energy: 10,
    xp: [8, 13],
    money: [0, 0],
    morale: 2,
    cooldown: 25,
    busy: 20,
    blocks: ['call'],
    flavor: [
      'Кросс сдан. Плац остался позади.',
      'Подтянулся двенадцать раз. Командир кивнул.',
      'Разминка прошла бодро — даже берцы не скрипят.'
    ]
  },
  {
    id: 'potato',
    icon: '🥔',
    title: 'Наряд на кухню',
    desc: 'Почистить картошку для роты',
    energy: 14,
    xp: [6, 10],
    money: [45, 75],
    morale: -1,
    cooldown: 50,
    busy: 60,
    blocks: ['guard', 'charge', 'drill', 'call', 'help'],
    duty: true,
    flavor: [
      'Три ведра картошки — и ни одной мозоли.',
      'Повар угостил горячим пирожком. Жизнь удалась.',
      'Картошка почищена. Рота спасена от голода.'
    ]
  },
  {
    id: 'drill',
    icon: '🎖️',
    title: 'Строевая',
    desc: 'Чеканить шаг на плацу',
    energy: 12,
    xp: [12, 18],
    money: [0, 0],
    morale: 1,
    cooldown: 60,
    busy: 25,
    blocks: ['call'],
    flavor: [
      'Шаг чеканил так, что гул пошёл по плацу.',
      '«Раз-два, левой!» — и ты в идеальном строю.',
      'Командир роты поставил тебя в пример.'
    ]
  },
  {
    id: 'guard',
    icon: '🛡️',
    title: 'Караул',
    desc: 'Час на посту, всё по уставу',
    energy: 22,
    xp: [24, 34],
    money: [100, 160],
    morale: -3,
    cooldown: 180,
    busy: 80,
    blocks: ['potato', 'charge', 'drill', 'call', 'help'],
    duty: true,
    flavor: [
      'Смена прошла спокойно. Даже ворон не пролетел.',
      'На посту думал о доме. Время шло медленно.',
      'Сдал пост по уставу — без замечаний.'
    ]
  },
  {
    id: 'help',
    icon: '🧹',
    title: 'Помочь прапорщику',
    desc: 'Подмести плац и заслужить плюс',
    energy: 10,
    xp: [10, 16],
    money: [30, 90],
    morale: 3,
    cooldown: 90,
    busy: 30,
    blocks: ['guard', 'potato'],
    duty: true,
    flavor: [
      'Прапорщик остался доволен. Это редкость.',
      'Плац блестит, а в кармане звенит.',
      '«Хороший ты боец», — сказал прапорщик.'
    ]
  },
  {
    id: 'call',
    icon: '📞',
    title: 'Позвонить маме',
    desc: 'Рассказать, что всё хорошо',
    energy: 4,
    xp: [4, 7],
    money: [0, 0],
    morale: 14,
    cooldown: 150,
    busy: 30,
    blocks: ['charge', 'drill', 'guard', 'potato', 'help'],
    flavor: [
      'Мама передала привет и посылку с печеньем.',
      '«Кушаешь ли ты там?» — спросила мама. Ты соврал: да.',
      'Пять минут разговора — и как будто дома побывал.'
    ]
  }
];

const SHOP = [
  {
    id: 'energy',
    icon: '⚡',
    name: 'Энергетик «Дизель»',
    desc: '+35 энергии',
    price: 60,
    fullMsg: 'Энергия и так на максимуме',
    blocked: () => state.energy >= state.maxEnergy,
    apply: () => {
      state.energy = Math.min(state.maxEnergy, state.energy + 35);
    }
  },
  {
    id: 'pie',
    icon: '🥟',
    name: 'Пирожок с картошкой',
    desc: '+15 энергии и +4 духа',
    price: 30,
    fullMsg: 'Сначала проголодайся',
    blocked: () => state.energy >= state.maxEnergy,
    apply: () => {
      state.energy = Math.min(state.maxEnergy, state.energy + 15);
      state.morale = clamp(state.morale + 4, 0, 100);
    }
  },
  {
    id: 'choco',
    icon: '🍫',
    name: 'Шоколадка «Алёнка»',
    desc: '+14 боевого духа',
    price: 45,
    fullMsg: 'Дух и так боевой',
    blocked: () => state.morale >= 100,
    apply: () => {
      state.morale = clamp(state.morale + 14, 0, 100);
    }
  },
  {
    id: 'medkit',
    icon: '💊',
    name: 'Бинт и йод',
    desc: '+25 здоровья',
    price: 70,
    fullMsg: 'Здоровье и так в порядке',
    blocked: () => state.hp >= state.maxHp,
    apply: () => {
      state.hp = Math.min(state.maxHp, state.hp + 25);
    }
  },
  {
    id: 'boots',
    icon: '🥾',
    name: 'Новые берцы',
    desc: '+5 к максимуму энергии навсегда',
    price: 300,
    max: 4,
    apply: () => {
      state.maxEnergy += 5;
      state.energy = Math.min(state.maxEnergy, state.energy + 5);
    }
  }
];

const EVENTS = [
  {
    id: 'bonus',
    icon: '💸',
    title: 'Премия от прапорщика',
    text: '«Держи, боец, за расторопность», — сказал прапорщик и подмигнул.',
    money: 50
  },
  {
    id: 'inspect',
    icon: '📋',
    title: 'Внезапная проверка',
    text: 'Генерал прошёлся по казарме. Твоя койка признана образцовой.',
    xp: 25
  },
  {
    id: 'find',
    icon: '🤑',
    title: 'Находка',
    text: 'В берцах нашлась сотка. Кто-то из соседей будет скучать.',
    money: 100
  },
  {
    id: 'sleep',
    icon: '😴',
    title: 'Проспал подъём',
    text: 'Старшина застукал тебя на койке. Минус энергия, минус дух.',
    energy: -10,
    morale: -6
  },
  {
    id: 'praise',
    icon: '🫡',
    title: 'Похвала',
    text: '«Вот из тебя выйдет толк», — кивнул командир роты.',
    morale: 12,
    xp: 8
  },
  {
    id: 'blister',
    icon: '🩹',
    title: 'Мозоль',
    text: 'Новые берцы натёрли ногу. Зато красиво.',
    hp: -8
  },
  {
    id: 'letter',
    icon: '✉️',
    title: 'Письмо из дома',
    text: 'Мама прислала посылку с печеньем. Ротный разрешил поделиться.',
    morale: 15,
    hp: 5
  },
  {
    id: 'rain',
    icon: '🌧️',
    title: 'Дождь на плацу',
    text: 'Строевая под дождём. Зато закалка!',
    hp: -5,
    xp: 15
  }
];

const QUOTES = [
  '«Дембель неизбежен, как подъём в шесть утра.»',
  '«Сам не спи — другим не давай.»',
  '«Инициатива наказуема, но поощряема.»',
  '«Порядок на плацу — порядок в голове.»',
  '«Главное — не как выглядит, а как сидит.»',
  '«Устав — это не книга, это образ жизни.»',
  '«Солдат спит — служба идёт.»'
];

const DAILY_TASKS = [
  {
    id: 'duty',
    icon: '🧹',
    title: 'Сходить в наряд 3 раза',
    key: 'duty',
    goal: 3,
    reward: { money: 80, xp: 20 }
  },
  {
    id: 'earn',
    icon: '💰',
    title: 'Заработать 200 ₽',
    key: 'earn',
    goal: 200,
    reward: { money: 60, morale: 8 }
  },
  {
    id: 'call',
    icon: '📞',
    title: 'Позвонить маме',
    key: 'call',
    goal: 1,
    reward: { morale: 15, xp: 15 }
  }
];

const BOTS = [
  { name: 'Пупкин', emoji: '🪖', xp: 180 },
  { name: 'Сидоров', emoji: '👓', xp: 560 },
  { name: 'Кузнецов', emoji: '🧢', xp: 1200 },
  { name: 'Мамкин', emoji: '📞', xp: 1900 },
  { name: 'Шнурок', emoji: '👟', xp: 3200 },
  { name: 'Батя', emoji: '🫡', xp: 4400 },
  { name: 'Соловей', emoji: '🎤', xp: 5200 },
  { name: 'Дизель', emoji: '⚡', xp: 6400 }
];

const ACHIEVEMENTS = [
  {
    id: 'first',
    icon: '🥾',
    title: 'Первые шаги',
    desc: 'Выполнить первое действие в казарме',
    reward: { money: 20 },
    check: () => state.stats.actionsTotal >= 1
  },
  {
    id: 'worker',
    icon: '💪',
    title: 'Работяга',
    desc: 'Сделать 10 дел',
    reward: { money: 50 },
    progress: () => [Math.min(state.stats.actionsTotal || 0, 10), 10],
    check: () => state.stats.actionsTotal >= 10
  },
  {
    id: 'potato',
    icon: '🥔',
    title: 'Картофельный магнат',
    desc: 'Сходить на кухню 5 раз',
    reward: { money: 70 },
    progress: () => [Math.min(state.stats.byAction?.potato || 0, 5), 5],
    check: () => (state.stats.byAction?.potato || 0) >= 5
  },
  {
    id: 'guard',
    icon: '🛡️',
    title: 'Ночной караул',
    desc: 'Отстоять 3 смены в карауле',
    reward: { morale: 10 },
    progress: () => [Math.min(state.stats.byAction?.guard || 0, 3), 3],
    check: () => (state.stats.byAction?.guard || 0) >= 3
  },
  {
    id: 'rich',
    icon: '💰',
    title: 'Денежный мешок',
    desc: 'Накопить 500 ₽',
    reward: { money: 60 },
    progress: () => [Math.min(state.stats.bestMoney || 0, 500), 500],
    check: () => (state.stats.bestMoney || 0) >= 500
  },
  {
    id: 'soul',
    icon: '🔥',
    title: 'Душа роты',
    desc: 'Поднять боевой дух до 100',
    reward: { money: 50 },
    check: () => state.morale >= 100
  },
  {
    id: 'call',
    icon: '📞',
    title: 'Мамин сын',
    desc: 'Позвонить маме 3 раза',
    reward: { morale: 10 },
    progress: () => [Math.min(state.stats.byAction?.call || 0, 3), 3],
    check: () => (state.stats.byAction?.call || 0) >= 3
  },
  {
    id: 'buyer',
    icon: '🛒',
    title: 'Постоянный клиент',
    desc: 'Купить 5 товаров в чипке',
    reward: { money: 40 },
    progress: () => [Math.min(state.stats.buys || 0, 5), 5],
    check: () => (state.stats.buys || 0) >= 5
  },
  {
    id: 'event',
    icon: '🎲',
    title: 'Везение',
    desc: 'Пережить 5 событий',
    reward: { money: 50 },
    progress: () => [Math.min(state.stats.events || 0, 5), 5],
    check: () => (state.stats.events || 0) >= 5
  },
  {
    id: 'efreitor',
    icon: '🎖️',
    title: 'Ефрейтор',
    desc: 'Получить звание Ефрейтора',
    reward: { money: 30 },
    check: () => rankIndexFor(state.xp) >= 1
  },
  {
    id: 'starshina',
    icon: '🏅',
    title: 'Старшина',
    desc: 'Дослужиться до Старшины',
    reward: { money: 120 },
    check: () => rankIndexFor(state.xp) >= 4
  },
  {
    id: 'demob',
    icon: '😎',
    title: 'Дембель',
    desc: 'Дослужиться до дембеля',
    reward: { money: 300 },
    check: () => rankIndexFor(state.xp) >= RANKS.length - 1
  }
];


/* ---------- state ---------- */

function defaultState() {
  const user = tgUser();
  return {
    name: user?.first_name?.trim() || 'Срочник',
    xp: 0,
    money: 120,
    energy: 100,
    maxEnergy: 100,
    hp: 100,
    maxHp: 100,
    morale: 75,
    cooldowns: {},
    busy: { id: null, until: 0 },
    purchases: { boots: 0 },
    shopTrips: { date: todayKey(), used: 0 },
    daily: {
      date: todayKey(),
      progress: { duty: 0, earn: 0, call: 0 },
      done: {}
    },
    stats: {
      duties: 0,
      totalEarned: 0,
      actionsTotal: 0,
      byAction: {},
      events: 0,
      buys: 0,
      bestMoney: 120
    },
    achievements: {},
    demobSeen: false,
    contract: false,
    log: [],
    lastEnergyAt: Date.now(),
    lastHpAt: Date.now(),
    startedAt: Date.now()
  };
}

function loadState() {
  const base = defaultState();
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return base;
    const saved = JSON.parse(raw);
    const merged = {
      ...base,
      ...saved,
      name: saved.name || base.name,
      daily: {
        ...base.daily,
        ...(saved.daily || {}),
        progress: { ...base.daily.progress, ...(saved.daily?.progress || {}) },
        done: saved.daily?.done || {}
      },
      stats: {
        ...base.stats,
        ...(saved.stats || {}),
        byAction: { ...base.stats.byAction, ...(saved.stats?.byAction || {}) }
      },
      achievements: saved.achievements && typeof saved.achievements === 'object' && !Array.isArray(saved.achievements)
        ? { ...saved.achievements }
        : {},
      demobSeen: Boolean(saved.demobSeen),
      contract: Boolean(saved.contract),
      purchases: { ...base.purchases, ...(saved.purchases || {}) },
      cooldowns: saved.cooldowns || {},
      busy: {
        id: saved.busy?.id && ACTIONS.some((a) => a.id === saved.busy.id) ? saved.busy.id : null,
        until: Number(saved.busy?.until) || 0
      },
      shopTrips: {
        date: saved.shopTrips?.date || base.shopTrips.date,
        used: Math.max(0, Number(saved.shopTrips?.used) || 0)
      },
      log: Array.isArray(saved.log) ? saved.log : []
    };

    merged.maxEnergy = clamp(Number(merged.maxEnergy) || 100, 100, 300);
    merged.maxHp = clamp(Number(merged.maxHp) || 100, 100, 300);
    merged.energy = clamp(Number(merged.energy) || 0, 0, merged.maxEnergy);
    merged.hp = clamp(Number(merged.hp) || 0, 0, merged.maxHp);
    merged.morale = clamp(Number(merged.morale) || 0, 0, 100);
    merged.money = Math.max(0, Number(merged.money) || 0);
    merged.xp = Math.max(0, Number(merged.xp) || 0);
    merged.lastEnergyAt = Number(merged.lastEnergyAt) || Date.now();
    merged.lastHpAt = Number(merged.lastHpAt) || Date.now();
    return merged;
  } catch (e) {
    return base;
  }
}

const state = loadState();

let saveTimer = null;
let isResetting = false;

function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 150);
}

function saveNow() {
  if (isResetting) return;
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify(state));
  } catch (e) {
    /* storage may be unavailable */
  }
}

function applyOfflineRegen() {
  const now = Date.now();

  if (state.energy >= state.maxEnergy) {
    state.lastEnergyAt = now;
  } else {
    const gain = Math.floor((now - state.lastEnergyAt) / ENERGY_MS);
    if (gain > 0) {
      state.energy = clamp(state.energy + gain, 0, state.maxEnergy);
      state.lastEnergyAt += gain * ENERGY_MS;
    }
  }

  if (state.hp >= state.maxHp) {
    state.lastHpAt = now;
  } else {
    const gain = Math.floor((now - state.lastHpAt) / HP_MS);
    if (gain > 0) {
      state.hp = clamp(state.hp + gain, 0, state.maxHp);
      state.lastHpAt += gain * HP_MS;
    }
  }
}

/* ---------- derived values ---------- */

function rankIndexFor(xp) {
  let idx = 0;
  for (let i = 0; i < RANKS.length; i++) {
    if (xp >= RANKS[i].xp) idx = i;
  }
  return idx;
}

function rankProgress() {
  const idx = rankIndexFor(state.xp);
  const rank = RANKS[idx];
  const next = RANKS[idx + 1] || null;
  const into = state.xp - rank.xp;
  const span = next ? next.xp - rank.xp : 1;
  const level = next
    ? clamp(Math.floor((into / span) * LEVELS_PER_RANK) + 1, 1, LEVELS_PER_RANK)
    : LEVELS_PER_RANK;

  return {
    idx,
    rank,
    next,
    into,
    span,
    level,
    levels: LEVELS_PER_RANK,
    pct: next ? clamp((into / span) * 100, 0, 100) : 100
  };
}

function rewardMultiplier() {
  const hpMod = state.hp < 25 ? 0.6 : 1;
  const moraleMod = 0.85 + (clamp(state.morale, 0, 100) / 100) * 0.3;
  return hpMod * moraleMod;
}

function daysUntilDemob() {
  const left = 1 - clamp(state.xp / MAX_LEVEL_XP, 0, 1);
  return Math.max(0, Math.ceil(365 * left));
}

function contractAvailable() {
  return state.xp >= CONTRACT_XP;
}

function daysUntilContract() {
  const halfDays = Math.ceil(365 * (1 - CONTRACT_XP / MAX_LEVEL_XP));
  if (contractAvailable()) return 0;
  return Math.max(1, daysUntilDemob() - halfDays);
}

function shopTripsLimit() {
  return 1 + rankIndexFor(state.xp);
}

function shopTripsLeft() {
  return Math.max(0, shopTripsLimit() - (state.shopTrips?.used || 0));
}

function busyAction() {
  if (!state.busy?.id) return null;
  if (state.busy.until <= Date.now()) return null;
  return ACTIONS.find((a) => a.id === state.busy.id) || null;
}

function busyBlockerFor(actionId) {
  const blocker = busyAction();
  if (!blocker) return null;
  return (blocker.blocks || []).includes(actionId) ? blocker : null;
}

/* ---------- DOM ---------- */

const els = {
  heroName: $('#heroName'),
  rankBadge: $('#rankBadge'),
  lvlChip: $('#lvlChip'),
  rankBadgeTop: $('#rankBadgeTop'),
  lvlChipTop: $('#lvlChipTop'),
  xpLabel: $('#xpLabel'),
  xpBar: $('#xpBar'),
  hpVal: $('#hpVal'),
  hpBar: $('#hpBar'),
  hpHint: $('#hpHint'),
  energyVal: $('#energyVal'),
  energyBar: $('#energyBar'),
  moraleVal: $('#moraleVal'),
  moraleBar: $('#moraleBar'),
  moraleHint: $('#moraleHint'),
  daysLeft: $('#daysLeft'),
  dutyCount: $('#dutyCount'),
  moneyTop: $('#moneyTop'),
  shopMoney: $('#shopMoney'),
  shopTrips: $('#shopTrips'),
  shopList: $('#shopList'),
  shopNote: $('#shopNote'),
  dailyList: $('#dailyList'),
  staffPosition: $('#staffPosition'),
  staffAch: $('#staffAch'),
  leaderboardBtn: $('#leaderboardBtn'),
  contractBtn: $('#contractBtn'),
  contractTitle: $('#contractTitle'),
  contractNote: $('#contractNote'),
  contractArrow: $('#contractArrow'),
  demobAlbumBtn: $('#demobAlbumBtn'),
  actionGrid: $('#actionGrid'),
  log: $('#log'),
  quote: $('#quote'),
  toasts: $('#toasts'),
  modal: $('#modal'),
  sheet: $('#sheet'),
  demob: $('#demob'),
  demobConfetti: $('#demobConfetti'),
  demobText: $('#demobText'),
  demobStats: $('#demobStats')
};

const cardEls = new Map();

/* ---------- hero render ---------- */

function renderHero() {
  const r = rankProgress();

  els.heroName.textContent = state.name;
  els.rankBadge.textContent = `${r.rank.emoji} ${r.rank.title}`;
  els.lvlChip.textContent = `ур. ${r.level} / ${r.levels}`;
  if (els.rankBadgeTop) els.rankBadgeTop.textContent = `${r.rank.emoji} ${r.rank.title}`;
  if (els.lvlChipTop) els.lvlChipTop.textContent = `ур. ${r.level} / ${r.levels}`;

  if (r.next) {
    els.xpLabel.textContent = `${r.into} / ${r.span} XP`;
  } else {
    els.xpLabel.textContent = 'максимум · дембель';
  }
  els.xpBar.style.width = `${r.pct}%`;

  els.hpVal.textContent = Math.round(state.hp);
  els.hpBar.style.width = `${clamp((state.hp / state.maxHp) * 100, 0, 100)}%`;
  els.hpHint.textContent = state.hp < 25 ? '❕ доход снижен — нужно подлечиться' : `+1 каждые ${HP_MS / 1000} сек`;
  els.hpHint.classList.toggle('is-alert', state.hp < 25);

  els.energyVal.textContent = `${Math.round(state.energy)}/${state.maxEnergy}`;
  els.energyBar.style.width = `${clamp((state.energy / state.maxEnergy) * 100, 0, 100)}%`;

  els.moraleVal.textContent = Math.round(state.morale);
  els.moraleBar.style.width = `${clamp(state.morale, 0, 100)}%`;
  els.moraleHint.textContent = `доход ×${(0.85 + (state.morale / 100) * 0.3).toFixed(2)}`;

  const days = daysUntilDemob();
  els.daysLeft.textContent = days === 0 ? 'дембель! 😎' : `${days} ${plural(days, 'день', 'дня', 'дней')}`;
  els.dutyCount.textContent = fmt(state.stats.duties);
  els.moneyTop.textContent = rub(state.money);
}

/* ---------- daily render ---------- */

function rewardParts(reward) {
  const parts = [];
  if (reward.money) parts.push(`+${fmt(reward.money)} ₽`);
  if (reward.xp) parts.push(`+${reward.xp} XP`);
  if (reward.morale) parts.push(`+${reward.morale} 🔥`);
  if (reward.hp) parts.push(`+${reward.hp} ❤️`);
  if (reward.energy) parts.push(`+${reward.energy} ⚡`);
  return parts;
}

function renderDaily() {
  els.dailyList.innerHTML = DAILY_TASKS.map((task) => {
    const done = Boolean(state.daily.done[task.id]);
    const raw = state.daily.progress[task.key] || 0;
    const prog = Math.min(raw, task.goal);
    const pct = clamp((prog / task.goal) * 100, 0, 100);

    return `
      <li class="daily ${done ? 'is-done' : ''}">
        <span class="daily-check" aria-hidden="true">${done ? '✓' : ''}</span>
        <div class="daily-main">
          <div class="daily-top">
            <span class="daily-title">${task.icon} ${task.title}</span>
            <span class="daily-reward">${rewardParts(task.reward).join(' · ')}</span>
          </div>
          <div class="bar tiny"><i style="width:${pct}%"></i></div>
          <div class="daily-progress">${done ? 'выполнено' : `${prog} / ${task.goal}`}</div>
        </div>
      </li>
    `;
  }).join('');
}

function applyReward(reward) {
  if (reward.money) {
    state.money += reward.money;
    state.stats.totalEarned = (state.stats.totalEarned || 0) + reward.money;
  }
  if (reward.morale) state.morale = clamp(state.morale + reward.morale, 0, 100);
  if (reward.hp) state.hp = clamp(state.hp + reward.hp, 0, state.maxHp);
  if (reward.energy) state.energy = clamp(state.energy + reward.energy, 0, state.maxEnergy);
  if (reward.xp) addXp(reward.xp);
}

function dailyAdd(key, amount) {
  if (!amount) return;
  state.daily.progress[key] = (state.daily.progress[key] || 0) + amount;
  checkDailyTasks();
}

function checkDailyTasks() {
  let completed = false;

  DAILY_TASKS.forEach((task) => {
    if (state.daily.done[task.id]) return;
    if ((state.daily.progress[task.key] || 0) < task.goal) return;

    state.daily.done[task.id] = true;
    applyReward(task.reward);
    completed = true;

    pushLog({
      icon: '✅',
      text: `Задание дня: ${task.title}`,
      gains: rewardParts(task.reward),
      type: 'level'
    });
    toast(`✅ Задание дня выполнено: ${task.title}`, 'good');
  });

  if (completed) {
    haptic('success');
    renderDaily();
    renderHero();
  }
}

function checkDailyReset(notify = true) {
  if (state.daily.date === todayKey()) return false;
  state.daily = {
    date: todayKey(),
    progress: { duty: 0, earn: 0, call: 0 },
    done: {}
  };
  state.shopTrips = { date: todayKey(), used: 0 };
  renderDaily();
  renderShopPanel();
  save();
  if (notify) toast('🌅 Новый день службы — задания и походы в чипок обновились', 'info');
  return true;
}

/* ---------- log render ---------- */

function timeLabel(ts) {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function renderLogEntry(entry, prepend) {
  const empty = $('.log-empty', els.log);
  if (empty) empty.remove();

  const li = document.createElement('li');
  li.className = `log-item log-${entry.type || 'info'}`;

  const gains = (entry.gains || []).map((g) => `<span>${g}</span>`).join('');

  li.innerHTML = `
    <span class="log-icon" aria-hidden="true">${entry.icon || '•'}</span>
    <div class="log-body">
      <p>${entry.text}</p>
      <div class="log-meta">
        <time>${timeLabel(entry.t)}</time>
        <div class="log-gains">${gains}</div>
      </div>
    </div>
  `;

  if (prepend) els.log.insertBefore(li, els.log.firstChild);
  else els.log.appendChild(li);

  while (els.log.children.length > MAX_LOG) {
    els.log.lastElementChild.remove();
  }
}

function renderLog() {
  els.log.innerHTML = '';
  if (!state.log.length) {
    const li = document.createElement('li');
    li.className = 'log-empty';
    li.textContent = 'Пока тихо. Самое время начать службу.';
    els.log.appendChild(li);
    return;
  }
  state.log.forEach((entry) => renderLogEntry(entry, false));
}

function pushLog({ icon, text, gains = [], type = 'info' }) {
  const entry = { t: Date.now(), icon, text, gains: gains.filter(Boolean), type };
  state.log.unshift(entry);
  state.log = state.log.slice(0, MAX_LOG);
  renderLogEntry(entry, true);
  save();
}

/* ---------- toast ---------- */

function toast(text, type = 'info') {
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.textContent = text;
  els.toasts.appendChild(el);

  window.setTimeout(() => {
    el.classList.add('out');
    window.setTimeout(() => el.remove(), 260);
  }, 2300);
}

function renderAll() {
  renderHero();
  renderDaily();
  renderStaff();
  renderShopPanel();
  updateActionStates();
  renderMoney();
}

function renderMoney() {
  els.moneyTop.textContent = rub(state.money);
}

/* ---------- leaderboard / staff ---------- */

function botScore(bot) {
  const day = Math.floor(Date.now() / 86400000);
  const jitter = (hashString(`${bot.name}:${day}`) % 41) - 20;
  return Math.max(0, bot.xp + jitter);
}

function leaderboardEntries() {
  const bots = BOTS.map((bot) => {
    const xp = botScore(bot);
    return {
      name: bot.name,
      emoji: bot.emoji,
      xp,
      rankTitle: RANKS[rankIndexFor(xp)].title,
      isPlayer: false
    };
  });

  const myRank = RANKS[rankIndexFor(state.xp)];
  const player = {
    name: state.name,
    emoji: myRank.emoji,
    xp: state.xp,
    rankTitle: myRank.title,
    isPlayer: true
  };

  return [...bots, player].sort((a, b) => b.xp - a.xp || (a.isPlayer ? -1 : 1));
}

function renderStaff() {
  if (!els.staffPosition) return;

  const entries = leaderboardEntries();
  const place = entries.findIndex((entry) => entry.isPlayer) + 1;
  const unlocked = ACHIEVEMENTS.filter((a) => state.achievements[a.id]).length;
  const ready = contractAvailable();

  els.staffPosition.textContent = state.contract
    ? `Ты на ${place} месте из ${entries.length}`
    : '🔒 доступ после контракта';
  els.staffAch.textContent = `Открыто ${unlocked} из ${ACHIEVEMENTS.length}`;
  els.leaderboardBtn.disabled = !state.contract;

  if (els.contractBtn) {
    els.contractBtn.hidden = Boolean(state.contract);
    els.contractBtn.disabled = !ready;
    els.contractBtn.classList.toggle('is-ready', ready);
    els.contractTitle.textContent = ready ? 'Подписать контракт' : 'Контракт';
    els.contractNote.textContent = ready
      ? 'Откроет рейтинг роты'
      : `После половины службы · осталось ${daysUntilContract()} ${plural(daysUntilContract(), 'день', 'дня', 'дней')}`;
    els.contractArrow.textContent = ready ? '→' : '🔒';
  }

  els.demobAlbumBtn.hidden = rankIndexFor(state.xp) < RANKS.length - 1;
}

function signContract() {
  if (state.contract) return;

  if (!contractAvailable()) {
    toast(`📄 Контракт подписывают после половины службы — осталось ${daysUntilContract()} ${plural(daysUntilContract(), 'день', 'дня', 'дней')}`, 'info');
    haptic('error');
    return;
  }

  state.contract = true;
  pushLog({
    icon: '📄',
    text: 'Контракт подписан. Теперь доступен рейтинг роты.',
    gains: [],
    type: 'level'
  });

  checkAchievements();
  renderStaff();
  renderHero();
  save();
  toast('📄 Контракт подписан! Рейтинг роты открыт', 'good');
  haptic('success');
}

/* ---------- achievements ---------- */

function checkAchievements(silent = false) {
  state.achievements = state.achievements || {};
  const newly = [];

  for (let pass = 0; pass < 3; pass++) {
    state.stats.bestMoney = Math.max(state.stats.bestMoney || 0, state.money);
    let changed = false;

    ACHIEVEMENTS.forEach((achievement) => {
      if (state.achievements[achievement.id]) return;

      let unlocked = false;
      try {
        unlocked = Boolean(achievement.check());
      } catch (e) {
        unlocked = false;
      }
      if (!unlocked) return;

      state.achievements[achievement.id] = Date.now();
      if (achievement.reward.money) {
        state.money += achievement.reward.money;
        state.stats.totalEarned += achievement.reward.money;
      }
      if (achievement.reward.morale) {
        state.morale = clamp(state.morale + achievement.reward.morale, 0, 100);
      }

      newly.push(achievement);
      changed = true;
    });

    if (!changed) break;
  }

  if (!newly.length) {
    renderStaff();
    return;
  }

  if (silent) {
    save();
    renderStaff();
    renderHero();
    return;
  }

  newly.forEach((achievement) => {
    pushLog({
      icon: achievement.icon,
      text: `Достижение: ${achievement.title}`,
      gains: rewardParts(achievement.reward),
      type: 'level'
    });
  });

  toast(
    newly.length === 1
      ? `🎖️ Достижение: ${newly[0].title}`
      : `🎖️ Новых достижений: ${newly.length}`,
    'good'
  );
  haptic('success');
  save();
  renderStaff();
  renderHero();
}

function renderLeaderboard(el) {
  const entries = leaderboardEntries();

  const rows = entries.map((entry, index) => {
    const place = index + 1;
    const medal = place === 1 ? '🥇' : place === 2 ? '🥈' : place === 3 ? '🥉' : place;

    return `
      <li class="lb-row ${entry.isPlayer ? 'is-me' : ''}">
        <span class="lb-place">${medal}</span>
        <span class="lb-avatar" aria-hidden="true">${entry.emoji}</span>
        <span class="lb-info">
          <b>${escapeHtml(entry.name)}${entry.isPlayer ? ' · это ты' : ''}</b>
          <span>${entry.rankTitle}</span>
        </span>
        <span class="lb-xp">${fmt(entry.xp)} XP</span>
      </li>
    `;
  }).join('');

  el.innerHTML = `
    <div class="sheet-handle"></div>
    <div class="sheet-head">
      <div>
        <h3 class="sheet-title">Рейтинг роты</h3>
        <p class="sheet-sub">Кто дальше всех ушёл по службе</p>
      </div>
      <button class="icon-btn" data-close aria-label="Закрыть">✕</button>
    </div>
    <ul class="lb-list">${rows}</ul>
    <p class="lb-note">Соперники — учебные боты, их очки немного меняются каждый день. Настоящий общий рейтинг появится, когда подключим бэкенд.</p>
    <button class="btn btn-ghost" data-close>Закрыть</button>
  `;
}

function renderAchievements(el) {
  const count = ACHIEVEMENTS.filter((a) => state.achievements[a.id]).length;

  const items = ACHIEVEMENTS.map((achievement) => {
    const unlocked = Boolean(state.achievements[achievement.id]);
    let note = rewardParts(achievement.reward).join(' · ');

    if (!unlocked && achievement.progress) {
      const [current, goal] = achievement.progress();
      note = `${fmt(current)} / ${fmt(goal)}`;
    }

    return `
      <div class="ach-item ${unlocked ? 'is-unlocked' : 'is-locked'}">
        <span class="ach-icon" aria-hidden="true">${unlocked ? achievement.icon : '🔒'}</span>
        <div class="ach-info">
          <span class="ach-name">${achievement.title}</span>
          <span class="ach-desc">${achievement.desc}</span>
          <span class="ach-reward">${unlocked ? 'получено' : note}</span>
        </div>
        ${unlocked ? '<span class="ach-check">✓</span>' : ''}
      </div>
    `;
  }).join('');

  el.innerHTML = `
    <div class="sheet-handle"></div>
    <div class="sheet-head">
      <div>
        <h3 class="sheet-title">Достижения</h3>
        <p class="sheet-sub">Маленькие победы большого срока</p>
      </div>
      <button class="icon-btn" data-close aria-label="Закрыть">✕</button>
    </div>
    <div class="ach-progress"><span>Открыто</span><b>${count} / ${ACHIEVEMENTS.length}</b></div>
    <div class="bar tiny" style="margin-top:6px"><i class="fill xp" style="width:${(count / ACHIEVEMENTS.length) * 100}%"></i></div>
    <div class="ach-grid">${items}</div>
    <button class="btn btn-ghost" data-close>Закрыть</button>
  `;
}

/* ---------- demob ---------- */

function clearModals() {
  modalQueue = [];
  modalOpen = false;
  els.modal.classList.remove('is-open');
  els.modal.setAttribute('aria-hidden', 'true');
  document.body.classList.remove('modal-open');
}

function showDemob() {
  demobPending = false;
  clearModals();
  state.demobSeen = true;

  const days = Math.max(1, Math.round(365 * clamp(state.xp / MAX_LEVEL_XP, 0, 1)));
  const achCount = ACHIEVEMENTS.filter((a) => state.achievements[a.id]).length;
  const favoriteEntry = Object.entries(state.stats.byAction || {}).sort((a, b) => b[1] - a[1])[0];
  const favorite = favoriteEntry ? ACTIONS.find((a) => a.id === favoriteEntry[0]) : null;

  const stats = [
    ['Дней службы', `${days} ${plural(days, 'день', 'дня', 'дней')}`],
    ['Действий', fmt(state.stats.actionsTotal || 0)],
    ['Заработано', rub(state.stats.totalEarned || 0)],
    ['Достижений', `${achCount} / ${ACHIEVEMENTS.length}`]
  ];

  if (favorite) {
    stats.push(['Любимое дело', `${favorite.icon} ${favorite.title}`]);
  }

  els.demobStats.innerHTML = stats.map(([label, value], index) => {
    const wide = stats.length % 2 === 1 && index === stats.length - 1;
    return `<div class="demob-stat"${wide ? ' style="grid-column:1/-1"' : ''}><span>${label}</span><b>${value}</b></div>`;
  }).join('');

  els.demobText.textContent = `${state.name}, год позади! Ты прошёл путь от новобранца до дембеля. Портянки сняты, берцы начищены, альбом собран.`;

  const confetti = ['🎉', '🎊', '⭐', '🎖️', '😎', '🪖'];
  els.demobConfetti.innerHTML = Array.from({ length: 16 }, (_, i) => {
    const left = (i * 6.3 + (i % 3) * 7) % 100;
    const delay = -(i % 8) * 0.6;
    const duration = 3.6 + (i % 5) * 0.5;
    const size = 14 + (i % 4) * 3;
    return `<span style="left:${left}%;animation-delay:${delay}s;animation-duration:${duration}s;font-size:${size}px">${confetti[i % confetti.length]}</span>`;
  }).join('');

  els.demob.classList.add('is-open');
  els.demob.setAttribute('aria-hidden', 'false');
  document.body.classList.add('demob-open');
  save();
  haptic('success');
}

function hideDemob() {
  els.demob.classList.remove('is-open');
  els.demob.setAttribute('aria-hidden', 'true');
  document.body.classList.remove('demob-open');
}

let demobPending = false;

/* ---------- actions render ---------- */

function actionRewardLabel(action) {
  if (action.money && action.money[1] > 0) return `+${action.money[0]}–${action.money[1]} ₽`;
  if (action.morale) return `${action.morale > 0 ? '+' : ''}${action.morale} 🔥`;
  return 'опыт';
}

function actionCardHtml(action) {
  const chips = [
    `<span class="chip-cost">⚡ ${action.energy}</span>`,
    `<span>+${action.xp[0]}–${action.xp[1]} XP</span>`
  ];

  return `
    <button class="action-card" data-action="${action.id}" aria-label="${action.title}">
      <span class="action-icon" aria-hidden="true">${action.icon}</span>
      <span class="action-main">
        <span class="action-title">${action.title}</span>
        <span class="action-desc">${action.desc}</span>
        <span class="action-chips">${chips.join('')}</span>
      </span>
      <span class="action-side">
        <span class="action-reward">${actionRewardLabel(action)}</span>
        <span class="action-status">готово</span>
      </span>
      <span class="cd-line" aria-hidden="true"></span>
    </button>
  `;
}

function renderActions() {
  els.actionGrid.innerHTML = ACTIONS.map(actionCardHtml).join('');
  cardEls.clear();

  ACTIONS.forEach((action) => {
    const root = els.actionGrid.querySelector(`[data-action="${action.id}"]`);
    if (!root) return;
    cardEls.set(action.id, {
      root,
      status: $('.action-status', root),
      line: $('.cd-line', root)
    });
  });

  updateActionStates();
}

function updateActionStates() {
  const now = Date.now();

  ACTIONS.forEach((action) => {
    const ref = cardEls.get(action.id);
    if (!ref) return;

    const remain = (state.cooldowns[action.id] || 0) - now;
    const blocker = busyBlockerFor(action.id);
    const lowEnergy = state.energy < action.energy;
    const blocked = remain <= 0 && Boolean(blocker);

    ref.root.classList.toggle('is-cd', remain > 0);
    ref.root.classList.toggle('is-locked', remain <= 0 && !blocker && lowEnergy);
    ref.root.classList.toggle('is-blocked', blocked);

    if (remain > 0) {
      ref.status.textContent = `⏱ ${fmtRemain(remain)}`;
      ref.line.style.width = `${clamp((1 - remain / (action.cooldown * ACTION_COOLDOWN_SCALE * 1000)) * 100, 0, 100)}%`;
    } else if (blocked) {
      ref.status.textContent = `⛔ ${blocker.title}`;
      ref.line.style.width = '0%';
    } else {
      ref.status.textContent = lowEnergy ? `нужно ⚡${action.energy}` : 'готово';
      ref.line.style.width = '0%';
    }
  });
}

/* ---------- xp / level ---------- */

function addXp(amount) {
  if (!amount) return;

  const before = rankIndexFor(state.xp);
  state.xp = Math.max(0, state.xp + amount);
  const after = rankIndexFor(state.xp);

  if (after <= before) return;

  const levels = after - before;
  state.maxEnergy += 3 * levels;
  state.energy = Math.min(state.maxEnergy, state.energy + 10 * levels);
  state.hp = Math.min(state.maxHp, state.hp + 15 * levels);

  const rank = RANKS[after];
  pushLog({
    icon: '🎖️',
    text: `Новое звание — ${rank.title}!`,
    gains: [`+${3 * levels} ⚡ макс.`, `+${levels} 🛒`],
    type: 'level'
  });

  if (after === RANKS.length - 1 && !state.demobSeen) {
    demobPending = true;
    pushLog({
      icon: '😎',
      text: 'Дембель! Служба окончена — можно собирать чемодан.',
      gains: [],
      type: 'level'
    });
  } else {
    openModal((el) => renderLevelSheet(el, rank, levels));
  }

  haptic('success');
}

/* ---------- events ---------- */

function triggerEvent() {
  const ev = pick(EVENTS);
  const gains = [];
  let bad = false;

  if (ev.money) {
    state.money = Math.max(0, state.money + ev.money);
    if (ev.money > 0) state.stats.totalEarned = (state.stats.totalEarned || 0) + ev.money;
    gains.push(`${ev.money > 0 ? '+' : ''}${fmt(ev.money)} ₽`);
  }
  if (ev.xp) {
    addXp(ev.xp);
    gains.push(`${ev.xp > 0 ? '+' : ''}${ev.xp} XP`);
  }
  if (ev.hp) {
    state.hp = clamp(state.hp + ev.hp, 0, state.maxHp);
    gains.push(`${ev.hp > 0 ? '+' : ''}${ev.hp} ❤️`);
    if (ev.hp < 0) bad = true;
  }
  if (ev.energy) {
    state.energy = clamp(state.energy + ev.energy, 0, state.maxEnergy);
    gains.push(`${ev.energy > 0 ? '+' : ''}${ev.energy} ⚡`);
    if (ev.energy < 0) bad = true;
  }
  if (ev.morale) {
    state.morale = clamp(state.morale + ev.morale, 0, 100);
    gains.push(`${ev.morale > 0 ? '+' : ''}${ev.morale} 🔥`);
    if (ev.morale < 0) bad = true;
  }

  state.stats.events = (state.stats.events || 0) + 1;

  pushLog({
    icon: ev.icon,
    text: `${ev.title}. ${ev.text}`,
    gains,
    type: bad ? 'bad' : 'good'
  });

  return { ev, gains, bad };
}

/* ---------- action execution ---------- */

function doAction(id) {
  const action = ACTIONS.find((a) => a.id === id);
  if (!action) return;

  const now = Date.now();
  const remaining = (state.cooldowns[id] || 0) - now;

  if (remaining > 0) {
    toast(`⏱ Ещё ${fmtRemain(remaining)} — рано`, 'info');
    return;
  }

  const blocker = busyBlockerFor(id);
  if (blocker) {
    toast(`⛔ Сначала закончите: ${blocker.title.toLowerCase()}`, 'info');
    haptic('error');
    return;
  }

  if (state.energy < action.energy) {
    toast('⚡ Не хватает энергии — отдохни или загляни в чипок', 'bad');
    haptic('error');
    return;
  }

  state.energy -= action.energy;

  const mult = rewardMultiplier();
  const xpGain = Math.max(1, Math.round(rand(action.xp[0], action.xp[1]) * mult));
  const moneyGain = Math.round(rand(action.money[0], action.money[1]) * mult);
  const moraleGain = action.morale || 0;

  state.money += moneyGain;
  state.morale = clamp(state.morale + moraleGain, 0, 100);
  state.cooldowns[id] = now + action.cooldown * ACTION_COOLDOWN_SCALE * 1000;
  if (action.busy) state.busy = { id, until: now + action.busy * 1000 };
  if (action.duty) state.stats.duties += 1;
  state.stats.totalEarned += moneyGain;
  state.stats.actionsTotal = (state.stats.actionsTotal || 0) + 1;
  state.stats.byAction = state.stats.byAction || {};
  state.stats.byAction[id] = (state.stats.byAction[id] || 0) + 1;

  addXp(xpGain);

  dailyAdd('duty', action.duty ? 1 : 0);
  dailyAdd('earn', moneyGain);
  if (id === 'call') dailyAdd('call', 1);

  const gains = [`+${xpGain} XP`];
  if (moneyGain > 0) gains.push(`+${fmt(moneyGain)} ₽`);
  if (moraleGain) gains.push(`${moraleGain > 0 ? '+' : ''}${moraleGain} 🔥`);

  pushLog({
    icon: action.icon,
    text: pick(action.flavor),
    gains,
    type: moraleGain < 0 ? 'bad' : 'good'
  });

  let event = null;
  if (Math.random() < EVENT_CHANCE) event = triggerEvent();

  checkAchievements();
  renderAll();
  save();
  haptic('success');

  const toastParts = [`+${xpGain} XP`];
  if (moneyGain > 0) toastParts.push(`+${fmt(moneyGain)} ₽`);
  toast(`${action.icon} ${action.title}: ${toastParts.join(' · ')}`, 'good');

  if (event) openModal((el) => renderEventSheet(el, event));
  if (demobPending) window.setTimeout(showDemob, 500);
}

/* ---------- modals ---------- */

let modalQueue = [];
let modalOpen = false;

function openModal(renderer) {
  modalQueue.push(renderer);
  if (!modalOpen) showNextModal();
}

function showNextModal() {
  const renderer = modalQueue.shift();

  if (!renderer) {
    modalOpen = false;
    els.modal.classList.remove('is-open');
    els.modal.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('modal-open');
    return;
  }

  modalOpen = true;
  document.body.classList.add('modal-open');
  els.modal.classList.add('is-open');
  els.modal.setAttribute('aria-hidden', 'false');
  els.sheet.innerHTML = '';
  renderer(els.sheet);
  els.sheet.scrollTop = 0;
}

function closeModal() {
  showNextModal();
}

function renderLevelSheet(el, rank, levels) {
  el.innerHTML = `
    <div class="sheet-emoji">${rank.emoji}</div>
    <h3 class="sheet-title">Новое звание!</h3>
    <p class="sheet-text">Теперь ты — <b>${rank.title}</b>. Сослуживцы смотрят с уважением, а прапорщик — с подозрением.</p>
    <div class="sheet-rewards">
      <span class="reward-pill">+${levels * 3} ⚡ к максимуму</span>
      <span class="reward-pill">+${levels * 15} ❤️</span>
      <span class="reward-pill">+${levels} ${plural(levels, 'поход', 'похода', 'походов')} в чипок</span>
    </div>
    <button class="btn btn-primary" data-close>Служу Отечеству!</button>
  `;
}

function renderEventSheet(el, result) {
  const { ev, gains, bad } = result;

  el.innerHTML = `
    <div class="sheet-emoji">${ev.icon}</div>
    <h3 class="sheet-title">${ev.title}</h3>
    <p class="sheet-text">${ev.text}</p>
    ${gains.length ? `<div class="sheet-rewards">${gains.map((g) => `<span class="reward-pill ${bad ? 'is-bad' : ''}">${g}</span>`).join('')}</div>` : ''}
    <button class="btn btn-primary" data-close>Принято</button>
  `;
}

function renderShopPanel() {
  if (!els.shopList) return;

  const left = shopTripsLeft();
  const limit = shopTripsLimit();
  const noTrips = left <= 0;

  els.shopMoney.textContent = rub(state.money);
  els.shopTrips.innerHTML = `Походы в чипок: <b>${left}</b> из ${limit}`;
  els.shopTrips.classList.toggle('is-empty', noTrips);
  els.shopNote.textContent = noTrips
    ? 'Походы на сегодня закончились. Новые дадут за звание или завтра.'
    : 'Один поход — одна покупка. Каждое новое звание добавляет поход, а лимит обновляется каждый день.';

  els.shopList.innerHTML = SHOP.map((item) => {
    const bought = state.purchases[item.id] || 0;
    const soldOut = Boolean(item.max) && bought >= item.max;
    const poor = state.money < item.price;
    const label = soldOut ? 'макс.' : (noTrips ? 'нет походов' : rub(item.price));

    return `
      <li class="shop-item ${soldOut ? 'is-sold' : ''}">
        <span class="shop-icon" aria-hidden="true">${item.icon}</span>
        <div class="shop-info">
          <b>${item.name}</b>
          <span>${item.desc}</span>
        </div>
        <button class="buy-btn ${poor && !soldOut && !noTrips ? 'is-poor' : ''}" data-buy="${item.id}" ${soldOut || noTrips ? 'disabled' : ''}>${label}</button>
      </li>
    `;
  }).join('');
}

function buyItem(id) {
  const item = SHOP.find((i) => i.id === id);
  if (!item) return;

  const bought = state.purchases[id] || 0;

  if (shopTripsLeft() <= 0) {
    toast('🛒 Походы в чипок закончились — новые дадут за звание или завтра', 'info');
    haptic('error');
    return;
  }

  if (item.max && bought >= item.max) {
    toast('Больше не продаём — склад пуст', 'info');
    return;
  }

  if (state.money < item.price) {
    toast(`💸 Не хватает ${rub(item.price - state.money)}`, 'bad');
    haptic('error');
    return;
  }

  if (item.blocked && item.blocked()) {
    toast(item.fullMsg || 'Сейчас это не нужно', 'info');
    return;
  }

  state.money -= item.price;
  state.purchases[id] = bought + 1;
  state.shopTrips.used = (state.shopTrips.used || 0) + 1;
  state.stats.buys = (state.stats.buys || 0) + 1;
  item.apply();

  pushLog({
    icon: item.icon,
    text: `Куплено: ${item.name}`,
    gains: [`−${fmt(item.price)} ₽`],
    type: 'shop'
  });

  checkAchievements();
  save();
  renderAll();

  toast(`${item.icon} ${item.name} — куплено · походов осталось: ${shopTripsLeft()}`, 'good');
  haptic('success');
}

function renderResetConfirm(el) {
  el.innerHTML = `
    <div class="sheet-emoji">🔄</div>
    <h3 class="sheet-title">Начать службу заново?</h3>
    <p class="sheet-text">Весь прогресс, деньги и звания сгорят. Как будто снова призыв.</p>
    <div class="sheet-actions">
      <button class="btn btn-ghost" data-close>Отмена</button>
      <button class="btn btn-danger" id="confirmReset">Сбросить</button>
    </div>
  `;

  const btn = $('#confirmReset', el);
  if (btn) {
    btn.addEventListener('click', () => {
      isResetting = true;
      clearTimeout(saveTimer);
      try {
        localStorage.removeItem(SAVE_KEY);
      } catch (e) {
        /* ignore */
      }
      window.location.reload();
    });
  }
}

/* ---------- tabs ---------- */

function setTab(tab) {
  $$('.panel').forEach((panel) => {
    panel.classList.toggle('is-active', panel.dataset.panel === tab);
  });
  $$('.nav-btn').forEach((btn) => {
    btn.classList.toggle('is-active', btn.dataset.tab === tab);
  });

  if (window.matchMedia('(max-width: 719px)').matches) {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
}

/* ---------- game loop ---------- */

function tick() {
  const now = Date.now();
  let changed = false;

  if (state.busy?.id && state.busy.until <= now) {
    state.busy = { id: null, until: 0 };
    changed = true;
  }

  if (state.energy < state.maxEnergy) {
    const gain = Math.floor((now - state.lastEnergyAt) / ENERGY_MS);
    if (gain > 0) {
      state.energy = Math.min(state.maxEnergy, state.energy + gain);
      state.lastEnergyAt += gain * ENERGY_MS;
      changed = true;
    }
  } else {
    state.lastEnergyAt = now;
  }

  if (state.hp < state.maxHp) {
    const gain = Math.floor((now - state.lastHpAt) / HP_MS);
    if (gain > 0) {
      state.hp = Math.min(state.maxHp, state.hp + gain);
      state.lastHpAt += gain * HP_MS;
      changed = true;
    }
  } else {
    state.lastHpAt = now;
  }

  if (changed) {
    renderHero();
    save();
  }

  updateActionStates();
  checkDailyReset();
}

/* ---------- boot ---------- */

function initTelegram() {
  if (!tg) return;
  try {
    tg.ready();
    tg.expand();
    if (tg.setHeaderColor) tg.setHeaderColor('#0d0f0b');
    if (tg.setBackgroundColor) tg.setBackgroundColor('#0d0f0b');
  } catch (e) {
    /* Telegram API may be partially available */
  }
}

function seedLog() {
  if (state.log.length) return;
  state.log.push({
    t: Date.now(),
    icon: '🪖',
    text: 'Добро пожаловать в казарму! Начни с зарядки — энергия уже капает.',
    gains: [],
    type: 'info'
  });
}

function bindEvents() {
  els.actionGrid.addEventListener('click', (e) => {
    const card = e.target.closest('[data-action]');
    if (!card) return;
    doAction(card.dataset.action);
  });

  $$('.nav-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      setTab(btn.dataset.tab);
      haptic();
    });
  });

  $('#shopBtn').addEventListener('click', () => {
    haptic();
    setTab('shop');
  });

  if (els.shopList) {
    els.shopList.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-buy]');
      if (btn) buyItem(btn.dataset.buy);
    });
  }

  $('#resetBtn').addEventListener('click', () => {
    haptic();
    openModal(renderResetConfirm);
  });

  const contractBtn = $('#contractBtn');
  if (contractBtn) {
    contractBtn.addEventListener('click', signContract);
  }

  const leaderboardBtn = $('#leaderboardBtn');
  if (leaderboardBtn) {
    leaderboardBtn.addEventListener('click', () => {
      haptic();
      if (!state.contract) {
        toast('🔒 Рейтинг откроется после подписания контракта', 'info');
        return;
      }
      openModal(renderLeaderboard);
    });
  }

  const achievementsBtn = $('#achievementsBtn');
  if (achievementsBtn) {
    achievementsBtn.addEventListener('click', () => {
      haptic();
      openModal(renderAchievements);
    });
  }

  if (els.demobAlbumBtn) {
    els.demobAlbumBtn.addEventListener('click', () => {
      haptic();
      showDemob();
    });
  }

  const demobClose = $('#demobClose');
  if (demobClose) demobClose.addEventListener('click', hideDemob);
  const demobStay = $('#demobStay');
  if (demobStay) {
    demobStay.addEventListener('click', () => {
      haptic();
      hideDemob();
      toast('😎 Дембель никуда не денется — служба продолжается', 'good');
    });
  }
  const demobNew = $('#demobNew');
  if (demobNew) {
    demobNew.addEventListener('click', () => {
      haptic();
      hideDemob();
      openModal(renderResetConfirm);
    });
  }

  els.demob.addEventListener('click', (e) => {
    if (e.target === els.demob) hideDemob();
  });

  els.modal.addEventListener('click', (e) => {
    if (e.target === els.modal || e.target.closest('[data-close]')) {
      closeModal();
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (els.demob.classList.contains('is-open')) {
      hideDemob();
      return;
    }
    if (modalOpen) closeModal();
  });

  window.addEventListener('pagehide', saveNow);

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') saveNow();
  });
}

function boot() {
  initTelegram();
  applyOfflineRegen();
  checkDailyReset(false);
  seedLog();
  els.quote.textContent = pick(QUOTES);
  renderActions();
  renderAll();
  renderLog();
  bindEvents();
  checkAchievements(true);
  save();

  if (rankIndexFor(state.xp) >= RANKS.length - 1 && !state.demobSeen) {
    window.setTimeout(showDemob, 900);
  }

  window.setInterval(tick, 1000);
}

boot();



