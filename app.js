/* СРОЧНИК — прототип Telegram MiniApp.
   Игра про армейский быт: наряды, чипок, боевой дух и путь до дембеля. */

'use strict';

const SAVE_KEY = 'srochnik.save.v1';
const ENERGY_MS = 8000;
const HP_MS = 30000;
const EVENT_CHANCE = 0.16;
const MAX_LOG = 40;
const SERVICE_DAYS = 365;
const DAY_MS = 86400000;
const HOUR_MS = 3600000;
const CONTRACT_DAY = 182; // половина службы
const CONTRACT_RANK = 3; // младший сержант
const PACKAGE_DELAY_MS = 2 * HOUR_MS;
const LEAVE_COOLDOWN_MS = 7 * DAY_MS;

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

function yesterdayKey() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function fmtDuration(ms) {
  const totalMin = Math.max(1, Math.ceil(ms / 60000));
  if (totalMin >= 60) {
    const h = Math.floor(totalMin / 60);
    const m = totalMin % 60;
    return m ? `${h} ч ${m} мин` : `${h} ч`;
  }
  return `${totalMin} мин`;
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
  { xp: 0, title: 'Курсант', emoji: '📚' },
  { xp: 300, title: 'Рядовой', emoji: '🪖' },
  { xp: 900, title: 'Ефрейтор', emoji: '🎖️' },
  { xp: 1800, title: 'Младший сержант', emoji: '🎖️' },
  { xp: 3000, title: 'Сержант', emoji: '🥇', contract: true },
  { xp: 4500, title: 'Старший сержант', emoji: '🏅', contract: true }
];

const PERIODS = [
  { id: 'training', title: 'Учебка', emoji: '📚', from: 0, to: 29, note: 'курс молодого бойца' },
  { id: 'young', title: 'Молодой', emoji: '🪖', from: 30, to: 181, note: 'служба идёт' },
  { id: 'chepak', title: 'Черпак', emoji: '🥄', from: 182, to: 264, note: 'половина позади' },
  { id: 'ded', title: 'Дед', emoji: '🧔', from: 265, to: 364, note: 'дембель близко' },
  { id: 'demob', title: 'Дембель', emoji: '😎', from: 365, to: Infinity, note: 'служба окончена' }
];

