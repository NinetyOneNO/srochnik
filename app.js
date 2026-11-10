/* СРОЧНИК — прототип Telegram MiniApp.
   Игра про армейский быт: наряды, чипок, боевой дух и путь до дембеля. */

'use strict';

const SAVE_KEY = 'srochnik.save.v1';
const HOUR_MS = 3600000;
const ENERGY_MS = 216000; // 3 минуты 36 секунд на +1 энергии
const HP_MS = 216000; // здоровье восстанавливается так же
const EVENT_CHANCE = 0.16;
const MAX_LOG = 40;
const SERVICE_DAYS = 365;
const DAY_MS = 12 * HOUR_MS; // игровой день длится 12 реальных часов
const CONTRACT_DAY = 182; // половина службы
const CONTRACT_RANK = 3; // младший сержант
const PACKAGE_DELAY_MS = 2 * HOUR_MS;
const LEAVE_COOLDOWN_MS = 7 * DAY_MS;
const SHOP_MAX_TRIPS = 3;
const SHOP_TRIP_MS = 30 * 60 * 1000; // +1 поход каждые 30 минут
const ACTIVITY_BASE_SPEED = 3; // базовое ускорение занятий в 3 раза

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

function gameDayKeyFrom(startedAt, ts = Date.now()) {
  const start = Number(startedAt) || ts;
  return `g${Math.floor((ts - start) / DAY_MS)}`;
}

function gameDayKey(ts = Date.now()) {
  return gameDayKeyFrom(state.startedAt, ts);
}

function fmtClock(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function regenLabel() {
  return '3:36';
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

/* ---------- sound and notifications ---------- */

let audioContext = null;

function playSound(kind = 'click') {
  if (!state?.settings?.sound) return;
  try {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return;
    audioContext = audioContext || new AudioContextClass();
    if (audioContext.state === 'suspended') audioContext.resume();
    const notes = {
      click: [520], success: [660, 880], error: [220], coin: [880, 1175], level: [523, 659, 784, 1047]
    }[kind] || [520];
    const start = audioContext.currentTime;
    notes.forEach((frequency, index) => {
      const oscillator = audioContext.createOscillator();
      const gain = audioContext.createGain();
      const at = start + index * 0.085;
      oscillator.type = kind === 'error' ? 'triangle' : 'sine';
      oscillator.frequency.setValueAtTime(frequency, at);
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(0.045, at + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.12);
      oscillator.connect(gain);
      gain.connect(audioContext.destination);
      oscillator.start(at);
      oscillator.stop(at + 0.13);
    });
  } catch (e) {
    /* Web Audio may be unavailable or blocked by the host */
  }
}

function notifyPlayer(title, body) {
  if (!state.settings?.notify || !document.hidden || !('Notification' in window)) return;
  if (Notification.permission !== 'granted') return;
  try {
    new Notification(title, { body, tag: 'srochnik-' + title });
  } catch (e) {
    /* Notifications may be blocked inside an embedded webview */
  }
}

async function toggleNotifications() {
  if (state.settings.notify) {
    state.settings.notify = false;
  } else {
    if (!('Notification' in window)) {
      toast('🔔 Уведомления не поддерживаются в этом приложении', 'info');
      return;
    }
    try {
      const permission = Notification.permission === 'default'
        ? await Notification.requestPermission()
        : Notification.permission;
      if (permission !== 'granted') {
        toast('🔔 Разреши уведомления в настройках браузера', 'info');
        return;
      }
      state.settings.notify = true;
    } catch (e) {
      toast('🔔 Уведомления недоступны в этом приложении', 'info');
      return;
    }
  }
  save();
  renderSettings();
  toast(state.settings.notify ? '🔔 Уведомления включены' : '🔕 Уведомления выключены', 'good');
}

/* ---------- first-run tutorial ---------- */

const TUTORIAL_STEPS = [
  { icon: '🏛️', title: 'Казарма', text: 'Выбирай занятие. Оно занимает указанное время, а пока идёт — другие занятия подождут. Энергия постепенно восстанавливается даже во время службы.' },
  { icon: '⚡', title: 'Время и ресурсы', text: 'Игровой день длится 12 часов. По 1 энергии и здоровью возвращается каждые 3 минуты 36 секунд. Следи за балансом и выбирай занятия по силам.' },
  { icon: '🛒', title: 'Чипок', text: 'Есть 3 похода за расходниками. Один поход восстанавливается каждые 30 минут. Постоянные апгрейды казармы можно покупать независимо от походов.' },
  { icon: '🎖️', title: 'Служба и настройки', text: 'Выполняй задания и поручения прапорщика, забирай награды и расти в звании. В «Настройках» можно включить звук, уведомления и пройти это обучение ещё раз.' }
];
let tutorialIndex = 0;

function showTutorial(force = false) {
  if (!els.tutorial || (!force && state.tutorialSeen)) return;
  tutorialIndex = 0;
  state.tutorialSeen = true;
  renderTutorialStep();
  els.tutorial.classList.add('is-open');
  els.tutorial.setAttribute('aria-hidden', 'false');
  save();
}

function renderTutorialStep() {
  const step = TUTORIAL_STEPS[tutorialIndex];
  if (!step) return;
  els.tutorialCount.textContent = `${tutorialIndex + 1} / ${TUTORIAL_STEPS.length}`;
  els.tutorialEmoji.textContent = step.icon;
  els.tutorialTitle.textContent = step.title;
  els.tutorialText.textContent = step.text;
  els.tutorialDots.innerHTML = TUTORIAL_STEPS.map((_, i) => `<i class="${i === tutorialIndex ? 'is-active' : ''}"></i>`).join('');
  els.tutorialNext.textContent = tutorialIndex === TUTORIAL_STEPS.length - 1 ? 'Начать службу' : 'Далее';
}

function advanceTutorial() {
  playSound('click');
  tutorialIndex += 1;
  if (tutorialIndex >= TUTORIAL_STEPS.length) {
    closeTutorial();
    return;
  }
  renderTutorialStep();
}

function closeTutorial() {
  if (!els.tutorial) return;
  els.tutorial.classList.remove('is-open');
  els.tutorial.setAttribute('aria-hidden', 'true');
  state.tutorialSeen = true;
  save();
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
    energy: 22,
    xp: [10, 15],
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
    energy: 40,
    xp: [15, 22],
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
    xp: [5, 8],
    money: [0, 0],
    morale: 16,
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
    energy: 60,
    xp: [8, 13],
    money: [45, 80],
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
    energy: 40,
    xp: [12, 18],
    money: [35, 75],
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
    energy: 75,
    xp: [26, 36],
    money: [90, 140],
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
    energy: 55,
    xp: [24, 34],
    money: [30, 60],
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
    energy: 95,
    xp: [70, 100],
    money: [220, 320],
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

/* Скорость занятий: базовое ускорение + апгрейды из чипка. */
function activitySpeedBonus() {
  const laces = state.purchases?.laces || 0;
  const watch = state.purchases?.watch || 0;
  const planner = state.purchases?.planner || 0;
  return laces * 0.10 + watch * 0.15 + planner * 0.20;
}

function activitySpeed() {
  return ACTIVITY_BASE_SPEED * (1 + activitySpeedBonus());
}

function activityDurationMs(action) {
  const ms = action.hours * HOUR_MS / activitySpeed();
  return Math.max(60 * 1000, Math.round(ms));
}

const SHOP = [
  {
    id: 'pie',
    icon: '🥟',
    name: 'Пирожок с картошкой',
    desc: '+20 энергии и +4 духа',
    price: 35,
    temporary: true,
    fullMsg: 'Сначала проголодайся',
    blocked: () => state.energy >= state.maxEnergy,
    apply: () => {
      state.energy = Math.min(state.maxEnergy, state.energy + 20);
      state.morale = clamp(state.morale + 4, 0, 100);
    }
  },
  {
    id: 'choco',
    icon: '🍫',
    name: 'Шоколадка «Алёнка»',
    desc: '+15 боевого духа',
    price: 50,
    temporary: true,
    fullMsg: 'Дух и так боевой',
    blocked: () => state.morale >= 100,
    apply: () => {
      state.morale = clamp(state.morale + 15, 0, 100);
    }
  },
  {
    id: 'energy',
    icon: '⚡',
    name: 'Энергетик «Дизель»',
    desc: '+40 энергии',
    price: 65,
    temporary: true,
    fullMsg: 'Энергия и так на максимуме',
    blocked: () => state.energy >= state.maxEnergy,
    apply: () => {
      state.energy = Math.min(state.maxEnergy, state.energy + 40);
    }
  },
  {
    id: 'medkit',
    icon: '💊',
    name: 'Бинт и йод',
    desc: '+30 здоровья',
    price: 75,
    temporary: true,
    fullMsg: 'Здоровье и так в порядке',
    blocked: () => state.hp >= state.maxHp,
    apply: () => {
      state.hp = Math.min(state.maxHp, state.hp + 30);
    }
  },
  {
    id: 'pillow',
    icon: '🛏️',
    name: 'Подушка поудобнее',
    desc: '+15 к максимуму энергии навсегда',
    price: 400,
    max: 3,
    permanent: true,
    apply: () => {
      state.maxEnergy += 15;
      state.energy = Math.min(state.maxEnergy, state.energy + 15);
    }
  },
  {
    id: 'kettle',
    icon: '🫖',
    name: 'Чайник в тумбочку',
    desc: '+6 боевого духа каждое утро',
    price: 650,
    max: 2,
    permanent: true,
    apply: () => {
      state.morale = clamp(state.morale + 6, 0, 100);
    }
  },
  {
    id: 'boots',
    icon: '🥾',
    name: 'Новые берцы',
    desc: '+8 к максимуму энергии навсегда',
    price: 900,
    max: 4,
    permanent: true,
    apply: () => {
      state.maxEnergy += 8;
      state.energy = Math.min(state.maxEnergy, state.energy + 8);
    }
  },
  {
    id: 'locker',
    icon: '🗄️',
    name: 'Тумбочка с замком',
    desc: '+15 к максимуму здоровья навсегда',
    price: 1200,
    max: 2,
    permanent: true,
    apply: () => {
      state.maxHp += 15;
      state.hp = Math.min(state.maxHp, state.hp + 15);
    }
  },
  {
    id: 'laces',
    icon: '👟',
    name: 'Шнурки-самоходы',
    desc: '+10% к скорости занятий',
    price: 350,
    max: 3,
    permanent: true,
    apply: () => {}
  },
  {
    id: 'watch',
    icon: '⌚',
    name: 'Командирские часы',
    desc: '+15% к скорости занятий',
    price: 950,
    max: 2,
    permanent: true,
    apply: () => {}
  },
  {
    id: 'planner',
    icon: '📋',
    name: 'Распорядок дня',
    desc: '+20% к скорости занятий',
    price: 2200,
    max: 1,
    permanent: true,
    apply: () => {}
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
    title: 'Отслужить 5 часов',
    key: 'hours',
    goal: 5,
    unit: 'ч',
    reward: { money: 90, xp: 25 }
  },
  {
    id: 'earn',
    icon: '💰',
    title: 'Заработать 150 ₽',
    key: 'earn',
    goal: 150,
    unit: '₽',
    reward: { money: 70, morale: 10 }
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
    busy: { id: null, title: '', icon: '', until: 0, startedAt: 0, totalMs: 0 },
    purchases: { boots: 0, pillow: 0, kettle: 0, locker: 0, laces: 0, watch: 0, planner: 0 },
    shop: { charges: SHOP_MAX_TRIPS, lastAt: Date.now() },
    duty: { date: gameDayKeyFrom(Date.now(), Date.now()), type: pick(Object.keys(DUTIES)) },
    package: { date: gameDayKeyFrom(Date.now(), Date.now()), sentAt: 0, readyAt: 0, claimed: false },
    leaveAt: 0,
    sickbay: { date: gameDayKeyFrom(Date.now(), Date.now()), used: false },
    streak: { count: 0, lastDate: '' },
    quest: { index: 0 },
    daily: {
      date: gameDayKeyFrom(Date.now(), Date.now()),
      progress: { hours: 0, earn: 0, call: 0 },
      done: {}
    },
    settings: { sound: true, notify: false },
    tutorialSeen: false,
    timeVersion: 1,
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

function loadState(rawOverride) {
  const base = defaultState();
  try {
    const raw = rawOverride === undefined ? localStorage.getItem(SAVE_KEY) : rawOverride;
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
        until: Number(savedBusy.until) || 0,
        startedAt: Number(savedBusy.startedAt) || 0,
        totalMs: Number(savedBusy.totalMs) || 0
      },
      shop: {
        charges: clamp(Number(saved.shop?.charges ?? (SHOP_MAX_TRIPS - (saved.shopTrips?.used || 0))), 0, SHOP_MAX_TRIPS),
        lastAt: Number(saved.shop?.lastAt) || Number(saved.shopTrips?.lastAt) || Date.now()
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
      settings: { ...base.settings, ...(saved.settings || {}) },
      tutorialSeen: Boolean(saved.tutorialSeen),
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
    if (!saved.timeVersion) {
      const elapsed = Math.max(0, Date.now() - merged.startedAt);
      merged.startedAt = Date.now() - elapsed / 2;
      merged.daily.date = gameDayKeyFrom(merged.startedAt);
      merged.duty.date = merged.daily.date;
      merged.package.date = merged.daily.date;
      merged.sickbay.date = merged.daily.date;
    }
    merged.timeVersion = 1;
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
const CLOUD_URL = 'https://kxuwpsfkjeyzsytclsys.supabase.co/functions/v1/telegram-save';
const CLOUD_META_KEY = 'srochnik.cloud.meta.v1';
let cloudRevision = null;
let cloudReady = false;
let cloudPending = false;
let cloudSaving = false;
let cloudConflict = false;
let cloudTimer = null;
let cloudInitFailed = false;
let cloudChecking = false;
let isAdmin = false;
let accountBanned = false;
let cloudLeaderboard = null;
let leaderboardLoading = false;
let leaderboardError = false;
const cloudSessionId = crypto.randomUUID();
let sessionExpired = false;

function expireSession() {
  if (sessionExpired) return;
  sessionExpired = true;
  cloudReady = false;
  cloudPending = false;
  clearTimeout(cloudTimer);
  clearTimeout(saveTimer);
  try { localStorage.setItem(SAVE_KEY + '.backup', JSON.stringify(state)); } catch { /* ignore */ }
  const overlay = document.createElement('div');
  overlay.className = 'session-expired';
  overlay.innerHTML = '<div><h2>Вход с другого устройства</h2><p>Эта сессия завершена. Чтобы продолжить здесь, откройте игру заново — другая сессия завершится.</p><button id="sessionRestart">Открыть заново</button></div>';
  document.body.appendChild(overlay);
  document.getElementById('sessionRestart').addEventListener('click', () => location.reload());
  cloudStatus('Сессия завершена: вход с другого устройства');
}

function showBanned() {
  if (accountBanned) return;
  accountBanned = true;
  cloudReady = false;
  clearTimeout(cloudTimer);
  clearTimeout(saveTimer);
  const overlay = document.createElement('div');
  overlay.className = 'session-expired';
  overlay.innerHTML = '<div><h2>Доступ заблокирован</h2><p>Обратитесь к администратору игры.</p></div>';
  document.body.appendChild(overlay);
}

function adoptCloud(result, notify = false) {
  try { localStorage.setItem(SAVE_KEY + '.backup', JSON.stringify(state)); } catch { /* keep cloud copy */ }
  const loaded = loadState(JSON.stringify(result.data));
  Object.keys(state).forEach((key) => delete state[key]);
  Object.assign(state, loaded);
  cloudRevision = result.revision;
  cloudPending = false;
  cloudConflict = false;
  cloudLeaderboard = null;
  leaderboardError = false;
  setCloudMeta({ user: String(tg.initDataUnsafe.user.id), revision: cloudRevision, dirty: false });
  localStorage.setItem(SAVE_KEY, JSON.stringify(state));
  applyOfflineRegen();
  renderActions();
  renderAll();
  renderLog();
  cloudStatus('Прогресс обновлён из аккаунта Telegram');
  if (notify) toast('📱 Обнаружен вход или изменения на другом устройстве — данные обновлены', 'info');
}

async function refreshCloud() {
  if (!cloudReady || cloudChecking || cloudSaving || isResetting) return;
  cloudChecking = true;
  try {
    const result = await cloudRequest('load');
    if (result.exists && result.revision !== cloudRevision) {
      clearTimeout(cloudTimer);
      clearTimeout(saveTimer);
      adoptCloud(result, true);
    }
  } catch {
    if (sessionExpired || accountBanned) return;
    cloudStatus('Нет связи с облаком. Прогресс сохранён на устройстве.');
  } finally { cloudChecking = false; }
}

function cloudStatus(message) {
  const el = document.querySelector('#cloudStatus');
  if (el) el.textContent = message;
}

async function cloudRequest(mode, data, revision) {
  const response = await fetch(CLOUD_URL, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ initData: tg.initData, sessionId: cloudSessionId, mode, data, revision }),
    signal: AbortSignal.timeout(15000)
  });
  const result = await response.json();
  if (result.banned) { showBanned(); throw new Error('banned'); }
  if (result.session_expired) { expireSession(); throw new Error('session expired'); }
  if (response.status === 409) return { conflict: true };
  if (!response.ok) throw new Error('cloud request failed');
  return result;
}

function cloudMeta() {
  try { return JSON.parse(localStorage.getItem(CLOUD_META_KEY) || '{}'); } catch { return {}; }
}

async function refreshLeaderboard(force = false) {
  if (!tg?.initData || !cloudReady || leaderboardLoading) return false;
  if (leaderboardError && !force) return false;
  leaderboardLoading = true;
  leaderboardError = false;
  try {
    const result = await cloudRequest('leaderboard');
    if (result && Array.isArray(result.players)) {
      cloudLeaderboard = result;
      renderStaff();
      return true;
    }
    leaderboardError = true;
  } catch {
    leaderboardError = true;
  } finally {
    leaderboardLoading = false;
  }
  return false;
}

function setCloudMeta(meta) {
  try { localStorage.setItem(CLOUD_META_KEY, JSON.stringify(meta)); } catch { /* local storage unavailable */ }
}

function scheduleCloudSave() {
  if (!cloudReady || cloudConflict || isResetting) return;
  cloudPending = true;
  clearTimeout(cloudTimer);
  cloudTimer = setTimeout(flushCloudSave, 1500);
}

async function flushCloudSave() {
  if (!cloudReady || cloudSaving || cloudConflict || !cloudPending) return;
  if (cloudChecking) { clearTimeout(cloudTimer); cloudTimer = setTimeout(flushCloudSave, 1500); return; }
  cloudSaving = true;
  cloudPending = false;
  const snapshot = JSON.parse(JSON.stringify(state));
  try {
    cloudStatus('Сохранение в аккаунт…');
    const result = await cloudRequest('save', snapshot, cloudRevision);
    if (result.conflict) {
      const latest = await cloudRequest('load');
      if (!latest.exists) throw new Error('cloud save unavailable');
      clearTimeout(saveTimer);
      adoptCloud(latest, true);
    } else {
      cloudRevision = result.revision;
      setCloudMeta({ user: String(tg.initDataUnsafe?.user?.id || ''), revision: cloudRevision, dirty: cloudPending });
      cloudStatus('Прогресс сохранён в аккаунте Telegram');
    }
  } catch {
    if (sessionExpired || accountBanned) return;
    cloudPending = true;
    setCloudMeta({ ...cloudMeta(), dirty: true });
    cloudStatus('Не удалось сохранить в облаке. Прогресс на устройстве; перезапустите игру для сверки.');
    cloudReady = false;
  } finally {
    cloudSaving = false;
    if (cloudPending && cloudReady && !cloudConflict) { clearTimeout(cloudTimer); cloudTimer = setTimeout(flushCloudSave, 1500); }
  }
}

async function initializeCloud() {
  if (!tg?.initData || !tg.initDataUnsafe?.user?.id) {
    cloudStatus('Локальное сохранение. Для синхронизации откройте игру в Telegram.');
    return;
  }
  const localRaw = localStorage.getItem(SAVE_KEY);
  const localMeta = cloudMeta();
  const user = String(tg.initDataUnsafe.user.id);
  try {
    cloudStatus('Загрузка сохранения аккаунта…');
    const result = await cloudRequest('login');
    isAdmin = result.is_admin === true;
    $('#adminRow').hidden = !isAdmin;
    if (result.exists) {
      const useLocal = Boolean(localRaw && localMeta.user === user && localMeta.dirty && localMeta.revision === result.revision);
      if (localRaw && !useLocal && (!localMeta.user || localMeta.revision !== result.revision)) {
        try { localStorage.setItem(SAVE_KEY + '.backup', localRaw); } catch { /* preserve when possible */ }
      }
      if (!useLocal) {
        const loaded = loadState(JSON.stringify(result.data));
        Object.keys(state).forEach((key) => delete state[key]);
        Object.assign(state, loaded);
        try { localStorage.setItem(SAVE_KEY, JSON.stringify(state)); } catch { /* ignore */ }
      }
      cloudRevision = result.revision;
      cloudPending = useLocal;
    } else {
      cloudRevision = 0;
      cloudPending = true;
    }
    cloudReady = true;
    setCloudMeta({ user, revision: cloudRevision, dirty: cloudPending });
    cloudStatus('Аккаунт Telegram подключён');
  } catch {
    if (sessionExpired || accountBanned) return;
    cloudInitFailed = true;
    cloudReady = false;
    if (localMeta.user === user) setCloudMeta({ ...localMeta, dirty: true });
    cloudStatus('Облако недоступно. Игра сохранится на устройстве; перезапустите её для синхронизации.');
  }
}

function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 150);
}

function saveNow() {
  if (isResetting || sessionExpired || accountBanned) return;
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify(state));
    if ((cloudInitFailed || (!cloudReady && cloudMeta().user)) && tg?.initDataUnsafe?.user?.id) {
      const meta = cloudMeta();
      if (!meta.user || meta.user === String(tg.initDataUnsafe.user.id)) setCloudMeta({ ...meta, user: String(tg.initDataUnsafe.user.id), dirty: true });
    }
    if (cloudReady && !cloudConflict) {
      setCloudMeta({ ...cloudMeta(), dirty: true });
      scheduleCloudSave();
    }
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

  refreshShopTrips(now);
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
  return SHOP_MAX_TRIPS;
}

function shopTripsLeft() {
  refreshShopTrips();
  return state.shop.charges;
}

function refreshShopTrips(now = Date.now()) {
  if (!state.shop) state.shop = { charges: SHOP_MAX_TRIPS, lastAt: now };
  if (state.shop.charges >= SHOP_MAX_TRIPS) {
    state.shop.charges = SHOP_MAX_TRIPS;
    state.shop.lastAt = now;
    return false;
  }
  const gained = Math.floor((now - state.shop.lastAt) / SHOP_TRIP_MS);
  if (gained <= 0) return false;
  state.shop.charges = Math.min(SHOP_MAX_TRIPS, state.shop.charges + gained);
  state.shop.lastAt = state.shop.charges >= SHOP_MAX_TRIPS ? now : state.shop.lastAt + gained * SHOP_TRIP_MS;
  return true;
}

function shopTripWait() {
  refreshShopTrips();
  return state.shop.charges >= SHOP_MAX_TRIPS ? 0 : Math.max(0, state.shop.lastAt + SHOP_TRIP_MS - Date.now());
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
  statusText: $('#statusText'),
  statusTime: $('#statusTime'),
  statusProgress: $('#statusProgress'),
  soundToggle: $('#soundToggle'),
  notifyToggle: $('#notifyToggle'),
  tutorial: $('#tutorial'),
  tutorialCount: $('#tutorialCount'),
  tutorialEmoji: $('#tutorialEmoji'),
  tutorialTitle: $('#tutorialTitle'),
  tutorialText: $('#tutorialText'),
  tutorialDots: $('#tutorialDots'),
  tutorialNext: $('#tutorialNext'),
  daysLeft: $('#daysLeft'),
  dutyCount: $('#dutyCount'),
  periodMeta: $('#periodMeta'),
  streakMeta: $('#streakMeta'),
  moneyTop: $('#moneyTop'),
  shopMoney: $('#shopMoney'),
  shopTrips: $('#shopTrips'),
  shopSpeed: $('#shopSpeed'),
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
  els.hpHint.textContent = state.hp < 25 ? '❕ доход снижен — нужно подлечиться' : `+1 каждые ${regenLabel()}`;
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
  state.duty = { date: gameDayKey(), type };
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
  const today = gameDayKey();
  let changed = false;

  if (state.package.date !== today && (!state.package.sentAt || state.package.claimed)) {
    state.package = { date: today, sentAt: 0, readyAt: 0, claimed: false };
    changed = true;
  }
  if (state.sickbay.date !== today) {
    state.sickbay = { date: today, used: false };
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
    if (kettle > 0) state.morale = clamp(state.morale + 6 * kettle, 0, 100);
    changed = true;
    if (notify) {
      toast('🌅 Новый игровой день — задания и наряд обновились', 'info');
      notifyPlayer('Новый игровой день', 'Задания и наряд обновились.');
    }
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
  state.package.date = gameDayKey();
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

  state.duty = { date: gameDayKey(), type };
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
  renderStatusLine();
  renderMoney();
  renderSettings();
}

function renderSettings() {
  if (els.soundToggle) {
    els.soundToggle.classList.toggle('is-on', Boolean(state.settings.sound));
    els.soundToggle.setAttribute('aria-checked', String(Boolean(state.settings.sound)));
  }
  if (els.notifyToggle) {
    els.notifyToggle.classList.toggle('is-on', Boolean(state.settings.notify));
    els.notifyToggle.setAttribute('aria-checked', String(Boolean(state.settings.notify)));
  }
}

function renderStatusLine() {
  if (!els.statusText) return;
  const now = Date.now();
  const active = busyAction();
  if (active) {
    const elapsed = Math.max(0, now - (state.busy.startedAt || (state.busy.until - (state.busy.totalMs || HOUR_MS))));
    const total = state.busy.totalMs || Math.max(HOUR_MS, state.busy.until - (state.busy.startedAt || now));
    const remaining = Math.max(0, active.until - now);
    els.statusText.textContent = `${active.icon} ${active.title}`;
    els.statusTime.textContent = fmtClock(remaining);
    els.statusProgress.style.width = `${clamp((elapsed / total) * 100, 0, 100)}%`;
  } else {
    const energyWait = state.energy >= state.maxEnergy ? 'готова' : fmtClock(Math.max(0, state.lastEnergyAt + ENERGY_MS - now));
    els.statusText.textContent = 'Служба идёт · свободен';
    els.statusTime.textContent = state.energy >= state.maxEnergy ? `⚡ ${Math.round(state.energy)}/${state.maxEnergy}` : `⚡ +1 через ${energyWait}`;
    els.statusProgress.style.width = '0%';
  }
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

function cloudEntry(entry) {
  const xp = Number(entry.xp) || 0;
  const contract = Boolean(entry.contract);
  const rank = RANKS[rankIndexFor(xp, contract)];
  return {
    name: entry.name || 'Срочник',
    emoji: rank.emoji,
    xp,
    rankTitle: rank.title,
    isPlayer: Boolean(entry.isMe),
    serviceDays: Number(entry.serviceDays) || 0,
    place: Number(entry.place) || 0
  };
}

function leaderboardEntries() {
  if (cloudLeaderboard) {
    return (cloudLeaderboard.players || []).map(cloudEntry);
  }

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

function myLeaderboardPlace() {
  if (cloudLeaderboard?.me) {
    return {
      place: Number(cloudLeaderboard.me.place) || 0,
      total: Number(cloudLeaderboard.total) || 0
    };
  }
  const entries = leaderboardEntries();
  return {
    place: entries.findIndex((entry) => entry.isPlayer) + 1,
    total: entries.length
  };
}

function renderStaff() {
  if (!els.staffPosition) return;

  if (cloudReady && !cloudLeaderboard && !leaderboardLoading && !leaderboardError) {
    refreshLeaderboard();
  }

  const placeInfo = myLeaderboardPlace();
  const unlocked = ACHIEVEMENTS.filter((a) => state.achievements[a.id]).length;
  const ready = contractAvailable();

  els.staffPosition.textContent = !cloudLeaderboard && tg?.initData
    ? (leaderboardError ? 'Рейтинг недоступен' : 'Загрузка рейтинга…')
    : placeInfo.place ? `Ты на ${placeInfo.place} месте из ${placeInfo.total}` : 'Ты пока вне рейтинга';
  els.staffAch.textContent = `Открыто ${unlocked} из ${ACHIEVEMENTS.length}`;
  els.leaderboardBtn.disabled = false;

  if (els.contractBtn) {
    els.contractBtn.hidden = Boolean(state.contract);
    els.contractBtn.disabled = !ready;
    els.contractBtn.classList.toggle('is-ready', ready);
    els.contractTitle.textContent = ready ? 'Подписать контракт' : 'Контракт';
    if (ready) {
      els.contractNote.textContent = 'Половина службы позади · откроет новые звания';
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
    text: 'Контракт подписан. Теперь доступны звания до старшего сержанта.',
    gains: [],
    type: 'level'
  });

  if (after > before) applyRankPromotion(before, after);

  checkAchievements();
  renderStaff();
  renderHero();
  save();
  toast('📄 Контракт подписан! Открыты новые звания', 'good');
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
  const cloud = Boolean(cloudLeaderboard);
  let rowsEntries = entries;

  if (cloud && cloudLeaderboard.me && !entries.some((entry) => entry.isPlayer)) {
    rowsEntries = [...entries, cloudEntry({ ...cloudLeaderboard.me, isMe: true })];
  }

  const rows = rowsEntries.map((entry, index) => {
    const place = entry.place || index + 1;
    const medal = place === 1 ? '🥇' : place === 2 ? '🥈' : place === 3 ? '🥉' : place;
    const details = cloud
      ? `${entry.rankTitle} · ${entry.serviceDays} ${plural(entry.serviceDays, 'день', 'дня', 'дней')} службы`
      : entry.rankTitle;

    return `
      <li class="lb-row ${entry.isPlayer ? 'is-me' : ''}">
        <span class="lb-place">${medal}</span>
        <span class="lb-avatar" aria-hidden="true">${entry.emoji}</span>
        <span class="lb-info">
          <b>${escapeHtml(entry.name)}${entry.isPlayer ? ' · это ты' : ''}</b>
          <span>${details}</span>
        </span>
        <span class="lb-xp">${fmt(entry.xp)} XP</span>
      </li>
    `;
  }).join('');

  const note = cloud
    ? `Всего игроков: ${fmt(cloudLeaderboard.total)}. Рейтинг обновляется при сохранении прогресса.`
    : (tg?.initData && cloudReady
      ? (leaderboardError ? 'Не удалось загрузить общий рейтинг. Показан учебный список.' : 'Загружаем общий рейтинг… Показан учебный список.')
      : 'Локальный учебный рейтинг. Откройте игру в Telegram, чтобы увидеть реальных игроков.');

  const canRefresh = Boolean(tg?.initData && cloudReady);

  el.innerHTML = `
    <div class="sheet-handle"></div>
    <div class="sheet-head">
      <div>
        <h3 class="sheet-title">Рейтинг</h3>
        <p class="sheet-sub">${cloud ? 'Игроки Telegram по опыту' : 'Кто дальше всех ушёл по службе'}</p>
      </div>
      <div class="sheet-head-actions">
        ${canRefresh ? '<button class="icon-btn" id="lbRefresh" aria-label="Обновить рейтинг">↻</button>' : ''}
        <button class="icon-btn" data-close aria-label="Закрыть">✕</button>
      </div>
    </div>
    <ul class="lb-list">${rows || '<li class="lb-empty">Пока в рейтинге никого нет</li>'}</ul>
    <p class="lb-note">${note}</p>
    <button class="btn btn-ghost" data-close>Закрыть</button>
  `;

  const refreshBtn = $('#lbRefresh', el);
  if (refreshBtn) {
    refreshBtn.addEventListener('click', async () => {
      refreshBtn.disabled = true;
      const ok = await refreshLeaderboard(true);
      if (ok) {
        renderLeaderboard(el);
      } else {
        refreshBtn.disabled = false;
        toast('Не удалось обновить рейтинг. Проверьте связь.', 'info');
      }
    });
  }
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
    `<span class="chip-hours">🕒 ${fmtDuration(activityDurationMs(action))}</span>`,
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
  state.maxHp += 5 * gained;
  state.hp = Math.min(state.maxHp, state.hp + 10 * gained);

  const rank = RANKS[to];
  pushLog({
    icon: '🎖️',
    text: `Новое звание — ${rank.title}!`,
    gains: [`+${10 * gained} ⚡ макс.`, `+${5 * gained} ❤️ макс.`],
    type: 'level'
  });

  openModal((el) => renderLevelSheet(el, rank, gained));
  playSound('level');
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
  const now = Date.now();
  if (ev.energy < 0 && state.energy >= state.maxEnergy) state.lastEnergyAt = now;
  if (ev.hp < 0 && state.hp >= state.maxHp) state.lastHpAt = now;
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

  if (state.energy >= state.maxEnergy) state.lastEnergyAt = now;
  state.energy -= action.energy;

  const mult = rewardMultiplier();
  const xpGain = Math.max(1, Math.round(rand(action.xp[0], action.xp[1]) * mult));
  const moneyGain = Math.round(rand(action.money[0], action.money[1]) * mult);
  const moraleGain = action.morale || 0;

  state.money += moneyGain;
  state.morale = clamp(state.morale + moraleGain, 0, 100);
  if (base.cooldownHours) state.cooldowns[id] = now + base.cooldownHours * HOUR_MS;

  const durationMs = activityDurationMs(action);
  state.busy = {
    id,
    title: action.title,
    icon: action.icon,
    startedAt: now,
    totalMs: durationMs,
    until: now + durationMs
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

  const gains = [`+${xpGain} XP`, `🕒 +${action.hours} ч службы`];
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
  playSound('success');

  const toastParts = [`+${xpGain} XP`];
  if (moneyGain > 0) toastParts.push(`+${fmt(moneyGain)} ₽`);
  toast(`${action.icon} ${action.title}: ${toastParts.join(' · ')} · ${action.hours} ч службы`, 'good');

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
      <span class="reward-pill">+${gained * 5} ❤️ к максимуму</span>
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

async function adminRequest(action, target, data, revision) {
  const response = await fetch(CLOUD_URL, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ initData: tg.initData, sessionId: cloudSessionId, mode: 'admin', action, target, data, revision }),
    signal: AbortSignal.timeout(15000)
  });
  const result = await response.json();
  if (result.session_expired) { expireSession(); throw new Error('Сессия завершена'); }
  if (result.conflict) throw new Error('Сохранение изменилось. Загрузите игрока заново.');
  if (!response.ok) throw new Error('Операция отклонена сервером');
  return result;
}

function renderAdmin(el) {
  el.innerHTML = `<h3 class="sheet-title">Управление игроками</h3>
    <p class="sheet-text">Последние 100 игроков. Для точного поиска введите Telegram ID.</p>
    <div id="adminList">Загрузка…</div>
    <label>Telegram ID <input id="adminTarget" inputmode="numeric" placeholder="Telegram ID"></label>
    <button class="btn btn-ghost" id="adminLoad">Загрузить игрока</button>
    <div id="adminEditor"></div><button class="btn btn-ghost" data-close>Закрыть</button>`;
  const list = $('#adminList', el);
  const target = $('#adminTarget', el);
  const editor = $('#adminEditor', el);
  adminRequest('list').then(result => {
    if (!el.isConnected) return;
    list.innerHTML = result.players.map(p => `<button class="admin-player" data-id="${escapeHtml(p.telegram_id)}">${escapeHtml(p.name)} · ${escapeHtml(p.telegram_id)}${p.banned ? ' · заблокирован' : ''}</button>`).join('') || 'Игроков пока нет';
  }).catch(() => { list.textContent = 'Не удалось загрузить список'; });
  list.addEventListener('click', e => { const b = e.target.closest('[data-id]'); if (b) { target.value = b.dataset.id; $('#adminLoad', el).click(); } });
  $('#adminLoad', el).addEventListener('click', async () => {
    const id = target.value.trim();
    if (!/^\d{1,20}$/.test(id)) { toast('Введите Telegram ID', 'bad'); return; }
    try {
      const player = await adminRequest('get', id);
      editor.innerHTML = `<p class="sheet-text">ID: ${escapeHtml(id)} · ревизия ${player.revision}${player.banned ? ' · заблокирован' : ''}</p>
        <p class="sheet-text">Полное сохранение JSON. Ошибки могут повредить прогресс.</p>
        <textarea id="adminData" rows="12" spellcheck="false"></textarea>
        <button class="btn btn-primary" id="adminSave">Сохранить изменения</button>
        <button class="btn btn-ghost" id="adminBan">${player.banned ? 'Разблокировать' : 'Заблокировать'}</button>
        <button class="btn btn-danger" id="adminReset">Сбросить прогресс</button>`;
      $('#adminData', editor).value = JSON.stringify(player.data, null, 2);
      $('#adminSave', editor).onclick = async () => {
        let data;
        try { data = JSON.parse($('#adminData', editor).value); } catch { toast('Некорректный JSON', 'bad'); return; }
        if (!confirm(`Перезаписать сохранение игрока ${id}?`)) return;
        try { await adminRequest('save', id, data, player.revision); toast('Сохранение обновлено', 'good'); $('#adminLoad', el).click(); }
        catch (err) { toast(err.message, 'bad'); }
      };
      $('#adminBan', editor).onclick = async () => {
        if (!confirm(`${player.banned ? 'Разблокировать' : 'Заблокировать'} игрока ${id}?`)) return;
        try { await adminRequest(player.banned ? 'unban' : 'ban', id); toast('Статус обновлён', 'good'); $('#adminLoad', el).click(); }
        catch (err) { toast(err.message, 'bad'); }
      };
      $('#adminReset', editor).onclick = async () => {
        if (!confirm(`Сбросить прогресс игрока ${id}? Предыдущая версия будет сохранена в журнале.`)) return;
        const fresh = defaultState();
        fresh.name = player.data.name || 'Срочник';
        try { await adminRequest('save', id, fresh, player.revision); toast('Прогресс сброшен', 'good'); $('#adminLoad', el).click(); }
        catch (err) { toast(err.message, 'bad'); }
      };
    } catch (err) { toast(err.message, 'bad'); }
  });
}

function shopItemHtml(item, noTrips) {
  const bought = state.purchases[item.id] || 0;
  const soldOut = Boolean(item.max) && bought >= item.max;
  const poor = state.money < item.price;
  const blockedByTrips = !item.permanent && noTrips;
  const label = soldOut ? 'макс.' : (blockedByTrips ? 'нет похода' : rub(item.price));

  return `
    <li class="shop-item ${soldOut ? 'is-sold' : ''}">
      <span class="shop-icon" aria-hidden="true">${item.icon}</span>
      <div class="shop-info">
        <b>${item.name}</b>
        <span>${item.desc}</span>
      </div>
      <button class="buy-btn ${poor && !soldOut && !blockedByTrips ? 'is-poor' : ''}" data-buy="${item.id}" ${soldOut || blockedByTrips ? 'disabled' : ''}>${label}</button>
    </li>
  `;
}

function renderShopPanel() {
  if (!els.shopList) return;

  const left = shopTripsLeft();
  const noTrips = left <= 0;
  const wait = shopTripWait();

  els.shopMoney.textContent = rub(state.money);
  els.shopTrips.innerHTML = `Походы: <b>${left}</b> из ${SHOP_MAX_TRIPS}${noTrips ? ` · следующий через ${fmtDuration(wait)}` : ''}`;
  els.shopTrips.classList.toggle('is-empty', noTrips);
  if (els.shopSpeed) {
    const speed = activitySpeed();
    const bonus = Math.round(activitySpeedBonus() * 100);
    els.shopSpeed.innerHTML = `Скорость занятий: <b>×${speed.toFixed(2).replace(/\.?0+$/, '')}</b>${bonus ? ` · апгрейды +${bonus}%` : ''}`;
  }
  els.shopNote.textContent = noTrips
    ? 'Один поход восстановится через 30 минут. Апгрейды доступны без ограничений по походам.'
    : 'Расходник стоит один поход. Походы постепенно восстанавливаются каждые 30 минут; апгрейды походов не требуют.';

  const temporary = SHOP.filter((item) => !item.permanent).sort((a, b) => a.price - b.price);
  const permanent = SHOP.filter((item) => item.permanent).sort((a, b) => a.price - b.price);

  els.shopList.innerHTML = `
    <li class="shop-section"><span>Расходники</span><small>1 поход за покупку</small></li>
    ${temporary.map((item) => shopItemHtml(item, noTrips)).join('')}
    <li class="shop-section"><span>Апгрейды казармы</span><small>всегда доступны</small></li>
    ${permanent.map((item) => shopItemHtml(item, noTrips)).join('')}
  `;
}

function buyItem(id) {
  const item = SHOP.find((i) => i.id === id);
  if (!item) return;

  const bought = state.purchases[id] || 0;

  if (!item.permanent && shopTripsLeft() <= 0) {
    toast(`🛒 Следующий поход через ${fmtDuration(shopTripWait())}`, 'info');
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
  if (!item.permanent) {
    if (state.shop.charges >= SHOP_MAX_TRIPS) state.shop.lastAt = Date.now();
    state.shop.charges = Math.max(0, state.shop.charges - 1);
  }
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
  if (item.permanent) renderActions();

  toast(`${item.icon} ${item.name} — куплено${item.permanent ? ' · апгрейд' : ` · походов осталось: ${shopTripsLeft()}`}`, 'good');
  playSound('coin');
  haptic('success');
}

function renderResetConfirm(el) {
  el.innerHTML = `
    <div class="sheet-emoji">🔄</div>
    <h3 class="sheet-title">Начать службу заново?</h3>
    <p class="sheet-text">Весь прогресс, деньги и звания будут сброшены${cloudReady ? ' также в аккаунте Telegram' : ' на этом устройстве'}. Как будто снова призыв.</p>
    <div class="sheet-actions">
      <button class="btn btn-ghost" data-close>Отмена</button>
      <button class="btn btn-danger" id="confirmReset">Сбросить</button>
    </div>
  `;

  const btn = $('#confirmReset', el);
  if (btn) {
    btn.addEventListener('click', async () => {
      if (tg?.initData && !cloudReady) {
        toast('Для сброса подключитесь к облаку и перезапустите игру.', 'bad');
        return;
      }
      if (cloudReady) {
        if (cloudSaving || cloudConflict) { toast('Сначала разрешите конфликт или дождитесь сохранения', 'info'); return; }
        btn.disabled = true;
        try {
          const result = await cloudRequest('save', defaultState(), cloudRevision);
          if (result.conflict) throw new Error('conflict');
          localStorage.removeItem(CLOUD_META_KEY);
        } catch {
          btn.disabled = false;
          toast('Не удалось сбросить облачное сохранение. Проверьте соединение.', 'bad');
          return;
        }
      }
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
let lastPackageState = '';
let lastShopDisplay = '';

function updateCareLive() {
  const pkg = packageState();
  if (lastPackageState === 'onway' && pkg === 'ready') {
    toast('📦 Посылка из дома прибыла', 'good');
    notifyPlayer('Посылка прибыла', 'Забери посылку в разделе «Боец».');
    playSound('success');
  }
  lastPackageState = pkg;
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
    toast(`${icon} ${title} завершено`, 'good');
    notifyPlayer('Занятие завершено', `${title}: можно выбрать следующее занятие.`);
    playSound('success');
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
  renderStatusLine();
  const tripsChanged = refreshShopTrips(now);
  const shopDisplay = `${state.shop.charges}:${state.shop.charges < SHOP_MAX_TRIPS ? Math.ceil(shopTripWait() / 60000) : 0}`;
  if (tripsChanged || shopDisplay !== lastShopDisplay) {
    lastShopDisplay = shopDisplay;
    renderShopPanel();
    if (tripsChanged) save();
  }
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
      playSound('click');
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

  $('#settingsReset').addEventListener('click', () => {
    haptic();
    openModal(renderResetConfirm);
  });

  $('#soundToggle').addEventListener('click', () => {
    state.settings.sound = !state.settings.sound;
    renderSettings();
    save();
    if (state.settings.sound) playSound('success');
    toast(state.settings.sound ? '🔊 Звуки включены' : '🔇 Звуки выключены', 'info');
  });
  $('#notifyToggle').addEventListener('click', toggleNotifications);
  $('#cloudSaveBtn').addEventListener('click', async () => {
    if (!cloudReady) {
      toast('☁️ Откройте игру в Telegram и проверьте соединение', 'info');
      return;
    }
    if (cloudSaving || cloudChecking) {
      toast('☁️ Синхронизация уже выполняется', 'info');
      return;
    }
    clearTimeout(saveTimer);
    saveNow();
    clearTimeout(cloudTimer);
    await flushCloudSave();
    if (cloudReady && !cloudPending) toast('☁️ Сохранение синхронизировано', 'good');
  });
  $('#tutorialBtn').addEventListener('click', () => showTutorial(true));
  $('#tutorialNext').addEventListener('click', advanceTutorial);
  $('#adminBtn').addEventListener('click', () => { if (isAdmin && cloudReady) openModal(renderAdmin); });
  $('#tutorialSkip').addEventListener('click', closeTutorial);

  const contractBtn = $('#contractBtn');
  if (contractBtn) {
    contractBtn.addEventListener('click', signContract);
  }

  const leaderboardBtn = $('#leaderboardBtn');
  if (leaderboardBtn) {
    leaderboardBtn.addEventListener('click', async () => {
      haptic();
      openModal(renderLeaderboard);
      if (tg?.initData && cloudReady) {
        const ok = await refreshLeaderboard(true);
        if (ok && modalOpen && els.sheet.querySelector('.lb-list')) renderLeaderboard(els.sheet);
      }
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
    else {
      tick();
      renderStatusLine();
      refreshCloud();
    }
  });
  window.addEventListener('pageshow', () => {
    tick();
    renderStatusLine();
  });
}

async function boot() {
  initTelegram();
  await initializeCloud();
  applyOfflineRegen();
  checkDailyReset(false);
  seedLog();
  els.quote.textContent = pick(QUOTES);
  renderActions();
  renderAll();
  renderLog();
  bindEvents();
  checkAchievements(true);
  setTab('actions');
  save();

  if (daysUntilDemob() <= 0 && !state.demobSeen) {
    window.setTimeout(showDemob, 900);
  }

  window.setInterval(tick, 1000);
  window.setInterval(() => { if (!document.hidden) refreshCloud(); }, 15000);
  window.setInterval(() => { if (!document.hidden && cloudReady) refreshLeaderboard(); }, 60000);
  showTutorial();
}

boot();