const DUTIES = {
  kitchen: {
    icon: '🥔',
    title: 'Наряд на кухню',
    desc: 'Почистить картошку для роты',
    money: [45, 75],
    xp: [6, 10],
    morale: -1,
    flavor: [
      'Три ведра картошки — и ни одной мозоли.',
      'Повар угостил горячим пирожком. Жизнь удалась.',
      'Картошка почищена. Рота спасена от голода.'
    ]
  },
  plaz: {
    icon: '🧹',
    title: 'Наряд по плацу',
    desc: 'Подмести плац от листьев',
    money: [30, 50],
    xp: [8, 12],
    morale: 0,
    flavor: [
      'Плац блестит — даже командир заметил.',
      'Листья закончились, метла осталась.',
      'Подмёл так, что ветер позавидовал.'
    ]
  },
  kpp: {
    icon: '🚧',
    title: 'Наряд на КПП',
    desc: 'Проверять пропуска и здороваться',
    money: [60, 90],
    xp: [10, 14],
    morale: -2,
    flavor: [
      'Пропуска проверены, скука побеждена.',
      'Через КПП прошёл даже прапорщик. С пропуском.',
      'Стоял на воротах, как памятник.'
    ]
  },
  sklad: {
    icon: '📦',
    title: 'Наряд на складе',
    desc: 'Пересчитать имущество',
    money: [40, 70],
    xp: [7, 11],
    morale: -1,
    flavor: [
      'Имущество сошлось. Почти.',
      'Нашёл на складе то, что искали всем взводом.',
      'Пересчитал берцы. Их стало больше.'
    ]
  }
};

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
    hours: 1,
    minPeriod: 0,
    flavor: [
      'Кросс сдан. Плац остался позади.',
      'Подтянулся двенадцать раз. Командир кивнул.',
      'Разминка прошла бодро — даже берцы не скрипят.'
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
    hours: 2,
    minPeriod: 0,
    flavor: [
      'Шаг чеканил так, что гул пошёл по плацу.',
      '«Раз-два, левой!» — и ты в идеальном строю.',
      'Командир роты поставил тебя в пример.'
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
    hours: 1,
    minPeriod: 0,
    flavor: [
      'Мама передала привет и посылку с печеньем.',
      '«Кушаешь ли ты там?» — спросила мама. Ты соврал: да.',
      'Пять минут разговора — и как будто дома побывал.'
    ]
  },
  {
    id: 'duty',
    icon: '🧹',
    title: 'Наряд',
    desc: 'Развод на наряд дня',
    energy: 14,
    xp: [6, 10],
    money: [45, 75],
    morale: -1,
    hours: 3,
    minPeriod: 0,
    duty: true,
    dynamic: true,
    flavor: [
      'Наряд сдан. Рота довольна.',
      'Работа спорилась — даже метла не сломалась.',
      'Сделал всё по уставу и чуть-чуть сверху.'
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
    hours: 2,
    minPeriod: 1,
    flavor: [
      'Прапорщик остался доволен. Это редкость.',
      'Плац блестит, а в кармане звенит.',
      '«Хороший ты боец», — сказал прапорщик.'
    ]
  },
  {
    id: 'guard',
    icon: '🛡️',
    title: 'Караул',
    desc: 'Четыре часа на посту, всё по уставу',
    energy: 22,
    xp: [24, 34],
    money: [100, 160],
    morale: -3,
    hours: 4,
    minPeriod: 1,
    flavor: [
      'Смена прошла спокойно. Даже ворон не пролетел.',
      'На посту думал о доме. Время шло медленно.',
      'Сдал пост по уставу — без замечаний.'
    ]
  },
  {
    id: 'mentor',
    icon: '🧑‍🏫',
    title: 'Учить молодых',
    desc: 'Показать, как подшивать воротничок',
    energy: 12,
    xp: [20, 30],
    money: [20, 40],
    morale: 4,
    hours: 3,
    minPeriod: 3,
    flavor: [
      'Молодые слушают. Дед доволен.',
      'Показал, как правильно подшивать — и как не надо.',
      'Теперь в роте на одного знающего больше.'
    ]
  },
  {
    id: 'demobAccord',
    icon: '🎒',
    title: 'Дембельский аккорд',
    desc: 'Последний большой рывок перед дембелем',
    energy: 30,
    xp: [60, 90],
    money: [200, 300],
    morale: 10,
    hours: 6,
    cooldownHours: 24,
    minPeriod: 4,
    flavor: [
      'Сделал так, что рота запомнит надолго.',
      'Дембельский аккорд выполнен. Можно собирать чемодан.',
      'Последний рывок — и ни одного замечания.'
    ]
  }
];

function dutyType() {
  return DUTIES[state.duty?.type] ? state.duty.type : 'kitchen';
}

function actionFor(id) {
  const base = ACTIONS.find((a) => a.id === id);
  if (!base) return null;
  if (id === 'duty') return { ...base, ...DUTIES[dutyType()] };
  return base;
}

const SHOP = [
  {
    id: 'pie',
    icon: '🥟',
    name: 'Пирожок с картошкой',
    desc: '+15 энергии и +4 духа',
    price: 30,
    temporary: true,
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
    temporary: true,
    fullMsg: 'Дух и так боевой',
    blocked: () => state.morale >= 100,
    apply: () => {
      state.morale = clamp(state.morale + 14, 0, 100);
    }
  },
  {
    id: 'energy',
    icon: '⚡',
    name: 'Энергетик «Дизель»',
    desc: '+35 энергии',
    price: 60,
    temporary: true,
    fullMsg: 'Энергия и так на максимуме',
    blocked: () => state.energy >= state.maxEnergy,
    apply: () => {
      state.energy = Math.min(state.maxEnergy, state.energy + 35);
    }
  },
  {
    id: 'medkit',
    icon: '💊',
    name: 'Бинт и йод',
    desc: '+25 здоровья',
    price: 70,
    temporary: true,
    fullMsg: 'Здоровье и так в порядке',
    blocked: () => state.hp >= state.maxHp,
    apply: () => {
      state.hp = Math.min(state.maxHp, state.hp + 25);
    }
  },
  {
    id: 'pillow',
    icon: '🛏️',
    name: 'Подушка поудобнее',
    desc: '+10 к максимуму энергии навсегда',
    price: 150,
    max: 3,
    permanent: true,
    apply: () => {
      state.maxEnergy += 10;
      state.energy = Math.min(state.maxEnergy, state.energy + 10);
    }
  },
  {
    id: 'kettle',
    icon: '🫖',
    name: 'Чайник в тумбочку',
    desc: '+5 боевого духа каждое утро',
    price: 220,
    max: 2,
    permanent: true,
    apply: () => {
      state.morale = clamp(state.morale + 5, 0, 100);
    }
  },
  {
    id: 'boots',
    icon: '🥾',
    name: 'Новые берцы',
    desc: '+5 к максимуму энергии навсегда',
    price: 300,
    max: 4,
    permanent: true,
    apply: () => {
      state.maxEnergy += 5;
      state.energy = Math.min(state.maxEnergy, state.energy + 5);
    }
  },
  {
    id: 'locker',
    icon: '🗄️',
    name: 'Тумбочка с замком',
    desc: '+1 поход в чипок каждый день',
    price: 400,
    max: 2,
    permanent: true,
    apply: () => {
      /* лимит походов считается в shopTripsLimit() */
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
    id: 'hours',
    icon: '🕒',
    title: 'Отслужить 4 часа',
    key: 'hours',
    goal: 4,
    unit: 'ч',
    reward: { money: 80, xp: 20 }
  },
  {
    id: 'earn',
    icon: '💰',
    title: 'Заработать 250 ₽',
    key: 'earn',
    goal: 250,
    unit: '₽',
    reward: { money: 60, morale: 8 }
  },
  {
    id: 'call',
    icon: '📞',
    title: 'Позвонить маме',
    key: 'call',
    goal: 1,
    unit: '',
    reward: { morale: 15, xp: 15 }
  }
];

const STREAK_MILESTONES = {
  3: { icon: '🔥', reward: { money: 100 } },
  7: { icon: '🔥', reward: { energy: 20, morale: 5 } },
  14: { icon: '🔥', reward: { money: 300 } },
  30: { icon: '🔥', reward: { xp: 50, morale: 10 } }
};

const QUESTS = [
  {
    id: 'stitch',
    icon: '🪡',
    title: 'Подшить воротничок',
    desc: 'Строевая — 1 раз',
    reward: { money: 40, xp: 10 },
    check: () => (state.stats.byAction?.drill || 0) >= 1
  },
  {
    id: 'grass',
    icon: '🌿',
    title: 'Покрасить траву',
    desc: 'Сходить в наряд 2 раза',
    reward: { money: 60, xp: 15 },
    check: () => (state.stats.byAction?.duty || 0) >= 2
  },
  {
    id: 'kettle',
    icon: '🫖',
    title: 'Найти чайник',
    desc: 'Заработать 150 ₽ за службу',
    reward: { money: 50, morale: 10 },
    check: () => (state.stats.totalEarned || 0) >= 150
  },
  {
    id: 'guard',
    icon: '🛡️',
    title: 'Постоять в карауле',
    desc: 'Караул — 1 раз',
    reward: { money: 80, xp: 20 },
    check: () => (state.stats.byAction?.guard || 0) >= 1
  },
  {
    id: 'call',
    icon: '📞',
    title: 'Позвонить маме',
    desc: 'Звонок — 1 раз',
    reward: { morale: 15, xp: 10 },
    check: () => (state.stats.byAction?.call || 0) >= 1
  },
  {
    id: 'help',
    icon: '🧹',
    title: 'Помочь прапорщику',
    desc: 'Помощь — 2 раза',
    reward: { money: 70, xp: 20 },
    check: () => (state.stats.byAction?.help || 0) >= 2
  },
  {
    id: 'rich',
    icon: '💰',
    title: 'Накопить 500 ₽',
    desc: 'В кармане 500 ₽',
    reward: { money: 100 },
    check: () => state.money >= 500
  },
  {
    id: 'efreitor',
    icon: '🎖️',
    title: 'Стать ефрейтором',
    desc: 'Звание Ефрейтор',
    reward: { money: 80, xp: 30 },
    check: () => rankIndexFor(state.xp, state.contract) >= 2
  },
  {
    id: 'leave',
    icon: '🚌',
    title: 'Сходить в увольнительную',
    desc: 'Увольнительная — 1 раз',
    reward: { money: 120, morale: 10 },
    check: () => (state.stats.leaves || 0) >= 1
  },
  {
    id: 'package',
    icon: '📦',
    title: 'Получить посылку',
    desc: 'Посылка из дома — 1 раз',
    reward: { money: 60, energy: 20 },
    check: () => (state.stats.packages || 0) >= 1
  },
  {
    id: 'sergeant',
    icon: '🥇',
    title: 'Стать сержантом',
    desc: 'Подписать контракт и получить звание',
    reward: { money: 200, xp: 50 },
    check: () => rankIndexFor(state.xp, state.contract) >= 4
  },
  {
    id: 'demob',
    icon: '😎',
    title: 'Дослужить до дембеля',
    desc: '365 дней службы',
    reward: { money: 500 },
    check: () => daysUntilDemob() <= 0
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
    id: 'duty',
    icon: '🧹',
    title: 'Нарядный мастер',
    desc: 'Сходить в наряд 5 раз',
    reward: { money: 70 },
    progress: () => [Math.min(state.stats.byAction?.duty || 0, 5), 5],
    check: () => (state.stats.byAction?.duty || 0) >= 5
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
    check: () => rankIndexFor(state.xp, state.contract) >= 2
  },
  {
    id: 'sergeant',
    icon: '🏅',
    title: 'Старший сержант',
    desc: 'Подписать контракт и дослужиться до старшего сержанта',
    reward: { money: 120 },
    check: () => rankIndexFor(state.xp, state.contract) >= 5
  },
  {
    id: 'demob',
    icon: '😎',
    title: 'Дембель',
    desc: 'Дослужить до дембеля — 365 дней',
    reward: { money: 300 },
    check: () => daysUntilDemob() <= 0
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
    busy: { id: null, title: '', icon: '', until: 0 },
    purchases: { boots: 0, pillow: 0, kettle: 0, locker: 0 },
    shopTrips: { date: todayKey(), used: 0 },
    duty: { date: todayKey(), type: pick(Object.keys(DUTIES)) },
    package: { date: todayKey(), sentAt: 0, readyAt: 0, claimed: false },
    leaveAt: 0,
    sickbay: { date: todayKey(), used: false },
    streak: { count: 0, lastDate: '' },
    quest: { index: 0 },
    daily: {
      date: todayKey(),
      progress: { hours: 0, earn: 0, call: 0 },
      done: {}
    },
    stats: {
      duties: 0,
      totalEarned: 0,
      actionsTotal: 0,
      byAction: {},
      events: 0,
      buys: 0,
      bestMoney: 120,
      leaves: 0,
      packages: 0,
      hours: 0
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
    const savedBusy = saved.busy || {};
    const knownBusy = savedBusy.id ? ACTIONS.find((a) => a.id === savedBusy.id) : null;
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
        id: savedBusy.id || null,
        title: savedBusy.title || knownBusy?.title || (savedBusy.id ? 'Занятие' : ''),
        icon: savedBusy.icon || knownBusy?.icon || (savedBusy.id ? '⏳' : ''),
        until: Number(savedBusy.until) || 0
      },
      shopTrips: {
        date: saved.shopTrips?.date || base.shopTrips.date,
        used: Math.max(0, Number(saved.shopTrips?.used) || 0)
      },
      duty: {
        date: saved.duty?.date || base.duty.date,
        type: DUTIES[saved.duty?.type] ? saved.duty.type : base.duty.type
      },
      package: {
        date: saved.package?.date || base.package.date,
        sentAt: Number(saved.package?.sentAt) || 0,
        readyAt: Number(saved.package?.readyAt) || 0,
        claimed: Boolean(saved.package?.claimed)
      },
      leaveAt: Number(saved.leaveAt) || 0,
      sickbay: {
        date: saved.sickbay?.date || base.sickbay.date,
        used: Boolean(saved.sickbay?.used)
      },
      streak: {
        count: Math.max(0, Number(saved.streak?.count) || 0),
        lastDate: saved.streak?.lastDate || ''
      },
      quest: {
        index: clamp(Number(saved.quest?.index) || 0, 0, QUESTS.length)
      },
      log: Array.isArray(saved.log) ? saved.log : []
    };

    merged.maxEnergy = clamp(Number(merged.maxEnergy) || 100, 100, 500);
    merged.maxHp = clamp(Number(merged.maxHp) || 100, 100, 300);
    merged.energy = clamp(Number(merged.energy) || 0, 0, merged.maxEnergy);
    merged.hp = clamp(Number(merged.hp) || 0, 0, merged.maxHp);
    merged.morale = clamp(Number(merged.morale) || 0, 0, 100);
    merged.money = Math.max(0, Number(merged.money) || 0);
    merged.xp = Math.max(0, Number(merged.xp) || 0);
    merged.startedAt = Number(merged.startedAt) || Date.now();
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

function daysServed() {
  return Math.max(0, Math.floor((Date.now() - state.startedAt) / DAY_MS));
}

function periodIndexForDay(day) {
  for (let i = PERIODS.length - 1; i >= 0; i--) {
    if (day >= PERIODS[i].from) return i;
  }
  return 0;
}

function currentPeriod() {
  return PERIODS[periodIndexForDay(daysServed())];
}

function periodProgress() {
  const day = daysServed();
  const idx = periodIndexForDay(day);
  const period = PERIODS[idx];
  const length = period.to === Infinity ? 1 : period.to - period.from + 1;
  const dayInPeriod = clamp(day - period.from + 1, 1, length);
  return { day, idx, period, length, dayInPeriod };
}

function rankIndexFor(xp, contract = state.contract) {
  let idx = 0;
  for (let i = 0; i < RANKS.length; i++) {
    if (xp >= RANKS[i].xp) idx = i;
  }
  if (!contract && idx > CONTRACT_RANK) idx = CONTRACT_RANK;
  return idx;
}

function rankProgress() {
  const idx = rankIndexFor(state.xp, state.contract);
  const rank = RANKS[idx];
  const next = RANKS[idx + 1] || null;
  const capped = !state.contract && idx >= CONTRACT_RANK;
  const into = state.xp - rank.xp;
  const span = next ? next.xp - rank.xp : 1;

  return {
    idx,
    rank,
    next: capped ? null : next,
    into,
    span,
    capped,
    pct: next && !capped ? clamp((into / span) * 100, 0, 100) : 100
  };
}

function rewardMultiplier() {
  const hpMod = state.hp < 25 ? 0.6 : 1;
  const moraleMod = 0.85 + (clamp(state.morale, 0, 100) / 100) * 0.3;
  return hpMod * moraleMod;
}

function daysUntilDemob() {
  return Math.max(0, SERVICE_DAYS - daysServed());
}

function contractAvailable() {
  return !state.contract && daysServed() >= CONTRACT_DAY && rankIndexFor(state.xp, false) >= CONTRACT_RANK;
}

function daysUntilContract() {
  if (state.contract) return 0;
  return Math.max(0, CONTRACT_DAY - daysServed());
}

function shopTripsLimit() {
  return 1 + rankIndexFor(state.xp, state.contract) + (state.purchases?.locker || 0);
}

function shopTripsLeft() {
  return Math.max(0, shopTripsLimit() - (state.shopTrips?.used || 0));
}

function busyAction() {
  if (!state.busy?.id) return null;
  if (state.busy.until <= Date.now()) return null;
  return {
    id: state.busy.id,
    title: state.busy.title || 'Занятие',
    icon: state.busy.icon || '⏳',
    until: state.busy.until
  };
}

function busyBlockerFor() {
  return busyAction();
}

function requireFree() {
  const blocker = busyAction();
  if (!blocker) return true;
  toast(`⛔ Сначала закончите: ${blocker.title.toLowerCase()}`, 'info');
  haptic('error');
  return false;
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
  periodMeta: $('#periodMeta'),
  streakMeta: $('#streakMeta'),
  moneyTop: $('#moneyTop'),
  shopMoney: $('#shopMoney'),
  shopTrips: $('#shopTrips'),
  shopList: $('#shopList'),
  shopNote: $('#shopNote'),
  dailyList: $('#dailyList'),
  careList: $('#careList'),
  questBody: $('#questBody'),
  questCounter: $('#questCounter'),
  dutyPicker: $('#dutyPicker'),
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
  const p = periodProgress();

  els.heroName.textContent = state.name;
  els.rankBadge.textContent = `${r.rank.emoji} ${r.rank.title}`;
  const periodText = `${p.period.emoji} ${p.period.title} · ${p.dayInPeriod}/${p.length}`;
  els.lvlChip.textContent = periodText;
  if (els.rankBadgeTop) els.rankBadgeTop.textContent = `${r.rank.emoji} ${r.rank.title}`;
  if (els.lvlChipTop) els.lvlChipTop.textContent = periodText;

  if (r.capped) {
    els.xpLabel.textContent = `макс. до контракта · ${r.into} XP`;
  } else if (r.next) {
    els.xpLabel.textContent = `${r.into} / ${r.span} XP`;
  } else {
    els.xpLabel.textContent = 'максимум · старший сержант';
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
  if (els.periodMeta) els.periodMeta.textContent = `${p.period.emoji} ${p.period.title}`;
  if (els.streakMeta) els.streakMeta.textContent = `${state.streak?.count || 0} ${plural(state.streak?.count || 0, 'день', 'дня', 'дней')}`;
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
          <div class="daily-progress">${done ? 'выполнено' : `${prog} / ${task.goal}${task.unit ? ' ' + task.unit : ''}`}</div>
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

function assignDailyDuty() {
  const keys = Object.keys(DUTIES);
  const p = periodProgress();
  const current = state.duty?.type;
  const type = p.idx >= 2 && DUTIES[current] ? current : pick(keys);
  state.duty = { date: todayKey(), type };
}

function updateStreak() {
  const today = todayKey();
  if (state.streak.lastDate === today) return;
  if (state.streak.lastDate === yesterdayKey()) state.streak.count += 1;
  else state.streak.count = 1;
  state.streak.lastDate = today;

  const milestone = STREAK_MILESTONES[state.streak.count];
  if (!milestone) return;

  applyReward(milestone.reward);
  pushLog({
    icon: milestone.icon,
    text: `Стрик входов: ${state.streak.count} ${plural(state.streak.count, 'день', 'дня', 'дней')} подряд!`,
    gains: rewardParts(milestone.reward),
    type: 'level'
  });
  toast(`${milestone.icon} ${state.streak.count} ${plural(state.streak.count, 'день', 'дня', 'дней')} подряд — награда!`, 'good');
}

function checkDailyReset(notify = true) {
  const today = todayKey();
  let changed = false;

  if (state.package.date !== today) {
    state.package = { date: today, sentAt: 0, readyAt: 0, claimed: false };
    changed = true;
  }
  if (state.sickbay.date !== today) {
    state.sickbay = { date: today, used: false };
    changed = true;
  }
  if (state.shopTrips.date !== today) {
    state.shopTrips = { date: today, used: 0 };
    changed = true;
  }
  if (state.duty.date !== today) {
    assignDailyDuty();
    changed = true;
  }
  if (state.daily.date !== today) {
    state.daily = {
      date: today,
      progress: { hours: 0, earn: 0, call: 0 },
      done: {}
    };
    const kettle = state.purchases?.kettle || 0;
    if (kettle > 0) state.morale = clamp(state.morale + 5 * kettle, 0, 100);
    changed = true;
    if (notify) toast('🌅 Новый день службы — задания, наряды и походы обновились', 'info');
  }

  updateStreak();

  if (changed) {
    renderDaily();
    renderShopPanel();
    renderCare();
    renderQuest();
    renderDutyPicker();
    renderHero();
    save();
  }
  return changed;
}

/* ---------- быт: посылка, санчасть, увольнительная ---------- */

function packageState() {
  const p = state.package;
  if (!p.sentAt) return 'idle';
  if (p.claimed) return 'claimed';
  if (Date.now() >= p.readyAt) return 'ready';
  return 'onway';
}

function careItems() {
  const pkg = packageState();
  const items = [];

  if (pkg === 'idle') {
    items.push({
      id: 'package-send',
      icon: '📦',
      title: 'Посылка из дома',
      desc: 'Отправить запрос маме — посылка придёт через 2 часа',
      btn: 'Отправить',
      action: 'sendPackage'
    });
  } else if (pkg === 'onway') {
    items.push({
      id: 'package-wait',
      icon: '🚚',
      title: 'Посылка в пути',
      desc: `Мама уже собирает · осталось ${fmtDuration(state.package.readyAt - Date.now())}`,
      btn: 'в пути',
      disabled: true
    });
  } else if (pkg === 'ready') {
    items.push({
      id: 'package-ready',
      icon: '📦',
      title: 'Посылка из дома',
      desc: 'Печенье, носки и записка «Кушай»',
      btn: 'Забрать',
      action: 'claimPackage'
    });
  } else {
    items.push({
      id: 'package-done',
      icon: '✅',
      title: 'Посылка из дома',
      desc: 'Сегодня уже получена. Мама — лучшая.',
      btn: 'получено',
      disabled: true
    });
  }

  if (!state.sickbay.used) {
    const fullHp = state.hp >= state.maxHp;
    items.push({
      id: 'sickbay',
      icon: '🏥',
      title: 'Санчасть',
      desc: fullHp
        ? 'Здоровье в порядке — лечиться не нужно.'
        : 'Перевязка и таблетка: +40 ❤️, но −3 🔥. Раз в день.',
      btn: fullHp ? 'здоров' : 'Сходить',
      action: fullHp ? undefined : 'useSickbay',
      disabled: fullHp
    });
  } else {
    items.push({
      id: 'sickbay',
      icon: '🏥',
      title: 'Санчасть',
      desc: 'Медсестра сказала: «Здоров, иди служи».',
      btn: 'закрыто',
      disabled: true
    });
  }

  const leaveLeft = state.leaveAt - Date.now();
  if (leaveLeft > 0) {
    items.push({
      id: 'leave',
      icon: '🚌',
      title: 'Увольнительная',
      desc: `Следующая через ${fmtDuration(leaveLeft)}`,
      btn: 'недоступно',
      disabled: true
    });
  } else {
    items.push({
      id: 'leave',
      icon: '🚌',
      title: 'Увольнительная',
      desc: 'Город, шаурма и полная ⚡. День службы не пропускается.',
      btn: 'Пойти',
      action: 'takeLeave'
    });
  }

  return items;
}

function renderCare() {
  if (!els.careList) return;
  els.careList.innerHTML = careItems().map((item) => `
    <li class="care-item ${item.disabled ? 'is-disabled' : ''}">
      <span class="care-icon" aria-hidden="true">${item.icon}</span>
      <div class="care-main">
        <b>${item.title}</b>
        <span>${item.desc}</span>
      </div>
      <button class="care-btn" ${item.action ? `data-care="${item.action}"` : ''} ${item.disabled ? 'disabled' : ''}>${item.btn}</button>
    </li>
  `).join('');
}

function sendPackage() {
  if (state.package.sentAt) return;
  const now = Date.now();
  state.package.sentAt = now;
  state.package.readyAt = now + PACKAGE_DELAY_MS;
  state.package.claimed = false;

  pushLog({
    icon: '📮',
    text: 'Запрос на посылку отправлен. Мама уже собирает гостинцы.',
    gains: [],
    type: 'info'
  });

  renderCare();
  save();
  toast('📮 Запрос отправлен — посылка придёт через 2 часа', 'info');
  haptic('success');
}

function claimPackage() {
  if (packageState() !== 'ready') return;

  state.package.claimed = true;
  state.stats.packages = (state.stats.packages || 0) + 1;
  applyReward({ energy: 25, morale: 10 });

  pushLog({
    icon: '📦',
    text: 'Посылка из дома: печенье, носки и записка «Кушай, сынок».',
    gains: ['+25 ⚡', '+10 🔥'],
    type: 'good'
  });

  checkAchievements();
  renderAll();
  save();
  toast('📦 Посылка получена!', 'good');
  haptic('success');
}

function useSickbay() {
  if (state.sickbay.used) return;
  if (state.hp >= state.maxHp) {
    toast('❤️ Здоровье и так в порядке — санчасть не нужна', 'info');
    return;
  }
  if (!requireFree()) return;

  state.sickbay.used = true;
  state.hp = Math.min(state.maxHp, state.hp + 40);
  state.morale = clamp(state.morale - 3, 0, 100);

  pushLog({
    icon: '🏥',
    text: 'Санчасть: перевязали, дали таблетку и освобождение от строевой.',
    gains: ['+40 ❤️', '−3 🔥'],
    type: 'good'
  });

  renderAll();
  save();
  toast('🏥 Подлечился в санчасти', 'good');
  haptic('success');
}

function takeLeave() {
  const left = state.leaveAt - Date.now();
  if (left > 0) {
    toast(`🚌 Увольнительная будет через ${fmtDuration(left)}`, 'info');
    return;
  }
  if (!requireFree()) return;

  state.leaveAt = Date.now() + LEAVE_COOLDOWN_MS;
  state.energy = state.maxEnergy;
  state.morale = clamp(state.morale + 25, 0, 100);
  state.stats.leaves = (state.stats.leaves || 0) + 1;

  pushLog({
    icon: '🚌',
    text: 'Увольнительная: город, шаурма и ни одного «равняйсь».',
    gains: ['+25 🔥', '⚡ полная'],
    type: 'good'
  });

  checkAchievements();
  renderAll();
  save();
  toast('🚌 Увольнительная! День службы не пропущен', 'good');
  haptic('success');
}

/* ---------- квесты прапорщика ---------- */

function currentQuest() {
  return QUESTS[state.quest.index] || null;
}

function renderQuest() {
  if (!els.questBody) return;

  const total = QUESTS.length;
  const idx = state.quest.index;
  if (els.questCounter) els.questCounter.textContent = `${Math.min(idx, total)} / ${total}`;

  if (idx >= total) {
    els.questBody.innerHTML = `
      <div class="quest-done">
        <span aria-hidden="true">🎖️</span>
        <b>Все поручения выполнены</b>
        <small>Прапорщик доволен. Это почти комплимент.</small>
      </div>
    `;
    return;
  }

  const q = QUESTS[idx];
  const ready = q.check();

  els.questBody.innerHTML = `
    <div class="quest-current">
      <span class="quest-icon" aria-hidden="true">${q.icon}</span>
      <div class="quest-main">
        <b>${q.title}</b>
        <span>${q.desc}</span>
        <div class="quest-reward">${rewardParts(q.reward).join(' · ')}</div>
      </div>
    </div>
    <button class="btn ${ready ? 'btn-primary' : 'btn-ghost'}" data-claim-quest ${ready ? '' : 'disabled'}>
      ${ready ? 'Забрать награду' : 'Пока не выполнено'}
    </button>
  `;
}

function claimQuest() {
  const q = currentQuest();
  if (!q || !q.check()) return;

  applyReward(q.reward);
  state.quest.index += 1;

  pushLog({
    icon: q.icon,
    text: `Поручение прапорщика выполнено: ${q.title}`,
    gains: rewardParts(q.reward),
    type: 'level'
  });

  checkAchievements();
  renderAll();
  save();
  toast('🎖️ Поручение выполнено — награда получена', 'good');
  haptic('success');
}

/* ---------- развод на наряд ---------- */

function renderDutyPicker() {
  if (!els.dutyPicker) return;

  const p = periodProgress();
  const type = dutyType();
  const d = DUTIES[type];

  const head = `
    <div class="duty-assigned">
      <span class="duty-label">Наряд дня</span>
      <span class="duty-value">${d.icon} ${d.title}</span>
      <span class="duty-note">${p.idx >= 2 ? 'с периода «Черпак» наряд можно выбрать' : 'назначается случайно · выбор откроется на «Черпаке»'}</span>
    </div>
  `;

  if (p.idx < 2) {
    els.dutyPicker.innerHTML = head;
    return;
  }

  els.dutyPicker.innerHTML = `
    ${head}
    <div class="duty-options">
      ${Object.entries(DUTIES).map(([key, item]) => `
        <button class="duty-option ${key === type ? 'is-active' : ''}" data-duty="${key}">
          ${item.icon} ${item.title.replace('Наряд ', '')}
        </button>
      `).join('')}
    </div>
  `;
}

function chooseDuty(type) {
  if (!DUTIES[type] || periodProgress().idx < 2) return;
  if (!requireFree()) return;

  state.duty = { date: todayKey(), type };
  renderDutyPicker();
  renderActions();
  save();
  toast(`${DUTIES[type].icon} Наряд дня: ${DUTIES[type].title}`, 'info');
  haptic('success');
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
  renderCare();
  renderQuest();
  renderDutyPicker();
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
      rankTitle: RANKS[rankIndexFor(xp, true)].title,
      isPlayer: false
    };
  });

  const myRank = RANKS[rankIndexFor(state.xp, state.contract)];
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
    if (ready) {
      els.contractNote.textContent = 'Половина службы позади · откроет рейтинг роты';
    } else if (daysServed() < CONTRACT_DAY) {
      els.contractNote.textContent = `После половины службы · осталось ${daysUntilContract()} ${plural(daysUntilContract(), 'день', 'дня', 'дней')}`;
    } else {
      els.contractNote.textContent = `Нужно звание Младший сержант · ${state.xp} / 1800 XP`;
    }
    els.contractArrow.textContent = ready ? '→' : '🔒';
  }

  els.demobAlbumBtn.hidden = daysUntilDemob() > 0;
}

function signContract() {
  if (state.contract) return;

  if (!contractAvailable()) {
    if (daysServed() < CONTRACT_DAY) {
      toast(`📄 Контракт подписывают после половины службы — осталось ${daysUntilContract()} ${plural(daysUntilContract(), 'день', 'дня', 'дней')}`, 'info');
    } else {
      toast('📄 Для контракта нужно звание Младший сержант', 'info');
    }
    haptic('error');
    return;
  }

  const before = rankIndexFor(state.xp, false);
  state.contract = true;
  const after = rankIndexFor(state.xp, true);

  pushLog({
    icon: '📄',
    text: 'Контракт подписан. Теперь доступен рейтинг роты и звания до старшего сержанта.',
    gains: [],
    type: 'level'
  });

  if (after > before) applyRankPromotion(before, after);

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
  clearModals();
  state.demobSeen = true;

  const days = Math.min(SERVICE_DAYS, daysServed());
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

  els.demobText.textContent = `${state.name}, год позади! Ты прошёл путь от учебки до дембеля. Портянки сняты, берцы начищены, альбом собран.`;

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

/* ---------- actions render ---------- */

function actionRewardLabel(action) {
  if (action.money && action.money[1] > 0) return `+${action.money[0]}–${action.money[1]} ₽`;
  if (action.morale) return `${action.morale > 0 ? '+' : ''}${action.morale} 🔥`;
  return 'опыт';
}

function actionCardHtml(action) {
  const chips = [
    `<span class="chip-cost">⚡ ${action.energy}</span>`,
    `<span class="chip-hours">🕒 ${action.hours} ч</span>`,
    `<span>+${action.xp[0]}–${action.xp[1]} XP</span>`
  ];

  return `
    <button class="action-card" data-action="${action.id}" data-period="${action.minPeriod}" aria-label="${action.title}">
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
  els.actionGrid.innerHTML = ACTIONS.map((a) => actionCardHtml(actionFor(a.id))).join('');
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
  const periodIdx = periodProgress().idx;

  ACTIONS.forEach((base) => {
    const action = actionFor(base.id);
    const ref = cardEls.get(base.id);
    if (!ref) return;

    const periodOk = periodIdx >= base.minPeriod;
    const remain = (state.cooldowns[base.id] || 0) - now;
    const blocker = busyBlockerFor(base.id);
    const lowEnergy = state.energy < action.energy;
    const cooldownMs = (base.cooldownHours || base.hours) * HOUR_MS;

    ref.root.classList.toggle('is-period-locked', !periodOk);
    ref.root.classList.toggle('is-cd', periodOk && remain > 0);
    ref.root.classList.toggle('is-locked', periodOk && remain <= 0 && !blocker && lowEnergy);
    ref.root.classList.toggle('is-blocked', periodOk && remain <= 0 && Boolean(blocker));

    if (!periodOk) {
      ref.status.textContent = `🔒 ${PERIODS[base.minPeriod].title}`;
      ref.line.style.width = '0%';
    } else if (remain > 0) {
      ref.status.textContent = `⏱ ${fmtDuration(remain)}`;
      ref.line.style.width = `${clamp((1 - remain / cooldownMs) * 100, 0, 100)}%`;
    } else if (blocker) {
      ref.status.textContent = `⏳ ${fmtDuration(blocker.until - now)}`;
      ref.line.style.width = '0%';
    } else {
      ref.status.textContent = lowEnergy ? `нужно ⚡${action.energy}` : 'готово';
      ref.line.style.width = '0%';
    }
  });
}

/* ---------- xp / level ---------- */

function applyRankPromotion(from, to) {
  const gained = to - from;
  state.maxEnergy += 10 * gained;
  state.energy = Math.min(state.maxEnergy, state.energy + 15 * gained);
  state.hp = Math.min(state.maxHp, state.hp + 20 * gained);

  const rank = RANKS[to];
  pushLog({
    icon: '🎖️',
    text: `Новое звание — ${rank.title}!`,
    gains: [`+${10 * gained} ⚡ макс.`, `+${20 * gained} ❤️`, `+${gained} к лимиту походов`],
    type: 'level'
  });

  openModal((el) => renderLevelSheet(el, rank, gained));
  haptic('success');
}

function addXp(amount) {
  if (!amount) return;

  const before = rankIndexFor(state.xp, state.contract);
  state.xp = Math.max(0, state.xp + amount);
  const after = rankIndexFor(state.xp, state.contract);

  if (after <= before) return;
  applyRankPromotion(before, after);
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
  const base = ACTIONS.find((a) => a.id === id);
  if (!base) return;
  const action = actionFor(id);
  const now = Date.now();

  const p = periodProgress();
  if (p.idx < base.minPeriod) {
    toast(`🔒 Откроется в период «${PERIODS[base.minPeriod].title}»`, 'info');
    haptic('error');
    return;
  }

  const remain = (state.cooldowns[id] || 0) - now;
  if (remain > 0) {
    toast(`⏱ Ещё ${fmtDuration(remain)} — рано`, 'info');
    return;
  }

  const blocker = busyAction();
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
  if (base.cooldownHours) state.cooldowns[id] = now + base.cooldownHours * HOUR_MS;

  state.busy = {
    id,
    title: action.title,
    icon: action.icon,
    until: now + action.hours * HOUR_MS
  };

  if (action.duty) state.stats.duties += 1;
  state.stats.totalEarned += moneyGain;
  state.stats.actionsTotal = (state.stats.actionsTotal || 0) + 1;
  state.stats.hours = (state.stats.hours || 0) + action.hours;
  state.stats.byAction = state.stats.byAction || {};
  state.stats.byAction[id] = (state.stats.byAction[id] || 0) + 1;

  addXp(xpGain);

  dailyAdd('hours', action.hours);
  dailyAdd('earn', moneyGain);
  if (id === 'call') dailyAdd('call', 1);

  const gains = [`+${xpGain} XP`, `🕒 ${action.hours} ч`];
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
  toast(`${action.icon} ${action.title}: ${toastParts.join(' · ')} · ${action.hours} ч`, 'good');

  if (event) openModal((el) => renderEventSheet(el, event));
  if (daysUntilDemob() <= 0 && !state.demobSeen) window.setTimeout(showDemob, 500);
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

function renderLevelSheet(el, rank, gained) {
  const capped = !state.contract && rankIndexFor(state.xp, state.contract) >= CONTRACT_RANK;

  el.innerHTML = `
    <div class="sheet-emoji">${rank.emoji}</div>
    <h3 class="sheet-title">Новое звание!</h3>
    <p class="sheet-text">Теперь ты — <b>${rank.title}</b>. Сослуживцы смотрят с уважением, а прапорщик — с подозрением.</p>
    ${capped ? '<p class="sheet-text">Потолок срочника — младший сержант. Подпиши контракт, чтобы расти дальше.</p>' : ''}
    <div class="sheet-rewards">
      <span class="reward-pill">+${gained * 10} ⚡ к максимуму</span>
      <span class="reward-pill">+${gained * 20} ❤️</span>
      <span class="reward-pill">+${gained} ${plural(gained, 'поход', 'похода', 'походов')} в чипок</span>
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

function shopItemHtml(item, noTrips) {
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

  const temporary = SHOP.filter((item) => !item.permanent).sort((a, b) => a.price - b.price);
  const permanent = SHOP.filter((item) => item.permanent).sort((a, b) => a.price - b.price);

  els.shopList.innerHTML = `
    <li class="shop-section"><span>Расходники</span><small>на сегодня</small></li>
    ${temporary.map((item) => shopItemHtml(item, noTrips)).join('')}
    <li class="shop-section"><span>Апгрейды казармы</span><small>навсегда</small></li>
    ${permanent.map((item) => shopItemHtml(item, noTrips)).join('')}
  `;
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

let lastCareKey = '';

function updateCareLive() {
  const pkg = packageState();
  const pkgMin = pkg === 'onway' ? Math.ceil((state.package.readyAt - Date.now()) / 60000) : 0;
  const leaveMin = state.leaveAt > Date.now() ? Math.ceil((state.leaveAt - Date.now()) / 60000) : 0;
  const hpFull = state.hp >= state.maxHp ? 1 : 0;
  const key = `${pkg}:${pkgMin}:${leaveMin}:${state.sickbay.used ? 1 : 0}:${hpFull}`;
  if (key === lastCareKey) return;
  lastCareKey = key;
  renderCare();
}

function tick() {
  const now = Date.now();
  let changed = false;

  if (state.busy?.id && state.busy.until <= now) {
    const title = state.busy.title || 'Занятие';
    const icon = state.busy.icon || '✅';
    state.busy = { id: null, title: '', icon: '', until: 0 };
    pushLog({
      icon,
      text: `${title}: служба идёт, время вышло. Можно заняться чем-то ещё.`,
      gains: [],
      type: 'info'
    });
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
  updateCareLive();
  checkDailyReset();

  if (daysUntilDemob() <= 0 && !state.demobSeen) {
    window.setTimeout(showDemob, 300);
  }
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

  if (els.careList) {
    els.careList.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-care]');
      if (!btn) return;
      const action = btn.dataset.care;
      if (action === 'sendPackage') sendPackage();
      else if (action === 'claimPackage') claimPackage();
      else if (action === 'useSickbay') useSickbay();
      else if (action === 'takeLeave') takeLeave();
    });
  }

  if (els.questBody) {
    els.questBody.addEventListener('click', (e) => {
      if (e.target.closest('[data-claim-quest]')) claimQuest();
    });
  }

  if (els.dutyPicker) {
    els.dutyPicker.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-duty]');
      if (btn) chooseDuty(btn.dataset.duty);
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

  if (daysUntilDemob() <= 0 && !state.demobSeen) {
    window.setTimeout(showDemob, 900);
  }

  window.setInterval(tick, 1000);
}

boot();



