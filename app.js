/* СРОЧНИК — прототип Telegram MiniApp.
   Игра про армейский быт: наряды, чипок, боевой дух и путь до дембеля. */

'use strict';

// Версия 2 не импортирует прогресс v1.
const SAVE_KEY_BASE = 'srochnik.save.v2';
const CLOUD_META_KEY_BASE = 'srochnik.cloud.meta.v2';
const HOUR_MS = 3600000;
const ENERGY_MS = 216000; // 3 минуты 36 секунд на +1 энергии
const HP_MS = 216000; // здоровье восстанавливается так же
const EVENT_CHANCE = 0.16;
const LOG_RETENTION_MS = 24 * HOUR_MS;
const SERVICE_DAYS = 365;
const DAY_MS = 12 * HOUR_MS; // игровой день длится 12 реальных часов
const PACKAGE_DELAY_MS = 2 * HOUR_MS;
const LEAVE_COOLDOWN_MS = 7 * DAY_MS;
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

function fmtDuration(ms) {
  const totalMin = Math.max(1, Math.ceil(ms / 60000));
  if (totalMin >= 60) {
    const h = Math.floor(totalMin / 60);
    const m = totalMin % 60;
    return m ? `${h} ч ${m} мин` : `${h} ч`;
  }
  return `${totalMin} мин`;
}

function fmtSideDuration(ms) {
  const seconds = Math.max(1, Math.ceil(ms / 1000));
  return seconds < 60 ? `${seconds} сек` : fmtDuration(ms);
}

/* ---------- Telegram ---------- */

const tg = window.Telegram?.WebApp || null;

// Изолируем данные аккаунтов даже при общем хранилище Telegram WebView.
const storageUserId = tg?.initData && Number.isSafeInteger(tg?.initDataUnsafe?.user?.id) && tg.initDataUnsafe.user.id > 0
  ? String(tg.initDataUnsafe.user.id) : '';
const SAVE_KEY = storageUserId ? `${SAVE_KEY_BASE}.user.${storageUserId}` : SAVE_KEY_BASE;
const CLOUD_META_KEY = storageUserId ? `${CLOUD_META_KEY_BASE}.user.${storageUserId}` : CLOUD_META_KEY_BASE;

// Старый общий ключ переносим только при подтверждённом владельце.
if (storageUserId) {
  try {
    const previousMeta = JSON.parse(localStorage.getItem(CLOUD_META_KEY_BASE) || '{}');
    if (String(previousMeta.user || '') === storageUserId && !localStorage.getItem(SAVE_KEY)) {
      const previousSave = localStorage.getItem(SAVE_KEY_BASE);
      if (previousSave) {
        localStorage.setItem(SAVE_KEY, previousSave);
        if (!localStorage.getItem(CLOUD_META_KEY)) localStorage.setItem(CLOUD_META_KEY, JSON.stringify(previousMeta));
      }
    }
  } catch { /* При недоступном хранилище начнём с облачной копии. */ }
}

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
  { icon: '🗺️', title: 'Гарнизон', text: 'Выбери здание на карте, чтобы войти. В Казарме собраны занятия со всей части — воспользуйся фильтрами, чтобы найти нужное.' },
  { icon: '⏱️', title: 'Занятия', text: 'Выбери занятие и дождись его завершения — тогда получишь награду. Одновременно можно выполнять только одно занятие.' },
  { icon: '🎒', title: 'Припасы', text: 'Следи за энергией и здоровьем. Купленные еда и лекарства попадают в инвентарь — используй их, когда понадобятся.' },
  { icon: '🎖️', title: 'Твой путь', text: 'Выполняй задания, собирай ежедневные награды и повышай ранг. Следить за прогрессом можно во вкладке «Боец», а за достижениями и рейтингом — в Штабе.' }
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
  { xp: 0, title: 'F', emoji: '⚪' },
  { xp: 300, title: 'E', emoji: '🔵' },
  { xp: 900, title: 'D', emoji: '🟢' },
  { xp: 1800, title: 'C', emoji: '🟡' },
  { xp: 3000, title: 'B', emoji: '🟠' },
  { xp: 4500, title: 'A', emoji: '🔴' },
  { xp: 6500, title: 'S', emoji: '💎' }
];

// Бонусы накопительные: процент сокращает время начальных занятий.
const LEVEL_BONUSES = [0, 0.20, 0.25, 0.30, 0.35, 0.40, 0.45];
const ACTION_LEVELS = { help: 3, guard: 3, mentor: 4, demobAccord: 5 };
const ACTION_HEALTH_COST = { charge: 4, drill: 5, duty: 6, help: 5, guard: 9, mentor: 3, demobAccord: 12, patrol: 4, deliverFood: 4, unload: 5, dispatch: 2 };
const STARTER_ACTIONS = new Set(['charge', 'drill', 'call', 'duty']);
// Разделы фильтра соответствуют зданиям на карте; пустые разделы не скрыты.
const LOCATIONS = [
  { id: 'actions', title: 'Казарма', icon: '🏛️', actions: ['call', 'mentor', 'demobAccord'], duties: ['sklad'] },
  { id: 'plaz', title: 'Плац', icon: '🚩', actions: ['charge', 'drill', 'help'], duties: ['plaz'] },
  { id: 'kpp', title: 'КПП', icon: '🛂', actions: ['guard', 'patrol'], duties: ['kpp'] },
  { id: 'canteen', title: 'Столовая', icon: '🍲', actions: ['serve', 'kitchenClean', 'deliverFood'], duties: ['kitchen'] },
  { id: 'shop', title: 'Чипок', icon: '🛒', actions: ['shelf', 'stocktake', 'unload'], duties: [] },
  { id: 'sickbay', title: 'Санчасть', icon: '🏥', actions: ['medSort', 'medClean', 'medHelp'], duties: [] },
  { id: 'staff', title: 'Штаб', icon: '🗂️', actions: ['documents', 'dispatch', 'archive'], duties: [] }
];
const LOGIN_REWARDS = [
  { money: 20 }, { item: 'pie', count: 1 }, { xp: 10 },
  { item: 'medkit', count: 1 }, { money: 35 }, { item: 'energy', count: 1 },
  { money: 50, xp: 20, item: 'choco', count: 1 }
];

const DUTIES = {
  kitchen: {
    icon: '🥔',
    title: 'Наряд на кухню',
    desc: 'Почистить картошку для роты',
    money: [108, 128],
    xp: [31, 36],
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
    money: [105, 124],
    xp: [33, 38],
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
    money: [115, 135],
    xp: [32, 37],
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
    money: [108, 126],
    xp: [31, 36],
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
    xp: [18, 22],
    money: [0, 0],
    morale: 2,
    hours: 1,
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
    xp: [34, 42],
    money: [0, 0],
    morale: 1,
    hours: 2,
    baseMinutes: 30,
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
    xp: [2, 3],
    money: [0, 0],
    morale: 6,
    hours: 1,
    baseMinutes: 5,
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
    xp: [30, 36],
    money: [110, 130],
    morale: -1,
    hours: 3,
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
    xp: [24, 29],
    money: [70, 84],
    morale: 3,
    hours: 2,
    baseMinutes: 30,
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
    desc: 'Час на посту, всё по уставу',
    energy: 75,
    xp: [44, 52],
    money: [135, 158],
    morale: -3,
    hours: 4,
    baseMinutes: 60,
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
    xp: [33, 39],
    money: [97, 112],
    morale: 5,
    hours: 3,
    flavor: [
      'Молодые слушают. Дед доволен.',
      'Показал, как правильно подшивать — и как не надо.',
      'Теперь в роте на одного знающего больше.'
    ]
  },
  {
    id: 'demobAccord',
    icon: '🎒',
    title: 'Большой наряд',
    desc: 'Большое поручение для опытного бойца',
    energy: 95,
    xp: [85, 102],
    money: [270, 315],
    morale: 10,
    hours: 6,
    cooldownHours: 24,
    flavor: [
      'Сделал так, что рота запомнит надолго.',
      'Дембельский аккорд выполнен. Можно собирать чемодан.',
      'Последний рывок — и ни одного замечания.'
    ]
  },
  // Время задано в реальных минутах до бонусов; часы службы остаются игровыми.
  { id: 'patrol', icon: '🔦', title: 'Обойти территорию', desc: 'Проверить периметр части', energy: 12, xp: [7, 9], money: [20, 25], morale: 0, hours: 0.5, baseMinutes: 10, flavor: ['Периметр осмотрен, замечаний нет.'] },
  { id: 'serve', icon: '🥣', title: 'Раздать обед', desc: 'Помочь с раздачей', energy: 15, xp: [9, 11], money: [25, 31], morale: 1, hours: 1, baseMinutes: 15, flavor: ['Обед вовремя получил каждый.'] },
  { id: 'kitchenClean', icon: '🧽', title: 'Убрать столовую', desc: 'Навести порядок после обеда', energy: 34, xp: [20, 24], money: [57, 67], morale: 0, hours: 2, baseMinutes: 45, flavor: ['Столы чистые, пол блестит.'] },
  { id: 'deliverFood', icon: '📦', title: 'Доставить продукты', desc: 'Принести припасы на кухню', energy: 25, xp: [15, 18], money: [42, 50], morale: 0, hours: 1.5, baseMinutes: 30, flavor: ['Припасы доставлены на кухню.'] },
  { id: 'shelf', icon: '🧃', title: 'Разложить товары', desc: 'Пополнить полки чипка', energy: 14, xp: [8, 10], money: [24, 30], morale: 0, hours: 1, baseMinutes: 15, flavor: ['На полках снова порядок.'] },
  { id: 'stocktake', icon: '📝', title: 'Посчитать товары', desc: 'Помочь с учётом припасов', energy: 22, xp: [13, 16], money: [37, 44], morale: 0, hours: 1.5, baseMinutes: 30, flavor: ['Остатки пересчитаны и записаны.'] },
  { id: 'unload', icon: '📦', title: 'Разгрузить поставку', desc: 'Принять коробки с товарами', energy: 34, xp: [20, 24], money: [57, 67], morale: 0, hours: 2, baseMinutes: 45, flavor: ['Поставка принята без потерь.'] },
  { id: 'medSort', icon: '💊', title: 'Разобрать аптечку', desc: 'Проверить медицинские запасы', energy: 10, xp: [6, 8], money: [17, 21], morale: 0, hours: 0.5, baseMinutes: 10, flavor: ['В аптечке всё на своих местах.'] },
  { id: 'medClean', icon: '🧼', title: 'Убрать медпункт', desc: 'Подготовить санчасть к приёму', energy: 30, xp: [18, 22], money: [50, 60], morale: 0, hours: 2, baseMinutes: 45, flavor: ['В медпункте чисто и спокойно.'] },
  { id: 'medHelp', icon: '🩹', title: 'Помочь санинструктору', desc: 'Подготовить перевязочные материалы', energy: 17, xp: [10, 12], money: [29, 35], morale: 1, hours: 1, baseMinutes: 20, flavor: ['Перевязочные материалы готовы.'] },
  { id: 'documents', icon: '📄', title: 'Разобрать документы', desc: 'Рассортировать бумаги штаба', energy: 12, xp: [7, 9], money: [20, 25], morale: 0, hours: 1, baseMinutes: 15, flavor: ['Документы разложены по папкам.'] },
  { id: 'dispatch', icon: '✉️', title: 'Доставить донесение', desc: 'Передать документы по части', energy: 20, xp: [12, 15], money: [35, 42], morale: 0, hours: 1.5, baseMinutes: 30, flavor: ['Донесение доставлено адресату.'] },
  { id: 'archive', icon: '🗃️', title: 'Навести порядок в архиве', desc: 'Сверить и убрать папки', energy: 30, xp: [18, 22], money: [50, 60], morale: 0, hours: 2, baseMinutes: 45, flavor: ['Архив приведён в порядок.'] }
];

// Свободные минуты: доступны всегда, идут параллельно основному занятию
// в отдельном слоте state.sideBusy и не трогают state.busy.
const SIDE_ACTIONS = [
  {
    id: 'sideStudy',
    icon: '📖',
    title: 'Полистать устав',
    desc: 'Подтянуть знания перед проверкой',
    energy: 6,
    xp: [14, 20],
    durationSeconds: 10,
    flavor: ['Устав прочитан до середины. Уже что-то.', 'Пара страниц — и на душе по-уставному спокойно.']
  },
  {
    id: 'sideEarn',
    icon: '🧰',
    title: 'Подработать у прапорщика',
    desc: 'Мелкая работа за наличные',
    energy: 8,
    xp: [3, 5],
    money: [24, 36],
    durationSeconds: 10,
    flavor: ['Прапорщик расплатился без напоминаний. Чудо.', 'Работа мелкая, зато деньги настоящие.']
  },
  {
    id: 'sideSong',
    icon: '🎸',
    title: 'Спеть под гитару',
    desc: 'Поднять настроение роте',
    energy: 3,
    xp: [3, 5],
    morale: 8,
    durationSeconds: 10,
    flavor: ['Рота подпевала — даже старшина.', 'Гитара нашлась, струны тоже. Настроение вверх.']
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

function sideDurationMs(side) {
  return (side.durationSeconds || 0) * 1000;
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
  const bonus = STARTER_ACTIONS.has(action.id) ? LEVEL_BONUSES[rankIndexFor(state.xp)] : 0;
  const ms = (action.baseMinutes ? action.baseMinutes * 60000 / (1 + activitySpeedBonus()) : action.hours * HOUR_MS / activitySpeed()) * (1 - bonus);
  return Math.max(60 * 1000, Math.round(ms));
}

const SHOP = [
  {
    id: 'pie',
    icon: '🥟',
    name: 'Пирожок с картошкой',
    desc: '+10 энергии и +2 духа',
    price: 35,
    temporary: true,
    fullMsg: 'Сначала проголодайся',
    blocked: () => state.energy >= state.maxEnergy,
    apply: () => {
      state.energy = Math.min(state.maxEnergy, state.energy + 10);
      state.morale = clamp(state.morale + 2, 0, 100);
    }
  },
  {
    id: 'choco',
    icon: '🍫',
    name: 'Шоколадка «Алёнка»',
    desc: '+8 боевого духа',
    price: 50,
    temporary: true,
    fullMsg: 'Дух и так боевой',
    blocked: () => state.morale >= 100,
    apply: () => {
      state.morale = clamp(state.morale + 8, 0, 100);
    }
  },
  {
    id: 'energy',
    icon: '⚡',
    name: 'Энергетик «Дизель»',
    desc: '+20 энергии',
    price: 65,
    temporary: true,
    fullMsg: 'Энергия и так на максимуме',
    blocked: () => state.energy >= state.maxEnergy,
    apply: () => {
      state.energy = Math.min(state.maxEnergy, state.energy + 20);
    }
  },
  {
    id: 'medkit',
    icon: '💊',
    name: 'Бинт и йод',
    desc: '+15 здоровья',
    price: 75,
    temporary: true,
    fullMsg: 'Здоровье и так в порядке',
    blocked: () => state.hp >= state.maxHp,
    apply: () => {
      state.hp = Math.min(state.maxHp, state.hp + 15);
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
    title: 'Достичь уровня D',
    desc: 'Уровень D',
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
    title: 'Достичь уровня B',
    desc: 'Уровень B',
    reward: { money: 200, xp: 50 },
    check: () => rankIndexFor(state.xp, state.contract) >= 4
  },
  {
    id: 'demob',
    icon: '😎',
    title: 'Достичь уровня S',
    desc: 'Уровень S',
    reward: { money: 500 },
    check: () => rankIndexFor(state.xp) >= 6
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
    title: 'Уровень D',
    desc: 'Достичь уровня D',
    reward: { money: 30 },
    check: () => rankIndexFor(state.xp, state.contract) >= 2
  },
  {
    id: 'sergeant',
    icon: '🏅',
    title: 'Уровень A',
    desc: 'Достичь уровня A',
    reward: { money: 120 },
    check: () => rankIndexFor(state.xp, state.contract) >= 5
  },
  {
    id: 'demob',
    icon: '😎',
    title: 'Уровень S',
    desc: 'Достичь уровня S',
    reward: { money: 300 },
    check: () => rankIndexFor(state.xp) >= 6
  },
  {
    id: 'rankE',
    icon: '⭐',
    title: 'Уровень E',
    desc: 'Дослужиться до уровня E',
    reward: { money: 20 },
    check: () => rankIndexFor(state.xp, state.contract) >= 1
  },
  {
    id: 'rankC',
    icon: '🎗️',
    title: 'Уровень C',
    desc: 'Дослужиться до уровня C',
    reward: { money: 80 },
    check: () => rankIndexFor(state.xp, state.contract) >= 3
  },
  {
    id: 'rankB',
    icon: '🏵️',
    title: 'Уровень B',
    desc: 'Дослужиться до уровня B',
    reward: { money: 150, morale: 5 },
    check: () => rankIndexFor(state.xp, state.contract) >= 4
  },
  {
    id: 'charge10',
    icon: '🏃',
    title: 'Бегун',
    desc: 'Сходить на зарядку 10 раз',
    reward: { money: 60 },
    progress: () => [Math.min(state.stats.byAction?.charge || 0, 10), 10],
    check: () => (state.stats.byAction?.charge || 0) >= 10
  },
  {
    id: 'drill10',
    icon: '🎖️',
    title: 'Строевик',
    desc: 'Отчеканить шаг 10 раз',
    reward: { money: 80, morale: 5 },
    progress: () => [Math.min(state.stats.byAction?.drill || 0, 10), 10],
    check: () => (state.stats.byAction?.drill || 0) >= 10
  },
  {
    id: 'mentor5',
    icon: '🧑‍🏫',
    title: 'Наставник',
    desc: 'Обучить молодых 5 раз',
    reward: { money: 70, morale: 5 },
    progress: () => [Math.min(state.stats.byAction?.mentor || 0, 5), 5],
    check: () => (state.stats.byAction?.mentor || 0) >= 5
  },
  {
    id: 'help10',
    icon: '🤝',
    title: 'Правая рука',
    desc: 'Помочь прапорщику 10 раз',
    reward: { money: 90 },
    progress: () => [Math.min(state.stats.byAction?.help || 0, 10), 10],
    check: () => (state.stats.byAction?.help || 0) >= 10
  },
  {
    id: 'duties10',
    icon: '🧹',
    title: 'Наряд вне очереди',
    desc: 'Сходить в наряд 10 раз',
    reward: { money: 110 },
    progress: () => [Math.min(state.stats.duties || 0, 10), 10],
    check: () => (state.stats.duties || 0) >= 10
  },
  {
    id: 'hours100',
    icon: '⏳',
    title: 'Служака',
    desc: 'Отслужить 100 игровых часов',
    reward: { money: 90, morale: 5 },
    progress: () => [Math.min(state.stats.hours || 0, 100), 100],
    check: () => (state.stats.hours || 0) >= 100
  },
  {
    id: 'earn2500',
    icon: '🏦',
    title: 'Заслуженный доход',
    desc: 'Заработать 2 500 ₽ за службу',
    reward: { money: 150 },
    progress: () => [Math.min(state.stats.totalEarned || 0, 2500), 2500],
    check: () => (state.stats.totalEarned || 0) >= 2500
  },
  {
    id: 'rich2',
    icon: '💎',
    title: 'Богатый боец',
    desc: 'Накопить 2 000 ₽',
    reward: { money: 180 },
    progress: () => [Math.min(state.stats.bestMoney || 0, 2000), 2000],
    check: () => (state.stats.bestMoney || 0) >= 2000
  },
  {
    id: 'events15',
    icon: '🎰',
    title: 'Счастливчик',
    desc: 'Пережить 15 событий',
    reward: { money: 100 },
    progress: () => [Math.min(state.stats.events || 0, 15), 15],
    check: () => (state.stats.events || 0) >= 15
  },
  {
    id: 'buys20',
    icon: '🛍️',
    title: 'Хозяин чипка',
    desc: 'Купить 20 товаров',
    reward: { money: 110 },
    progress: () => [Math.min(state.stats.buys || 0, 20), 20],
    check: () => (state.stats.buys || 0) >= 20
  },
  {
    id: 'package5',
    icon: '📦',
    title: 'Посылочный король',
    desc: 'Получить 5 посылок из дома',
    reward: { money: 80 },
    progress: () => [Math.min(state.stats.packages || 0, 5), 5],
    check: () => (state.stats.packages || 0) >= 5
  },
  {
    id: 'leave3',
    icon: '🚌',
    title: 'Дом, милый дом',
    desc: 'Сходить в увольнительную 3 раза',
    reward: { money: 130 },
    progress: () => [Math.min(state.stats.leaves || 0, 3), 3],
    check: () => (state.stats.leaves || 0) >= 3
  },
  {
    id: 'streak7',
    icon: '🔥',
    title: 'Верный уставу',
    desc: 'Заходить 7 дней подряд',
    reward: { money: 120, morale: 5 },
    progress: () => [Math.min(state.streak?.count || 0, 7), 7],
    check: () => (state.streak?.count || 0) >= 7
  },
  {
    id: 'collector',
    icon: '🎒',
    title: 'Запасливый',
    desc: 'Держать в инвентаре 5 разных предметов',
    reward: { money: 100 },
    progress: () => [Math.min(Object.values(state.inventory || {}).filter((n) => Number(n) > 0).length, 5), 5],
    check: () => Object.values(state.inventory || {}).filter((n) => Number(n) > 0).length >= 5
  },
  {
    id: 'actions50',
    icon: '🥇',
    title: 'Полсотни дел',
    desc: 'Выполнить 50 действий',
    reward: { money: 140, morale: 10 },
    progress: () => [Math.min(state.stats.actionsTotal || 0, 50), 50],
    check: () => (state.stats.actionsTotal || 0) >= 50
  }
];


/* ---------- state ---------- */

function defaultState() {
  const user = tgUser();
  return {
    saveVersion: 2,
    name: user?.first_name?.trim() || 'Срочник',
    avatar: '',
    avatarMini: '',
    xp: 0,
    money: 120,
    energy: 100,
    maxEnergy: 100,
    hp: 100,
    maxHp: 100,
    morale: 75,
    cooldowns: {},
    busy: { id: null, title: '', icon: '', until: 0, startedAt: 0, totalMs: 0 },
    sideBusy: { id: null, title: '', icon: '', until: 0, startedAt: 0, reward: null },
    purchases: { boots: 0, pillow: 0, kettle: 0, locker: 0, laces: 0, watch: 0, planner: 0 },
    duty: { date: gameDayKeyFrom(Date.now(), Date.now()), type: 'kitchen' },
    package: { date: gameDayKeyFrom(Date.now(), Date.now()), sentAt: 0, readyAt: 0, claimed: false },
    leaveAt: 0,
    sickbay: { date: gameDayKeyFrom(Date.now(), Date.now()), used: false },
    visitedToday: false,
    streak: { count: 0, lastDate: '' },
    loginRewards: { lastClaimDate: '', count: 0 },
    inventory: {},
    quest: { index: 0 },
    daily: {
      date: gameDayKeyFrom(Date.now(), Date.now()),
      progress: { hours: 0, earn: 0, call: 0 },
      done: {}
    },
    settings: { sound: true, notify: false, theme: 'dark' },
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
    nameChosen: false,
    log: [],
    lastEnergyAt: Date.now(),
    lastHpAt: Date.now(),
    startedAt: Date.now()
  };
}

function safeAvatar(value, limit = 200000) {
  return typeof value === 'string' && value.length <= limit && /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(value)
    ? value
    : '';
}

function loadState(rawOverride) {
  const base = defaultState();
  try {
    const raw = rawOverride === undefined ? localStorage.getItem(SAVE_KEY) : rawOverride;
    if (!raw) return base;
    const saved = JSON.parse(raw);
    if (saved.saveVersion !== 2) return base;
    const savedBusy = saved.busy || {};
    const knownBusy = savedBusy.id ? ACTIONS.find((a) => a.id === savedBusy.id) : null;
    const savedSide = saved.sideBusy || {};
    const knownSide = savedSide.id ? SIDE_ACTIONS.find((a) => a.id === savedSide.id) : null;
    const merged = {
      ...base,
      ...saved,
      name: saved.name || base.name,
      avatar: safeAvatar(saved.avatar),
      avatarMini: safeAvatar(saved.avatarMini, 40000),
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
      contract: false,
      nameChosen: saved.nameChosen === undefined ? true : Boolean(saved.nameChosen),
      purchases: { ...base.purchases, ...(saved.purchases || {}) },
      cooldowns: saved.cooldowns || {},
      busy: {
        id: savedBusy.id || null,
        title: savedBusy.title || knownBusy?.title || (savedBusy.id ? 'Занятие' : ''),
        icon: savedBusy.icon || knownBusy?.icon || (savedBusy.id ? '⏳' : ''),
        until: Number(savedBusy.until) || 0,
        startedAt: Number(savedBusy.startedAt) || 0,
        totalMs: Number(savedBusy.totalMs) || 0,
        reward: savedBusy.reward || null,
        rewardVersion: savedBusy.rewardVersion || 0
      },
      sideBusy: {
        id: savedSide.id || null,
        title: savedSide.title || knownSide?.title || (savedSide.id ? 'Свободное дело' : ''),
        icon: savedSide.icon || knownSide?.icon || (savedSide.id ? '⏳' : ''),
        until: Number(savedSide.until) || 0,
        startedAt: Number(savedSide.startedAt) || 0,
        reward: savedSide.reward || null
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
      visitedToday: Boolean(saved.visitedToday),
      streak: {
        count: Math.max(0, Number(saved.streak?.count) || 0),
        lastDate: saved.streak?.lastDate || ''
      },
      loginRewards: { ...base.loginRewards, ...(saved.loginRewards || {}) },
      inventory: { ...base.inventory, ...(saved.inventory || {}) },
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

// Архив хранится отдельно на устройстве и никогда не отправляется в облако.
const LOG_ARCHIVE_KEY = `${SAVE_KEY_BASE}.log-archive.${storageUserId || 'local'}`;
function readLogArchive() {
  try { const value = JSON.parse(localStorage.getItem(LOG_ARCHIVE_KEY) || '[]'); return Array.isArray(value) ? value : []; }
  catch { return []; }
}
function archiveOldEvents(entries, now = Date.now()) {
  const old = entries.filter((entry) => Number(entry.t) > 0 && Number(entry.t) < now - LOG_RETENTION_MS);
  if (!old.length) return true;
  try {
    const archive = readLogArchive();
    const seen = new Set(archive.map((entry) => JSON.stringify(entry)));
    old.forEach((entry) => { const key = JSON.stringify(entry); if (!seen.has(key)) { archive.push(entry); seen.add(key); } });
    localStorage.setItem(LOG_ARCHIVE_KEY, JSON.stringify(archive));
    return true;
  } catch { return false; }
}

let saveTimer = null;
let isResetting = false;
const CLOUD_URL = 'https://kxuwpsfkjeyzsytclsys.supabase.co/functions/v1/telegram-save';
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
  archiveOldEvents(state.log);
  try { localStorage.setItem(SAVE_KEY + '.backup', JSON.stringify(state)); } catch { /* keep cloud copy */ }
  const loaded = loadState(JSON.stringify(result.data));
  archiveOldEvents(loaded.log);
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
  snapshot.log = snapshot.log.filter((entry) => Number(entry.t) >= Date.now() - LOG_RETENTION_MS);
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
    const adminRow = $('#adminRow');
    if (adminRow) adminRow.hidden = !isAdmin;
    updateAdminTab();
    if (result.exists) {
      const useLocal = Boolean(localRaw && localMeta.user === user && localMeta.dirty && localMeta.revision === result.revision);
      if (localRaw && !useLocal && (!localMeta.user || localMeta.revision !== result.revision)) {
        try { localStorage.setItem(SAVE_KEY + '.backup', localRaw); } catch { /* preserve when possible */ }
      }
      if (!useLocal) {
        archiveOldEvents(state.log);
        const loaded = loadState(JSON.stringify(result.data));
        archiveOldEvents(loaded.log);
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
    updateAdminTab();
    setCloudMeta({ user, revision: cloudRevision, dirty: cloudPending });
    cloudStatus('Аккаунт Telegram подключён');
  } catch {
    if (sessionExpired || accountBanned) return;
    cloudInitFailed = true;
    cloudReady = false;
    updateAdminTab();
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

}

/* ---------- derived values ---------- */

function daysServed() {
  return Math.max(0, Math.floor((Date.now() - state.startedAt) / DAY_MS));
}

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
  const capped = false;
  const into = state.xp - rank.xp;
  const span = next ? next.xp - rank.xp : 1;

  return {
    idx,
    rank,
    next,
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

function sideBusyAction() {
  if (!state.sideBusy?.id) return null;
  if (state.sideBusy.until <= Date.now()) return null;
  return {
    id: state.sideBusy.id,
    title: state.sideBusy.title || 'Свободное дело',
    icon: state.sideBusy.icon || '⏳',
    until: state.sideBusy.until
  };
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
  statusDetails: $('#statusDetails'),
  statusProgress: $('#statusProgress'),
  activityDock: $('#activityDock'),
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
  topName: $('#topName'),
  topLevel: $('#topLevel'),
  profileTop: $('#profileTop'),
  editNameBtn: $('#editNameBtn'),
  avatarBtn: $('#avatarBtn'),
  avatarMedia: $('#avatarMedia'),
  topAvatar: $('#topAvatar'),
  avatarInput: $('#avatarInput'),
  shopMoney: $('#shopMoney'),
  shopTrips: $('#shopTrips'),
  shopSpeed: $('#shopSpeed'),
  shopList: $('#shopList'),
  shopNote: $('#shopNote'),
  dailyList: $('#dailyList'),
  careList: $('#careList'),
  kppCareList: $('#kppCareList'),
  healthList: $('#healthList'),
  questBody: $('#questBody'),
  questCounter: $('#questCounter'),
  dutyPicker: $('#dutyPicker'),
  staffPosition: $('#staffPosition'),
  staffAch: $('#staffAch'),
  leaderboardBtn: $('#leaderboardBtn'),
  achievementsBtn: $('#achievementsBtn'),
  demobAlbumBtn: $('#demobAlbumBtn'),
  actionGrid: $('#actionGrid'),
  plazGrid: $('#plazGrid'),
  kppGrid: $('#kppGrid'),
  canteenGrid: $('#canteenGrid'),
  shopGrid: $('#shopGrid'),
  sickbayGrid: $('#sickbayGrid'),
  staffGrid: $('#staffGrid'),
  canteenMenu: $('#canteenMenu'),
  canteenMoney: $('#canteenMoney'),
  mapStage: $('#mapStage'),
  mapDay: $('#mapDay'),
  mapCentral: $('.map-node-center'),
  mapCentralNote: $('#mapCentralNote'),
  mapStatusPlaz: $('#mapStatusPlaz'),
  mapStatusKpp: $('#mapStatusKpp'),
  mapStatusCanteen: $('#mapStatusCanteen'),
  mapStatusShop: $('#mapStatusShop'),
  mapStatusSickbay: $('#mapStatusSickbay'),
  mapStatusStaff: $('#mapStatusStaff'),
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

function updateHpHint() {
  if (!els.hpHint) return;
  if (state.hp >= state.maxHp) {
    els.hpHint.textContent = 'полностью восстановлено';
  } else {
    const missing = Math.max(0, Math.ceil(state.maxHp - state.hp));
    const wait = Math.max(0, state.lastHpAt + missing * HP_MS - Date.now());
    const timer = `Полное восстановление — ${fmtClock(wait)}`;
    els.hpHint.textContent = state.hp < 25 ? `❕ ${timer}` : timer;
  }
  els.hpHint.classList.toggle('is-alert', state.hp < 25);
  els.hpHint.title = state.hp < 25 ? 'Доход снижен из-за низкого здоровья' : '';
}

let renderedAvatar = null;

function renderAvatar(force = false) {
  if (!force && renderedAvatar === state.avatar) return;
  renderedAvatar = state.avatar;
  const markup = state.avatar
    ? `<img src="${state.avatar}" alt="" draggable="false" />`
    : '🪖';
  if (els.avatarMedia) els.avatarMedia.innerHTML = markup;
  if (els.topAvatar) els.topAvatar.innerHTML = markup;
  els.avatarBtn?.classList.toggle('has-photo', Boolean(state.avatar));
}

function renderHero() {
  renderAvatar();
  const r = rankProgress();
  els.heroName.textContent = state.name;
  els.rankBadge.textContent = `Ранг ${r.rank.title}`;
  els.rankBadge.dataset.rank = r.rank.title;
  const periodText = '';
  if (els.lvlChip) els.lvlChip.textContent = periodText;
  if (els.rankBadgeTop) els.rankBadgeTop.textContent = `Уровень ${r.rank.title}`;
  if (els.lvlChipTop) els.lvlChipTop.textContent = periodText;

  if (r.capped) {
    els.xpLabel.textContent = `${r.into} XP до S`;
  } else if (r.next) {
    els.xpLabel.textContent = `${r.into} / ${r.span} XP`;
  } else {
    els.xpLabel.textContent = 'S · максимум';
  }
  els.xpBar.style.width = `${r.pct}%`;

  els.hpVal.textContent = Math.round(state.hp);
  els.hpBar.style.width = `${clamp((state.hp / state.maxHp) * 100, 0, 100)}%`;
  updateHpHint();

  els.energyVal.textContent = `${Math.round(state.energy)}/${state.maxEnergy}`;
  els.energyBar.style.width = `${clamp((state.energy / state.maxEnergy) * 100, 0, 100)}%`;

  els.moraleVal.textContent = Math.round(state.morale);
  els.moraleBar.style.width = `${clamp(state.morale, 0, 100)}%`;
  els.moraleHint.textContent = `доход ×${(0.85 + (state.morale / 100) * 0.3).toFixed(2)}`;

  const days = daysUntilDemob();
  if (els.daysLeft) els.daysLeft.textContent = days === 0 ? 'дембель! 😎' : `${days} ${plural(days, 'день', 'дня', 'дней')}`;
  els.dutyCount.textContent = fmt(state.stats.duties);
  if (els.streakMeta) els.streakMeta.textContent = `${state.streak?.count || 0} ${plural(state.streak?.count || 0, 'день', 'дня', 'дней')}`;
  els.moneyTop.textContent = rub(state.money);
  if (els.topName) els.topName.textContent = state.name;
  if (els.topLevel) { els.topLevel.textContent = r.rank.title; els.topLevel.dataset.rank = r.rank.title; }
  const buffs = $('#heroBuffs');
  if (buffs) buffs.innerHTML = `<div class="hero-buffs-title">Бонус</div><div class="hero-buffs-grid"><div><span>Начальные занятия</span><b>−${Math.round(LEVEL_BONUSES[r.idx] * 100)}% времени</b></div><div><span>Скорость от улучшений</span><b>+${Math.round(activitySpeedBonus() * 100)}%</b></div></div>`;
}

/* ---------- daily render ---------- */

function rewardParts(reward) {
  const parts = [];
  if (reward.money) parts.push(`+${fmt(reward.money)} ₽`);
  if (reward.xp) parts.push(`+${reward.xp} XP`);
  if (reward.morale) parts.push(`+${reward.morale} 🔥`);
  if (reward.hp) parts.push(`+${reward.hp} ❤️`);
  if (reward.energy) parts.push(`+${reward.energy} ⚡`);
  if (reward.item) {
    const item = SHOP.find((entry) => entry.id === reward.item);
    if (item) parts.push(`${item.icon} ${item.name} ×${reward.count || 1}`);
  }
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

// Календарь выдаётся раз в календарный день, предметы хранятся до использования.
function renderLoginCalendar() {
  const root = $('#loginCalendar');
  const button = $('#claimLoginReward');
  if (!root || !button) return;
  const progress = state.loginRewards.count || 0;
  const claimed = state.loginRewards.lastClaimDate === todayKey();
  const index = (claimed ? Math.max(0, progress - 1) : progress) % LOGIN_REWARDS.length;
  root.innerHTML = `<p>Входов подряд: ${state.streak.count}</p><div class="login-calendar">${LOGIN_REWARDS.map((reward, i) => {
    const item = SHOP.find((entry) => entry.id === reward.item);
    const label = [reward.money ? `${reward.money} ₽` : '', reward.xp ? `${reward.xp} XP` : '', item ? `${item.icon} ×${reward.count}` : ''].filter(Boolean).join(' · ');
    const done = i < index || (i === index && claimed);
    return `<div class="login-day ${i === index ? 'is-current' : ''} ${done ? 'is-claimed' : ''}"><b>Награда ${i + 1}${done ? ' ✓' : ''}</b><span>${label}</span></div>`;
  }).join('')}</div>`;
  button.disabled = claimed;
  button.classList.toggle('is-claimed', claimed);
  button.textContent = claimed ? 'Сегодня получено' : 'Забрать награду';
}

let inventoryTab = 'consumable';
const inventoryFilters = new Set();
function inventoryCategory(item) {
  if (item.id === 'medkit' || item.id === 'locker') return 'health';
  if (['pie', 'choco', 'energy'].includes(item.id)) return 'food';
  if (['laces', 'watch', 'planner'].includes(item.id)) return 'speed';
  return 'comfort';
}
function renderInventory() {
  const root = $('#inventoryList');
  const filters = $('#inventoryFilters');
  if (!root || !filters) return;
  const categories = inventoryTab === 'consumable'
    ? [['food', '🥟 Еда и напитки'], ['health', '❤️ Здоровье']]
    : [['health', '❤️ Здоровье'], ['speed', '⚡ Скорость'], ['comfort', '🛏️ Быт']];
  filters.innerHTML = categories.map(([id, label]) => `<button type="button" data-inventory-filter="${id}" class="${inventoryFilters.has(id) ? 'is-active' : ''}" aria-pressed="${inventoryFilters.has(id)}">${label}</button>`).join('');
  $$('#inventoryTabs [data-inventory-tab]').forEach((button) => button.classList.toggle('is-active', button.dataset.inventoryTab === inventoryTab));
  const items = SHOP.filter((item) => {
    const count = inventoryTab === 'consumable' ? state.inventory[item.id] : state.purchases[item.id];
    return (inventoryTab === 'consumable' ? item.temporary : item.permanent) && count > 0 && (!inventoryFilters.size || inventoryFilters.has(inventoryCategory(item)));
  });
  root.innerHTML = items.length ? items.map((item) => {
    const count = inventoryTab === 'consumable' ? state.inventory[item.id] : state.purchases[item.id];
    return `<div class="inventory-row"><span>${item.icon} <b>${item.name}</b><small>${item.desc} · ${count}${item.permanent && item.max ? `/${item.max}` : ' шт.'}</small></span>${item.temporary ? `<button class="care-btn" data-use-item="${item.id}">Использовать</button>` : '<span class="inventory-owned">Активно</span>'}</div>`;
  }).join('') : '<p class="inventory-empty">Здесь пока нет предметов.</p>';
}

function claimLoginReward() {
  if (state.loginRewards.lastClaimDate === todayKey()) return;
  const reward = LOGIN_REWARDS[(state.loginRewards.count || 0) % LOGIN_REWARDS.length];
  state.loginRewards.lastClaimDate = todayKey();
  state.loginRewards.count = (state.loginRewards.count || 0) + 1;
  if (reward.item) state.inventory[reward.item] = (state.inventory[reward.item] || 0) + reward.count;
  applyReward(reward);
  pushLog({ icon: '🎁', text: 'Ежедневная награда получена', gains: rewardParts(reward), type: 'good' });
  checkAchievements(); renderAll(); save(); toast('🎁 Награда получена', 'good');
}

function useInventoryItem(id) {
  const item = SHOP.find((entry) => entry.id === id && entry.temporary);
  if (!item || !(state.inventory[id] > 0)) return;
  if (item.blocked && item.blocked()) { toast(item.fullMsg || 'Сейчас это не нужно', 'info'); return; }
  if (state.energy >= state.maxEnergy) state.lastEnergyAt = Date.now();
  if (state.hp >= state.maxHp) state.lastHpAt = Date.now();
  state.inventory[id] -= 1;
  item.apply(); renderAll(); save();
  toast(`${item.icon} ${item.name} использован`, 'good');
}

function renderLevelsSheet(el) {
  const current = rankIndexFor(state.xp);
  el.innerHTML = `<h3 class="sheet-title">Уровни и бонусы</h3><p class="sheet-text">Бонусы сокращают время начальных занятий и не суммируются между уровнями.</p><div class="level-list">${RANKS.slice(0, current + 2).map((rank, i) => `<div class="level-row ${i === current ? 'is-current' : ''}"><b>${rank.title}${i === current ? ' · текущий' : i > current ? ' · следующий' : ''}</b><span>${LEVEL_BONUSES[i] ? `Начальные занятия на ${Math.round(LEVEL_BONUSES[i] * 100)}% быстрее` : 'Базовая скорость'}${i ? ' · +10 к максимуму энергии и +5 к максимуму здоровья' : ''}${i === 3 ? ' · доступ к помощи и караулу' : i === 4 ? ' · доступ к обучению молодых' : i === 5 ? ' · доступ к аккорду' : ''}</span></div>`).join('')}</div><button class="btn btn-primary" data-close>Закрыть</button>`;
  $$('.level-row', el).forEach((row, i) => { row.dataset.rank = RANKS[i].title; });
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
  const current = state.duty?.type;
  const type = DUTIES[current] ? current : 'kitchen';
  state.duty = { date: gameDayKey(), type };
}

function updateStreak() {
  const today = todayKey();
  if (state.streak.lastDate === today) return false;
  if (state.streak.lastDate === yesterdayKey()) state.streak.count += 1;
  else state.streak.count = 1;
  state.streak.lastDate = today;

  const milestone = STREAK_MILESTONES[state.streak.count];
  if (!milestone) return true;

  applyReward(milestone.reward);
  pushLog({
    icon: milestone.icon,
    text: `Стрик входов: ${state.streak.count} ${plural(state.streak.count, 'день', 'дня', 'дней')} подряд!`,
    gains: rewardParts(milestone.reward),
    type: 'level'
  });
  toast(`${milestone.icon} ${state.streak.count} ${plural(state.streak.count, 'день', 'дня', 'дней')} подряд — награда!`, 'good');
  return true;
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
  if (state.visitedDate !== today) {
    state.visitedDate = today;
    state.visitedToday = false;
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
      toast('🌅 Новый игровой день — задания обновились', 'info');
      notifyPlayer('Новый игровой день', 'Задания обновились.');
    }
  }

  if (updateStreak()) changed = true;

  if (changed) {
    renderDaily();
    renderLoginCalendar();
    renderShopPanel();
    renderCare();
    renderKppCare();
    renderQuest();
    renderDutyPicker();
    renderActions();
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

  return items;
}

function kppItems() {
  const items = [];
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

  items.push({ id: 'visit', icon: '🚶', title: 'Посещения', desc: 'Поднять боевой дух встречей с близкими. Раз в игровой день.', btn: state.visitedToday ? 'получено' : 'Посетить', action: state.visitedToday ? undefined : 'visit', disabled: Boolean(state.visitedToday) });
  return items;
}

function renderCare() {
  if (!els.careList) return;
  els.careList.innerHTML = careItems().filter((item) => item.id === 'sickbay').map((item) => `
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

function renderKppCare() {
  if (!els.kppCareList) return;
  els.kppCareList.innerHTML = [...careItems().filter((item) => item.id.startsWith('package-')), ...kppItems()].map(careItemHtml).join('');
}

function careItemHtml(item) {
  return `<li class="care-item ${item.disabled ? 'is-disabled' : ''}"><span class="care-icon" aria-hidden="true">${item.icon}</span><div class="care-main"><b>${item.title}</b><span>${item.desc}</span></div><button class="care-btn" ${item.action ? `data-care="${item.action}"` : ''} ${item.disabled ? 'disabled' : ''}>${item.btn}</button></li>`;
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
  renderKppCare();
  save();
  toast('📮 Запрос отправлен — посылка придёт через 2 часа', 'info');
  haptic('success');
}

function claimPackage() {
  if (packageState() !== 'ready') return;

  state.package.claimed = true;
  state.package.date = gameDayKey();
  state.stats.packages = (state.stats.packages || 0) + 1;
  const energyBefore = state.energy;
  const moraleBefore = state.morale;
  if (state.energy >= state.maxEnergy) state.lastEnergyAt = Date.now();
  applyReward({ energy: 25, morale: 10 });
  const receivedEnergy = state.energy - energyBefore;
  const receivedMorale = state.morale - moraleBefore;

  pushLog({
    icon: '📦',
    text: 'Посылка из дома: печенье, носки и записка «Кушай, сынок».',
    gains: [`+${receivedEnergy} ⚡`, `+${receivedMorale} 🔥`],
    type: 'good'
  });

  checkAchievements();
  renderAll();
  save();
  toast('📦 Посылка получена!', 'good');
  window.setTimeout(() => openModal((el) => {
    el.innerHTML = `<div class="sheet-emoji">🎁</div><h3 class="sheet-title">Содержимое посылки</h3><p class="sheet-text">Получено: +${receivedEnergy} ⚡ энергии и +${receivedMorale} 🔥 боевого духа.${receivedEnergy < 25 || receivedMorale < 10 ? ' Часть награды не поместилась из-за предела характеристик.' : ''}</p><button class="btn btn-primary" data-close>Понятно</button>`;
  }), 2500);
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

function visit() {
  if (state.visitedDate !== gameDayKey()) {
    state.visitedDate = gameDayKey();
    state.visitedToday = false;
  }
  if (state.visitedToday) return;
  state.visitedToday = true;
  state.morale = clamp(state.morale + 12, 0, 100);
  pushLog({ icon: '🚶', text: 'Посещения: встретился с близкими.', gains: ['+12 🔥'], type: 'good' });
  renderAll(); save(); toast('🚶 Боевой дух поднят', 'good');
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

let locationFilter = null;
function renderDutyPicker() {
  if (!els.dutyPicker) return;
  const filters = $('#locationFilters');
  if (filters) filters.innerHTML = LOCATIONS.map((entry) => `<button type="button" data-location-filter="${entry.id}" class="${entry.id === locationFilter ? 'is-active' : ''}" aria-pressed="${entry.id === locationFilter}">${entry.icon} ${entry.title}</button>`).join('');
  renderCurrentDuty();
}

// Показываем сохранённое занятие и его уже зафиксированные награды.
function renderCurrentDuty() {
  if (!els.dutyPicker) return;
  const active = busyAction();
  if (!active) {
    els.dutyPicker.innerHTML = '<div class="duty-label">Текущее занятие</div><div class="duty-value">Свободен</div>';
    return;
  }
  const reward = state.busy.reward;
  const details = reward ? [`${reward.hours} игровых ч`, `+${reward.xpGain} XP`, reward.moneyGain ? `+${reward.moneyGain} ₽` : '', reward.moraleGain ? `${reward.moraleGain > 0 ? '+' : ''}${reward.moraleGain} 🔥` : ''].filter(Boolean).join(' · ') : 'Награда уже начислена';
  const start = Number(state.busy.startedAt) || 0;
  const total = Number(state.busy.totalMs) || (start ? active.until - start : 0);
  const duration = total > 0 ? ` · всего ${fmtDuration(total)}` : '';
  els.dutyPicker.innerHTML = `<div class="duty-label">Текущее занятие</div><div class="duty-value">${escapeHtml(active.icon)} ${escapeHtml(active.title)}</div><div class="duty-note">Осталось ${fmtClock(active.until - Date.now())}${duration}</div><div class="duty-note">${details}${reward ? ' после завершения' : ''}</div>`;
}

// У нарядов общий идентификатор действия, поэтому активный определяется по виду.
function updateDutyStatuses() {
  const active = busyAction();
  const activeDuty = active?.id === 'duty' ? state.duty?.type : null;
  $$('[data-action="duty"]').forEach((card) => {
    const type = card.dataset.dutyType;
    const isActive = Boolean(activeDuty) && (!type || type === activeDuty);
    const status = $('.action-status', card);
    if (!status) return;
    if (isActive) status.textContent = 'выполняется';
    else if (activeDuty && status.textContent === 'выполняется') status.textContent = 'занято';
  });
}

/* ---------- log render ---------- */

function timeLabel(ts) {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

let logHoursShown = 1;
let logWindowEnd = Date.now();

// Храним события за 24 часа; отображаем историю часовыми порциями.
function pruneLog(now = Date.now()) {
  const cutoff = now - LOG_RETENTION_MS;
  const before = state.log.length;
  if (!archiveOldEvents(state.log, now)) return false;
  state.log = state.log.filter((entry) => Number(entry.t) >= cutoff);
  return before !== state.log.length;
}

function renderLogEntry(entry, prepend) {
  const empty = $('.log-empty', els.log);
  if (empty) empty.remove();

  const li = document.createElement('li');
  li.className = `log-item log-${entry.type || 'info'}`;

  const gains = (entry.gains || []).map((g) => `<span>${escapeHtml(String(g))}</span>`).join('');

  li.innerHTML = `
    <span class="log-icon" aria-hidden="true">${escapeHtml(String(entry.icon || '•'))}</span>
    <div class="log-body">
      <p>${escapeHtml(String(entry.text || ''))}</p>
      <div class="log-meta">
        <time>${timeLabel(entry.t)}</time>
        <div class="log-gains">${gains}</div>
      </div>
    </div>
  `;

  if (prepend) els.log.insertBefore(li, els.log.firstChild);
  else els.log.appendChild(li);

}

function renderLog(reset = false) {
  if (reset) { logHoursShown = 1; logWindowEnd = Date.now(); }
  const now = Date.now();
  if (pruneLog(now)) save();
  const cutoff = Math.max(now - LOG_RETENTION_MS, logWindowEnd - logHoursShown * HOUR_MS);
  const visible = state.log.filter((entry) => entry.t >= cutoff);
  const more = $('#logMore');
  els.log.innerHTML = '';
  if (!visible.length) {
    const li = document.createElement('li');
    li.className = 'log-empty';
    li.textContent = 'За выбранное время событий нет.';
    els.log.appendChild(li);
  } else {
    visible.forEach((entry) => renderLogEntry(entry, false));
  }
  if (more) more.hidden = !state.log.some((entry) => entry.t < cutoff);
}

function pushLog({ icon, text, gains = [], type = 'info' }) {
  const entry = { t: Date.now(), icon, text, gains: gains.filter(Boolean), type };
  state.log.unshift(entry);
  pruneLog();
  renderLog();
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
  renderLoginCalendar();
  renderInventory();
  renderCare();
  renderKppCare();
  renderQuest();
  renderDutyPicker();
  renderSideActions();
  renderStaff();
  renderShopPanel();
  renderCanteen();
  renderMap();
  updateActionStates();
  updateDutyStatuses();
  renderStatusLine();
  renderMoney();
  renderSettings();
}

function renderSettings() {
  const theme = state.settings.theme === 'light' ? 'light' : 'dark';
  document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'light' ? '#e9eef7' : '#0a0c12');
  $$('[data-theme-choice]').forEach((button) => {
    const active = button.dataset.themeChoice === theme;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-pressed', String(active));
  });
  if (tg) {
    try {
      const color = theme === 'light' ? '#e9eef7' : '#0a0c12';
      tg.setHeaderColor?.(color);
      tg.setBackgroundColor?.(color);
    } catch (e) { /* Не все версии Telegram поддерживают смену цвета. */ }
  }
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
  if (els.activityDock) els.activityDock.hidden = !active;
  if (active) {
    const elapsed = Math.max(0, now - (state.busy.startedAt || (state.busy.until - (state.busy.totalMs || HOUR_MS))));
    const total = state.busy.totalMs || Math.max(HOUR_MS, state.busy.until - (state.busy.startedAt || now));
    const remaining = Math.max(0, active.until - now);
    els.statusText.textContent = `${active.icon} ${active.title} —`;
    els.statusTime.textContent = fmtClock(remaining);
    const reward = state.busy.reward;
    const details = [];
    if (reward) {
      const rewards = [
        reward.xpGain ? `+${reward.xpGain} XP` : '',
        reward.moneyGain ? `+${fmt(reward.moneyGain)} ₽` : '',
        reward.moraleGain ? `${reward.moraleGain > 0 ? '+' : ''}${reward.moraleGain} 🔥` : ''
      ].filter(Boolean);
      if (rewards.length) details.push(`После завершения: ${rewards.join(' · ')}`);
    }
    if (els.statusDetails) els.statusDetails.textContent = details.join(' · ');
    els.statusProgress.style.width = `${clamp((elapsed / total) * 100, 0, 100)}%`;
  } else {
    els.statusText.textContent = '';
    els.statusTime.textContent = '';
    if (els.statusDetails) els.statusDetails.textContent = '';
    els.statusProgress.style.width = '0%';
  }
}

function renderRecoverySheet(el, resource) {
  const energy = resource === 'energy';
  const value = energy ? state.energy : state.hp;
  const max = energy ? state.maxEnergy : state.maxHp;
  const interval = energy ? ENERGY_MS : HP_MS;
  const lastAt = energy ? state.lastEnergyAt : state.lastHpAt;
  const missing = Math.max(0, Math.ceil(max - value));
  const wait = missing ? Math.max(0, lastAt + missing * interval - Date.now()) : 0;
  el.innerHTML = `<h3 class="sheet-title">${energy ? '⚡ Энергия' : '❤️ Здоровье'}</h3><p class="sheet-text">${Math.round(value)} / ${max}</p><p class="sheet-text">Полное восстановление — ${missing ? fmtDuration(wait) : 'полное'}</p><button class="btn btn-primary" data-close>Закрыть</button>`;
}

function updateEnergyPopover() {
  const popup = $('#energyPopover');
  if (!popup || popup.hidden) return;
  const missing = Math.max(0, Math.ceil(state.maxEnergy - state.energy));
  const wait = missing ? Math.max(0, state.lastEnergyAt + missing * ENERGY_MS - Date.now()) : 0;
  popup.textContent = `Полное восстановление — ${missing ? fmtDuration(wait) : 'полное'}`;
}

function renderMoney() {
  els.moneyTop.textContent = rub(state.money);
}

/* ---------- map of the garrison ---------- */

function renderMap() {
  const busy = busyAction();
  if (els.mapCentralNote) {
    els.mapCentralNote.textContent = busy
      ? `идёт: ${busy.title.toLowerCase()}`
      : 'свободен · выбери занятие';
  }
  if (els.mapCentral) els.mapCentral.classList.toggle('is-busy', Boolean(busy));

  if (els.mapStatusShop) els.mapStatusShop.textContent = '';

  if (els.mapStatusPlaz) {
    els.mapStatusPlaz.textContent = '';
  }

  if (els.mapStatusKpp) {
    els.mapStatusKpp.textContent = '';
  }

  if (els.mapStatusCanteen) {
    els.mapStatusCanteen.textContent = '';
  }

  if (els.mapStatusSickbay) {
    els.mapStatusSickbay.textContent = '';
  }

  if (els.mapStatusStaff) {
    els.mapStatusStaff.textContent = '';
  }
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
  const isPlayer = Boolean(entry.isMe);
  return {
    name: entry.name || 'Срочник',
    emoji: rank.emoji,
    avatar: isPlayer
      ? (safeAvatar(state.avatarMini, 40000) || safeAvatar(state.avatar))
      : safeAvatar(entry.avatar, 40000),
    xp,
    rankTitle: rank.title,
    isPlayer,
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
      avatar: '',
      xp,
      rankTitle: RANKS[rankIndexFor(xp, true)].title,
      isPlayer: false
    };
  });

  const myRank = RANKS[rankIndexFor(state.xp, state.contract)];
  const player = {
    name: state.name,
    emoji: myRank.emoji,
    avatar: safeAvatar(state.avatarMini, 40000) || safeAvatar(state.avatar),
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

  els.staffPosition.textContent = !cloudLeaderboard && tg?.initData
    ? (leaderboardError ? 'Рейтинг недоступен' : 'Загрузка рейтинга…')
    : placeInfo.place ? `Ты на ${placeInfo.place} месте из ${placeInfo.total}` : 'Ты пока вне рейтинга';
  els.staffAch.textContent = `Открыто ${unlocked} из ${ACHIEVEMENTS.length}`;
  els.leaderboardBtn.disabled = false;

  els.demobAlbumBtn.hidden = true;
  renderStaffTab();
}

let staffTab = 'leaderboard';
function renderStaffTab() {
  const content = $('#staffTabContent');
  if (!content) return;
  els.leaderboardBtn.classList.toggle('is-selected', staffTab === 'leaderboard');
  els.achievementsBtn.classList.toggle('is-selected', staffTab === 'achievements');
  if (staffTab === 'leaderboard') renderLeaderboard(content);
  else renderAchievements(content);
  content.querySelectorAll('[data-close], .sheet-handle').forEach((el) => el.remove());
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
    const details = entry.rankTitle;

    return `
      <li class="lb-row ${entry.isPlayer ? 'is-me' : ''}">
        <span class="lb-place">${medal}</span>
        <span class="lb-avatar"${entry.avatar ? '' : ' aria-hidden="true"'}>${entry.avatar ? `<img src="${entry.avatar}" alt="" loading="lazy" draggable="false" />` : entry.emoji}</span>
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
        if (el.id === 'staffTabContent') renderStaffTab();
        else renderLeaderboard(el);
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

function actionCardHtml(action, dutyKey = null) {
  const chips = [
    `<span class="chip-cost">⚡ ${action.energy}</span>`,
    ...(ACTION_HEALTH_COST[action.id] ? [`<span class="chip-health">❤️ −${ACTION_HEALTH_COST[action.id]}</span>`] : []),
    `<span class="chip-hours">🕒 ${fmtDuration(activityDurationMs(action))}</span>`,
    `<span>+${action.xp[0]}–${action.xp[1]} XP</span>`
  ];

  return `
    <button class="action-card" data-action="${action.id}"${dutyKey ? ` data-duty-type="${dutyKey}"` : ''} aria-label="${action.title}">
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

function sideCardHtml(side) {
  const chips = [
    `<span class="chip-cost">⚡ ${side.energy}</span>`,
    `<span class="chip-hours">⏱ ${fmtSideDuration(sideDurationMs(side))}</span>`,
    `<span>+${side.xp[0]}–${side.xp[1]} XP</span>`
  ];
  const reward = side.money
    ? `+${side.money[0]}–${side.money[1]} ₽`
    : side.morale ? `+${side.morale} 🔥`
      : side.hp ? `+${side.hp} ❤️` : 'опыт';

  return `
    <button class="action-card side-card" data-side-action="${side.id}" aria-label="${side.title}">
      <span class="action-icon" aria-hidden="true">${side.icon}</span>
      <span class="action-main">
        <span class="action-title">${side.title}</span>
        <span class="action-desc">${side.desc}</span>
        <span class="action-chips">${chips.join('')}</span>
      </span>
      <span class="action-side">
        <span class="action-reward">${reward}</span>
        <span class="action-status">готово</span>
      </span>
      <span class="cd-line" aria-hidden="true"></span>
    </button>
  `;
}

function renderSideActions() {
  const section = $('#sideActions');
  const grid = $('#sideActionGrid');
  if (!section || !grid) return;
  section.hidden = false;
  grid.innerHTML = SIDE_ACTIONS.map(sideCardHtml).join('');
  updateSideActionStates();
}

function updateSideActionStates() {
  const grid = $('#sideActionGrid');
  if (!grid) return;
  const now = Date.now();
  const sideActive = sideBusyAction();
  SIDE_ACTIONS.forEach((side) => {
    const running = sideActive?.id === side.id;
    const blocked = Boolean(sideActive) && !running;
    const lowEnergy = state.energy < side.energy;
    grid.querySelectorAll(`[data-side-action="${side.id}"]`).forEach((root) => {
      root.classList.toggle('is-cd', running);
      root.classList.toggle('is-blocked', blocked);
      root.classList.toggle('is-locked', !running && !blocked && lowEnergy);
      const status = $('.action-status', root);
      const line = $('.cd-line', root);
      if (running) {
        const total = sideDurationMs(side);
        const remain = Math.max(0, sideActive.until - now);
        status.textContent = `⏱ ${fmtClock(remain)}`;
        line.style.width = `${clamp((1 - remain / total) * 100, 0, 100)}%`;
      } else if (blocked) {
        status.textContent = 'занято';
        line.style.width = '0%';
      } else {
        status.textContent = lowEnergy ? `нужно ⚡${side.energy}` : 'готово';
        line.style.width = '0%';
      }
    });
  });
}

function fillActionGrid(container, actions, dutyKey = null) {
  if (!container) return;

  container.innerHTML = actions.map((action) => {
    if (action.id === 'duty' && dutyKey) return actionCardHtml({ ...actionFor('duty'), ...DUTIES[dutyKey] }, dutyKey);
    return actionCardHtml(actionFor(action.id));
  }).join('');

  actions.forEach((base) => {
    container.querySelectorAll(`[data-action="${base.id}"]`).forEach((root) => {
      const list = cardEls.get(base.id) || [];
      list.push({
        root,
        status: $('.action-status', root),
        line: $('.cd-line', root)
      });
      cardEls.set(base.id, list);
    });
  });
}

function renderActions() {
  cardEls.clear();

  const location = LOCATIONS.find((entry) => entry.id === locationFilter);
  const barracksActions = ACTIONS.filter((action) => action.id !== 'duty' && (!location || location.actions.includes(action.id)))
    .sort((a, b) => activityDurationMs(actionFor(a.id)) - activityDurationMs(actionFor(b.id)));
  fillActionGrid(els.actionGrid, barracksActions);
  renderSideActions();
  const empty = $('#filterEmpty');
  if (empty) empty.hidden = !location || barracksActions.length > 0;
  const grids = { plaz: els.plazGrid, kpp: els.kppGrid, canteen: els.canteenGrid, shop: els.shopGrid, sickbay: els.sickbayGrid, staff: els.staffGrid };
  Object.entries(grids).forEach(([id, grid]) => {
    const location = LOCATIONS.find((entry) => entry.id === id);
    const dutyKey = location.duties[0] || null;
    fillActionGrid(grid, ACTIONS.filter((action) => location.actions.includes(action.id) || (action.id === 'duty' && location.duties.length > 0)), dutyKey);
  });

  updateActionStates();
  updateDutyStatuses();
}

function updateActionStates() {
  const now = Date.now();
  const levelIdx = rankIndexFor(state.xp);

  ACTIONS.forEach((base) => {
    const action = actionFor(base.id);
    const refs = cardEls.get(base.id) || [];
    if (!refs.length) return;

    const requiredLevel = ACTION_LEVELS[base.id] || 0;
    const periodOk = levelIdx >= requiredLevel;
    const remain = (state.cooldowns[base.id] || 0) - now;
    const blocker = busyBlockerFor(base.id);
    const lowEnergy = state.energy < action.energy;
    const cooldownMs = (base.cooldownHours || base.hours) * HOUR_MS;

    refs.forEach((ref) => {
      ref.root.classList.toggle('is-period-locked', !periodOk);
      ref.root.classList.toggle('is-cd', periodOk && remain > 0);
      ref.root.classList.toggle('is-locked', periodOk && remain <= 0 && !blocker && lowEnergy);
      ref.root.classList.toggle('is-blocked', periodOk && remain <= 0 && Boolean(blocker));

      if (!periodOk) {
        ref.status.textContent = `🔒 ${RANKS[requiredLevel].title}`;
        ref.line.style.width = '0%';
      } else if (remain > 0) {
        ref.status.textContent = blocker?.id === base.id ? 'выполняется' : `⏱ ${fmtDuration(remain)}`;
        ref.line.style.width = `${clamp((1 - remain / cooldownMs) * 100, 0, 100)}%`;
      } else if (blocker) {
        ref.status.textContent = blocker.id === base.id ? 'выполняется' : 'занято';
        ref.line.style.width = '0%';
      } else {
        ref.status.textContent = lowEnergy ? `нужно ⚡${action.energy}` : 'готово';
        ref.line.style.width = '0%';
      }
    });
  });
  updateSideActionStates();
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
    text: `Новый уровень — ${rank.title}!`,
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
  // Обновляем карточки: изменились доступ и время начальных занятий.
  renderActions();
  renderDutyPicker();
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

function doSideAction(id) {
  const side = SIDE_ACTIONS.find((entry) => entry.id === id);
  if (!side) return;

  const activeSide = sideBusyAction();
  if (activeSide) {
    toast(`⏳ Сначала закончите: ${activeSide.title.toLowerCase()}`, 'info');
    haptic('error');
    return;
  }

  if (state.energy < side.energy) {
    toast('⚡ Не хватает энергии — отдохни или загляни в столовую', 'bad');
    haptic('error');
    return;
  }

  const now = Date.now();
  if (side.energy && state.energy >= state.maxEnergy) state.lastEnergyAt = now;
  state.energy -= side.energy;

  const durationMs = sideDurationMs(side);
  state.sideBusy = {
    id,
    title: side.title,
    icon: side.icon,
    startedAt: now,
    until: now + durationMs,
    reward: {
      xpGain: rand(side.xp[0], side.xp[1]),
      moneyGain: side.money ? rand(side.money[0], side.money[1]) : 0,
      moraleGain: side.morale || 0,
      hpGain: side.hp || 0,
      flavor: pick(side.flavor)
    }
  };

  renderAll();
  save();
  haptic('success');
  playSound('success');
  toast(`${side.icon} ${side.title} начато · ${fmtSideDuration(durationMs)}`, 'info');
}

function finishSideAction() {
  const entry = state.sideBusy;
  if (!entry?.id) return;

  const side = SIDE_ACTIONS.find((item) => item.id === entry.id);
  const reward = entry.reward || null;
  const title = entry.title || side?.title || 'Свободное дело';
  const icon = entry.icon || side?.icon || '✅';
  state.sideBusy = { id: null, title: '', icon: '', until: 0, startedAt: 0, reward: null };

  if (!reward) {
    renderAll();
    save();
    return;
  }

  const gains = [];
  const xpGain = Number(reward.xpGain) || 0;
  const moneyGain = Number(reward.moneyGain) || 0;

  if (moneyGain) {
    state.money += moneyGain;
    state.stats.totalEarned = (state.stats.totalEarned || 0) + moneyGain;
    dailyAdd('earn', moneyGain);
    gains.push(`+${fmt(moneyGain)} ₽`);
  }
  if (reward.moraleGain) {
    state.morale = clamp(state.morale + reward.moraleGain, 0, 100);
    gains.push(`+${reward.moraleGain} 🔥`);
  }
  if (reward.hpGain) {
    state.hp = clamp(state.hp + reward.hpGain, 0, state.maxHp);
    gains.push(`+${reward.hpGain} ❤️`);
  }
  gains.unshift(`+${xpGain} XP`);

  state.stats.actionsTotal = (state.stats.actionsTotal || 0) + 1;
  state.stats.byAction = state.stats.byAction || {};
  state.stats.byAction[entry.id] = (state.stats.byAction[entry.id] || 0) + 1;

  addXp(xpGain);
  checkAchievements();
  pushLog({
    icon,
    text: reward.flavor || `${title}: готово.`,
    gains,
    type: 'good'
  });

  renderAll();
  save();
  haptic('success');
  playSound('success');
  toast(`${icon} ${title} выполнено · +${xpGain} XP`, 'good');
}

function doAction(id) {
  const base = ACTIONS.find((a) => a.id === id);
  if (!base) return;
  const action = actionFor(id);
  const now = Date.now();

  const requiredLevel = ACTION_LEVELS[id] || 0;
  if (rankIndexFor(state.xp) < requiredLevel) {
    toast(`🔒 Откроется на уровне ${RANKS[requiredLevel].title}`, 'info');
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
    toast('⚡ Не хватает энергии — отдохни или загляни в столовую', 'bad');
    haptic('error');
    return;
  }

  // Здоровье расходуется при начале, как и энергия; награды — по завершении.
  const healthCost = ACTION_HEALTH_COST[id] || 0;
  if (healthCost && state.hp <= healthCost) {
    toast(`❤️ Нужно больше ${healthCost} здоровья`, 'bad');
    return;
  }

  if (state.energy >= state.maxEnergy) state.lastEnergyAt = now;
  state.energy -= action.energy;
  if (healthCost) {
    if (state.hp >= state.maxHp) state.lastHpAt = now;
    state.hp -= healthCost;
  }

  const mult = rewardMultiplier();
  const xpGain = Math.max(1, Math.round(rand(action.xp[0], action.xp[1]) * mult));
  const moneyGain = Math.round(rand(action.money[0], action.money[1]) * mult);
  const moraleGain = action.morale || 0;
  if (base.cooldownHours) state.cooldowns[id] = now + base.cooldownHours * HOUR_MS;

  const durationMs = activityDurationMs(action);
  state.busy = {
    id,
    title: action.title,
    icon: action.icon,
    startedAt: now,
    totalMs: durationMs,
    until: now + durationMs,
    rewardVersion: 1,
    reward: { xpGain, moneyGain, moraleGain, hours: action.hours, flavor: pick(action.flavor), icon: action.icon, title: action.title, duty: Boolean(action.duty) }
  };
  renderAll();
  save();
  haptic('success');
  playSound('success');

  toast(`${action.icon} ${action.title} начато · награда после выполнения`, 'info');
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
    profileAvatarDraft = null;
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
  profileAvatarDraft = null;
  renderer(els.sheet);
  els.sheet.scrollTop = 0;
}

function closeModal() {
  if (!state.nameChosen && $('#profileForm', els.sheet)) return;
  showNextModal();
}

function renderLevelSheet(el, rank, gained) {
  el.innerHTML = `
    <div class="sheet-emoji">${rank.emoji}</div>
    <h3 class="sheet-title">Новый уровень!</h3>
    <p class="sheet-text">Теперь твой уровень — <b>${rank.title}</b>.</p>
    <div class="sheet-rewards">
      <span class="reward-pill">+${gained * 10} ⚡ к максимуму</span>
      <span class="reward-pill">+${gained * 5} ❤️ к максимуму</span>
    </div>
    <button class="btn btn-primary" data-close>Служу Отечеству!</button>
  `;
}

// Единый редактор профиля: аватарка и ник.
let profileAvatarDraft = null;

function renderProfileSheet(el, options = {}) {
  const required = Boolean(options.required);
  const focusName = options.focusName !== false;
  const draft = { value: state.avatar, mini: state.avatarMini, render: null };
  profileAvatarDraft = draft;

  const preview = (value) => value ? `<img src="${value}" alt="Аватарка бойца">` : '🪖';

  el.innerHTML = `
    <h3 class="sheet-title">${required ? 'Знакомство' : 'Профиль бойца'}</h3>
    <p class="sheet-text">${required ? 'Выбери ник и, если хочешь, поставь свою аватарку.' : 'Аватарка и ник — в одном редакторе.'}</p>
    <div class="avatar-preview" id="profileAvatarPreview">${preview(draft.value)}</div>
    <div class="avatar-actions">
      <button class="btn btn-ghost" type="button" id="avatarPick">${draft.value ? 'Заменить фото' : 'Загрузить фото'}</button>
      <button class="btn btn-ghost" type="button" id="avatarRemove"${draft.value ? '' : ' hidden'}>Удалить</button>
    </div>
    <form id="profileForm">
      <label class="name-label" for="profileName">Ник бойца</label>
      <input id="profileName" class="name-input" maxlength="24" required autocomplete="nickname" value="${escapeHtml(state.name || '')}">
      <p class="name-error" id="profileError" aria-live="polite"></p>
      <div class="sheet-actions${required ? ' is-single' : ''}">
        ${required ? '' : '<button class="btn btn-ghost" type="button" data-close>Отмена</button>'}
        <button class="btn btn-primary" type="submit">Сохранить</button>
      </div>
    </form>
  `;

  const syncAvatar = () => {
    const box = $('#profileAvatarPreview', el);
    if (box) box.innerHTML = preview(draft.value);
    const pick = $('#avatarPick', el);
    if (pick) pick.textContent = draft.value ? 'Заменить фото' : 'Загрузить фото';
    const remove = $('#avatarRemove', el);
    if (remove) remove.hidden = !draft.value;
  };
  draft.render = syncAvatar;

  $('#avatarPick', el)?.addEventListener('click', () => els.avatarInput?.click());
  $('#avatarRemove', el)?.addEventListener('click', () => {
    draft.value = '';
    draft.mini = '';
    syncAvatar();
    haptic();
  });

  const form = $('#profileForm', el);
  const input = $('#profileName', el);
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const name = input.value.trim();
    if (!name) { $('#profileError', el).textContent = 'Введите ник'; input.focus(); return; }
    state.name = name;
    state.nameChosen = true;
    state.avatar = draft.value;
    state.avatarMini = draft.mini;
    renderAvatar(true);
    renderAll();
    save();
    closeModal();
    haptic('success');
    toast(required ? `Добро пожаловать, ${name}!` : 'Профиль обновлён', 'good');
    if (required) showTutorial();
  });
  input.addEventListener('input', () => { $('#profileError', el).textContent = ''; });
  if (focusName) input.focus();
}

const AVATAR_SIZE = 256;
const AVATAR_MINI_SIZE = 96;
const AVATAR_MAX_SOURCE = 12 * 1024 * 1024;

function drawAvatar(source, size, quality) {
  const width = source.width || source.naturalWidth || 0;
  const height = source.height || source.naturalHeight || 0;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Браузер не поддерживает обработку фото');
  ctx.fillStyle = '#171d11';
  ctx.fillRect(0, 0, size, size);
  const scale = Math.max(size / width, size / height);
  const drawWidth = width * scale;
  const drawHeight = height * scale;
  ctx.drawImage(source, (size - drawWidth) / 2, (size - drawHeight) / 2, drawWidth, drawHeight);
  return canvas.toDataURL('image/jpeg', quality);
}

function loadAvatarBitmap(file) {  if (typeof createImageBitmap === 'function') {
    return createImageBitmap(file, { imageOrientation: 'from-image' })
      .catch(() => createImageBitmap(file));
  }
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Не удалось открыть изображение')); };
    img.src = url;
  });
}

async function fileToAvatar(file) {
  if (!file || !file.type.startsWith('image/')) throw new Error('Выбери файл изображения');
  if (file.size > AVATAR_MAX_SOURCE) throw new Error('Файл слишком большой — до 12 МБ');
  let source;
  try {
    source = await loadAvatarBitmap(file);
  } catch {
    throw new Error('Не удалось открыть фото — подойдёт JPG или PNG');
  }
  const width = source.width || source.naturalWidth || 0;
  const height = source.height || source.naturalHeight || 0;
  if (!width || !height) throw new Error('Не удалось прочитать изображение');
  const avatar = drawAvatar(source, AVATAR_SIZE, 0.86);
  const avatarMini = drawAvatar(source, AVATAR_MINI_SIZE, 0.8);
  if (typeof source.close === 'function') source.close();
  return { avatar, avatarMini };
}

// Старые сохранения хранили только большую аватарку — готовим мини-копию
// для рейтинга один раз при запуске.
function ensureAvatarMini() {
  if (!state.avatar || state.avatarMini) return;
  const img = new Image();
  img.onload = () => {
    if (!state.avatar || state.avatarMini) return;
    try {
      state.avatarMini = drawAvatar(img, AVATAR_MINI_SIZE, 0.8);
      save();
    } catch { /* ignore */ }
  };
  img.src = state.avatar;
}

async function applyAvatarFile(file) {
  try {
    const result = await fileToAvatar(file);
    haptic('success');
    if (profileAvatarDraft) {
      profileAvatarDraft.value = result.avatar;
      profileAvatarDraft.mini = result.avatarMini;
      profileAvatarDraft.render?.();
      toast('Фото готово — нажми «Сохранить»', 'info');
      return;
    }
    state.avatar = result.avatar;
    state.avatarMini = result.avatarMini;
    renderAvatar(true);
    renderAll();
    save();
    toast('Аватарка обновлена', 'good');
  } catch (error) {
    haptic('error');
    toast(error?.message || 'Не удалось обработать фото', 'bad');
  }
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

// Ранг определяется опытом: выбор ранга устанавливает его начальный порог,
// а ручное редактирование опыта сразу обновляет выбранный ранг.
function bindAdminRank(select, xpInput) {
  select.innerHTML = RANKS.map((rank, index) => `<option value="${index}">${rank.title} · от ${fmt(rank.xp)} XP</option>`).join('');
  const syncFromXp = () => {
    const xp = Number(xpInput.value);
    if (xpInput.value.trim() && Number.isSafeInteger(xp) && xp >= 0) select.value = String(rankIndexFor(xp));
  };
  select.addEventListener('change', () => { xpInput.value = RANKS[Number(select.value)].xp; });
  xpInput.addEventListener('input', syncFromXp);
  syncFromXp();
}

function adminItemRows(data) {
  const inventory = data.inventory || {};
  const purchases = data.purchases || {};
  const rows = SHOP.map((item) => {
    const count = item.permanent ? Number(purchases[item.id] || 0) : Number(inventory[item.id] || 0);
    return `<div class="admin-item-row"><span class="admin-item-name">${item.icon} <b>${escapeHtml(item.name)}</b><small>${item.permanent ? 'Постоянный предмет' : 'Расходник'}</small></span><input class="admin-item-count" data-admin-count="${item.id}" type="number" min="0" max="1000000" value="${count}" aria-label="Количество ${escapeHtml(item.name)}"><button type="button" data-admin-item="${item.id}" data-admin-delta="-1" aria-label="Убавить ${escapeHtml(item.name)}">−</button><button type="button" data-admin-item="${item.id}" data-admin-delta="1" aria-label="Добавить ${escapeHtml(item.name)}">+</button><button type="button" class="admin-item-edit" data-admin-edit="${item.id}" aria-label="Изменить ${escapeHtml(item.name)}">✎</button></div>`;
  }).join('');
  return `<div class="admin-items" id="adminItems"><h4>Предметы и улучшения</h4><p class="sheet-text">Изменения применятся после нажатия общей кнопки сохранения.</p>${rows}</div>`;
}

function localGrantRow() {
  return `<div class="admin-grant"><h3>Выдать предмет</h3><p>Добавляет предмет в локальный инвентарь для проверки.</p><div class="admin-grant-row"><select id="localAdminItem">${SHOP.map((item) => `<option value="${item.id}">${item.icon} ${item.name}</option>`).join('')}</select><input id="localAdminItemCount" type="number" min="1" max="1000000" step="1" value="1" aria-label="Количество предметов"><button class="btn btn-primary" id="localAdminGrant">Выдать</button></div></div>`;
}

function changeAdminItem(data, item, delta) {
  const bucket = item.permanent ? (data.purchases ||= {}) : (data.inventory ||= {});
  const current = Math.max(0, Number(bucket[item.id]) || 0);
  const next = Math.max(0, current + delta);
  const actual = next - current;
  if (!actual) return;
  bucket[item.id] = next;
  if (item.permanent) {
    const effects = { pillow: ['maxEnergy', 15], boots: ['maxEnergy', 8], locker: ['maxHp', 15], kettle: ['morale', 6] };
    const effect = effects[item.id];
    if (effect) data[effect[0]] = Math.max(effect[0] === 'maxEnergy' || effect[0] === 'maxHp' ? 100 : 0, (Number(data[effect[0]]) || 0) + effect[1] * actual);
    if (item.id === 'pillow' || item.id === 'boots') data.energy = Math.min(Number(data.maxEnergy) || 100, Number(data.energy) || 0);
    if (item.id === 'locker') data.hp = Math.min(Number(data.maxHp) || 100, Number(data.hp) || 0);
    data.morale = clamp(Number(data.morale) || 0, 0, 100);
  }
}

function renderAdmin(el) {
  el.innerHTML = `<h3 class="sheet-title">Управление игроками</h3>
    <p class="sheet-text">Поиск по последним 100 игрокам или точный поиск по Telegram ID.</p>
    <label class="admin-label">Поиск <input id="adminSearch" placeholder="Имя или Telegram ID" autocomplete="off"></label>
    <div id="adminList">Загрузка…</div>
    <label class="admin-label">Telegram ID <input id="adminTarget" inputmode="numeric" placeholder="Telegram ID"></label>
    <button class="btn btn-ghost" id="adminLoad">Загрузить игрока</button>
    <div id="adminEditor"></div>`;
  const list = $('#adminList', el);
  const target = $('#adminTarget', el);
  const editor = $('#adminEditor', el);
  let players = [];
  function showPlayers() {
    const query = $('#adminSearch', el).value.trim().toLocaleLowerCase();
    const matches = players.filter(p => `${p.name} ${p.telegram_id}`.toLocaleLowerCase().includes(query));
    list.innerHTML = matches.map(p => `<button class="admin-player" data-id="${escapeHtml(p.telegram_id)}"><b>${escapeHtml(p.name)}</b><span>${escapeHtml(p.telegram_id)} · ${fmt(p.xp)} XP${p.banned ? ' · заблокирован' : ''}</span></button>`).join('') || 'Игроки не найдены';
  }
  $('#adminSearch', el).addEventListener('input', showPlayers);
  adminRequest('list').then(result => {
    if (!el.isConnected) return;
    players = result.players;
    showPlayers();
  }).catch(() => { list.textContent = 'Не удалось загрузить список'; });
  list.addEventListener('click', e => { const b = e.target.closest('[data-id]'); if (b) { target.value = b.dataset.id; $('#adminLoad', el).click(); } });
  $('#adminLoad', el).addEventListener('click', async () => {
    const id = target.value.trim();
    if (!/^\d{1,20}$/.test(id)) { toast('Введите Telegram ID', 'bad'); return; }
    try {
      const player = await adminRequest('get', id);
      editor.innerHTML = `<h3 class="admin-title">Редактирование игрока</h3>
        <p class="sheet-text">ID: ${escapeHtml(id)} · ревизия ${player.revision}${player.banned ? ' · заблокирован' : ''}</p>
        <div class="admin-grid">
          <label>Имя <input id="adminName" maxlength="64"></label>
          <label>Ранг <select id="adminRank"></select></label>
          <label>Опыт (XP) <input id="adminXp" type="number" min="0" max="1000000" step="1"></label>
          <label>Деньги (₽) <input id="adminMoney" type="number" min="0" max="1000000000" step="1"></label>
         <label>Энергия <input id="adminEnergy" type="number" min="0" max="500" step="1"></label>
          <label>Максимум энергии <input id="adminMaxEnergy" type="number" min="100" max="500" step="1"></label>
          <label>Здоровье <input id="adminHp" type="number" min="0" max="300" step="1"></label>
          <label>Максимум здоровья <input id="adminMaxHp" type="number" min="100" max="300" step="1"></label>
           <label>Боевой дух <input id="adminMorale" type="number" min="0" max="100" step="1"></label>
         </div>
         <div class="admin-grant"><h4>Выдать предмет</h4><div class="admin-grant-row"><select id="adminGrantItem">${SHOP.map((item) => `<option value="${item.id}">${item.icon} ${item.name}</option>`).join('')}</select><input id="adminGrantAmount" type="number" min="1" max="1000000" value="1" inputmode="numeric" aria-label="Количество предметов"><button type="button" class="btn btn-ghost" id="adminGrantButton">Выдать</button></div></div>
         ${adminItemRows(player.data)}
        <details class="admin-advanced"><summary>Полное сохранение (JSON)</summary><p class="sheet-text">Для опытных пользователей: ошибки могут повредить прогресс. Сохраняется отдельно от полей выше.</p><textarea id="adminData" rows="12" spellcheck="false"></textarea><button class="btn btn-ghost" id="adminSaveJson">Сохранить JSON</button></details>
         <button class="btn btn-primary" id="adminSave">Сохранить изменения</button>
         <button class="btn btn-ghost" id="adminBan">${player.banned ? 'Разблокировать' : 'Заблокировать'}</button>
        <button class="btn btn-danger" id="adminReset">Сбросить прогресс</button>`;
      const fields = { Name: 'name', Xp: 'xp', Money: 'money', Energy: 'energy', MaxEnergy: 'maxEnergy', Hp: 'hp', MaxHp: 'maxHp', Morale: 'morale' };
      for (const [suffix, key] of Object.entries(fields)) $(`#admin${suffix}`, editor).value = player.data[key] ?? (key === 'maxEnergy' || key === 'maxHp' ? 100 : key === 'name' ? '' : 0);
      bindAdminRank($('#adminRank', editor), $('#adminXp', editor));
      $('#adminData', editor).value = JSON.stringify(player.data, null, 2);
      const submit = async (data) => {
        if (!confirm(`Сохранить изменения игрока ${id}?`)) return;
        try { await adminRequest('save', id, data, player.revision); toast('Сохранение обновлено', 'good'); $('#adminLoad', el).click(); }
        catch (err) { toast(err.message, 'bad'); }
      };
      const draft = { ...player.data, inventory: { ...(player.data.inventory || {}) }, purchases: { ...(player.data.purchases || {}) } };
      const syncItemDraft = () => {
        SHOP.forEach((item) => {
          const input = $(`[data-admin-count="${item.id}"]`, editor);
          const bucket = item.permanent ? draft.purchases : draft.inventory;
          if (!input || !bucket) return;
          const value = Math.max(0, Math.min(1000000, Number(input.value) || 0));
          const old = Number(bucket[item.id] || 0);
          changeAdminItem(draft, item, value - old);
          input.value = String(value);
        });
      };
      $('#adminGrantButton', editor).onclick = () => {
        const item = SHOP.find((entry) => entry.id === $('#adminGrantItem', editor).value);
        const amount = Number($('#adminGrantAmount', editor).value);
        if (!item || !Number.isSafeInteger(amount) || amount < 1 || amount > 1000000) { toast('Введите корректное количество', 'bad'); return; }
        const input = $(`[data-admin-count="${item.id}"]`, editor);
        input.value = String(Math.min(1000000, (Number(input.value) || 0) + amount));
        toast(`${item.icon} Добавлено в изменения: ${item.name} ×${amount}`, 'info');
      };
      editor.addEventListener('input', (event) => {
        const input = event.target.closest('[data-admin-count]');
        if (!input) return;
        const item = SHOP.find((entry) => entry.id === input.dataset.adminCount);
        if (item) input.value = String(Math.max(0, Math.min(1000000, Number(input.value) || 0)));
      });
      editor.addEventListener('click', (event) => {
        const button = event.target.closest('[data-admin-item]');
        const edit = event.target.closest('[data-admin-edit]');
        const item = SHOP.find((entry) => entry.id === (button?.dataset.adminItem || edit?.dataset.adminEdit));
        if (!item) return;
        if (!edit) {
          const input = $(`[data-admin-count="${item.id}"]`, editor);
          input.value = String(Math.max(0, Math.min(1000000, (Number(input.value) || 0) + Number(button.dataset.adminDelta))));
          return;
        }
        openModal((modalEl) => {
          modalEl.innerHTML = `<h3 class="sheet-title">Изменить предмет</h3><p class="sheet-text">${item.icon} ${escapeHtml(item.name)}</p><div class="admin-adjust-choice"><button type="button" class="is-active" data-adjust="1">Прибавить</button><button type="button" data-adjust="-1">Убавить</button></div><label class="admin-label">Количество<input id="adminItemAmount" type="number" min="1" max="1000000" value="1" inputmode="numeric"></label><div class="sheet-actions"><button class="btn btn-ghost" data-close>Отмена</button><button class="btn btn-primary" id="applyAdminItem">Применить</button></div>`;
          let direction = 1;
          $$('.admin-adjust-choice button', modalEl).forEach((choice) => choice.onclick = () => { direction = Number(choice.dataset.adjust); $$('.admin-adjust-choice button', modalEl).forEach((b) => b.classList.toggle('is-active', b === choice)); });
          $('#applyAdminItem', modalEl).onclick = () => {
            const amount = Number($('#adminItemAmount', modalEl).value);
            if (!Number.isSafeInteger(amount) || amount < 1 || amount > 1000000) { toast('Введите корректное количество', 'bad'); return; }
            const input = $(`[data-admin-count="${item.id}"]`, editor);
            input.value = String(Math.max(0, Math.min(1000000, (Number(input.value) || 0) + amount * direction)));
            closeModal();
          };
        });
      });
      $('#adminSave', editor).onclick = () => {
        const data = { ...player.data };
        for (const [suffix, key] of Object.entries(fields)) {
          const input = $(`#admin${suffix}`, editor);
          if (key === 'name') { data.name = input.value.trim(); if (!data.name) { toast('Введите имя', 'bad'); return; } }
          else { if (!input.value.trim() || !input.checkValidity() || !Number.isSafeInteger(Number(input.value))) { toast('Проверьте значения полей', 'bad'); return; } data[key] = Number(input.value); }
        }
        syncItemDraft();
        data.inventory = draft.inventory;
        data.purchases = draft.purchases;
        data.maxEnergy = draft.maxEnergy || data.maxEnergy;
        data.maxHp = draft.maxHp || data.maxHp;
        if (data.energy > data.maxEnergy || data.hp > data.maxHp) { toast('Значение не может превышать максимум', 'bad'); return; }
        submit(data);
      };
      $('#adminSaveJson', editor).onclick = () => {
        let data;
        try { data = JSON.parse($('#adminData', editor).value); } catch { toast('Некорректный JSON', 'bad'); return; }
        if (!data || typeof data !== 'object' || Array.isArray(data)) { toast('JSON должен содержать объект', 'bad'); return; }
        submit(data);
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

// Локальная панель для проверки интерфейса без Telegram и Supabase.
function renderLocalAdminPanel() {
  const root = $('#adminPanelContent');
  if (!root) return;
  root.innerHTML = `<div class="admin-local-head"><div><h3>Локальный игрок</h3><p>Изменения применяются только в этом браузере.</p></div><span class="admin-local-badge">LOCAL</span></div>
    <div class="admin-grid">
      <label>Имя <input id="localAdminName" maxlength="24"></label>
      <label>Ранг <select id="localAdminRank"></select></label>
      <label>Опыт (XP) <input id="localAdminXp" type="number" min="0" max="1000000" step="1"></label>
      <label>Деньги (₽) <input id="localAdminMoney" type="number" min="0" max="1000000000" step="1"></label>
      <label>Энергия <input id="localAdminEnergy" type="number" min="0" max="500" step="1"></label>
      <label>Макс. энергия <input id="localAdminMaxEnergy" type="number" min="100" max="500" step="1"></label>
      <label>Здоровье <input id="localAdminHp" type="number" min="0" max="300" step="1"></label>
      <label>Макс. здоровье <input id="localAdminMaxHp" type="number" min="100" max="300" step="1"></label>
      <label>Боевой дух <input id="localAdminMorale" type="number" min="0" max="100" step="1"></label>
    </div>
    <div class="admin-local-actions"><button class="btn btn-primary" id="localAdminSave">Сохранить</button><button class="btn btn-danger" id="localAdminReset">Сбросить прогресс</button></div>
    ${localGrantRow()}
    <details class="admin-advanced"><summary>Полное сохранение JSON</summary><textarea id="localAdminData" rows="14" spellcheck="false"></textarea><button class="btn btn-ghost" id="localAdminSaveJson">Сохранить JSON</button></details>`;
  const fields = { Name: 'name', Xp: 'xp', Money: 'money', Energy: 'energy', MaxEnergy: 'maxEnergy', Hp: 'hp', MaxHp: 'maxHp', Morale: 'morale' };
  for (const [suffix, key] of Object.entries(fields)) $(`#localAdmin${suffix}`, root).value = state[key] ?? (key === 'name' ? '' : 0);
  bindAdminRank($('#localAdminRank', root), $('#localAdminXp', root));
  $('#localAdminData', root).value = JSON.stringify(state, null, 2);
  $('#localAdminSave', root).onclick = () => {
    const next = { ...state };
    for (const [suffix, key] of Object.entries(fields)) {
      const input = $(`#localAdmin${suffix}`, root);
      if (key === 'name') next.name = input.value.trim() || 'Срочник';
      else if (!input.checkValidity() || !Number.isSafeInteger(Number(input.value))) { toast('Проверьте значения полей', 'bad'); return; }
      else next[key] = Number(input.value);
    }
    if (next.energy > next.maxEnergy || next.hp > next.maxHp) { toast('Значение не может превышать максимум', 'bad'); return; }
    Object.assign(state, next); save(); renderAll(); renderLocalAdminPanel(); toast('Локальные данные сохранены', 'good');
  };
  $('#localAdminSaveJson', root).onclick = () => {
    try {
      const data = JSON.parse($('#localAdminData', root).value);
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error();
      Object.assign(state, loadState(JSON.stringify({ ...data, saveVersion: 2 }))); save(); renderAll(); renderLocalAdminPanel(); toast('JSON сохранён', 'good');
    } catch { toast('Некорректный JSON', 'bad'); }
  };
  $('#localAdminGrant', root).onclick = () => {
    const id = $('#localAdminItem', root).value;
    const count = Number($('#localAdminItemCount', root).value);
    const item = SHOP.find((entry) => entry.id === id);
    if (!item || !Number.isSafeInteger(count) || count < 1 || count > 1000000) { toast('Введите корректное количество', 'bad'); return; }
    if (item.permanent) {
      state.purchases[id] = (state.purchases[id] || 0) + count;
      for (let i = 0; i < count; i += 1) item.apply();
    } else {
      state.inventory[id] = (state.inventory[id] || 0) + count;
    }
    save(); renderAll(); renderLocalAdminPanel(); toast(`${item.icon} Выдано: ${item.name} ×${count}`, 'good');
  };
  $('#localAdminReset', root).onclick = () => {
    if (!confirm('Сбросить локальный прогресс?')) return;
    const name = state.name;
    Object.assign(state, defaultState(), { name, nameChosen: true });
    save(); renderAll(); renderLocalAdminPanel(); toast('Локальный прогресс сброшен', 'good');
  };
}

function updateAdminTab() {
  const row = $('#adminRow');
  const localRow = $('#adminRowLocal');
  const localPreview = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
  if (row) row.hidden = !(isAdmin && cloudReady);
  if (localRow) localRow.hidden = !localPreview;
}

function renderAdminPanel() {
  const root = $('#adminPanelContent');
  if (!root) return;
  if (isAdmin && cloudReady) renderAdmin(root);
  else if (['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)) renderLocalAdminPanel();
  else root.innerHTML = '<p class="admin-access-denied">Доступ к панели закрыт.</p>';
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
        <span>${item.desc}${item.permanent && item.max ? ` · ${bought}/${item.max}` : ''}</span>
      </div>
      <button class="buy-btn ${poor && !soldOut && !blockedByTrips ? 'is-poor' : ''}" data-buy="${item.id}" ${soldOut || blockedByTrips ? 'disabled' : ''}>${label}</button>
    </li>
  `;
}

function renderShopPanel() {
  if (!els.shopList) return;

  const noTrips = false;

  els.shopMoney.textContent = rub(state.money);
  if (els.shopNote) els.shopNote.textContent = '';

  const temporary = SHOP.filter((item) => !item.permanent && !['pie', 'choco', 'energy', 'medkit'].includes(item.id)).sort((a, b) => a.price - b.price);
  const permanent = SHOP.filter((item) => item.permanent).sort((a, b) => a.price - b.price);

  els.shopList.innerHTML = `
    ${temporary.length ? '<li class="shop-section"><span>Расходники</span></li>' : ''}
    ${temporary.map((item) => shopItemHtml(item, noTrips)).join('')}
    <li class="shop-section"><span>Апгрейды казармы</span><small>всегда доступны</small></li>
    ${permanent.map((item) => shopItemHtml(item, noTrips)).join('')}
  `;

  renderCanteen();
}

function renderCanteen() {
  if (!els.canteenMenu) return;

  const noTrips = false;
  const food = SHOP.filter((item) => ['pie', 'choco', 'energy'].includes(item.id));

  if (els.canteenMoney) els.canteenMoney.textContent = rub(state.money);
  els.canteenMenu.innerHTML = food.map((item) => shopItemHtml(item, noTrips)).join('');
  if (els.healthList) els.healthList.innerHTML = SHOP.filter((item) => item.id === 'medkit').map((item) => shopItemHtml(item, false)).join('');
}

function buyItem(id) {
  const item = SHOP.find((i) => i.id === id);
  if (!item) return;

  const bought = state.purchases[id] || 0;

  if (item.max && bought >= item.max) {
    toast('Больше не продаём — склад пуст', 'info');
    return;
  }

  if (state.money < item.price) {
    toast(`💸 Не хватает ${rub(item.price - state.money)}`, 'bad');
    haptic('error');
    return;
  }

  state.money -= item.price;
  state.purchases[id] = bought + 1;
  state.stats.buys = (state.stats.buys || 0) + 1;
  if (item.temporary) {
    // Расходники можно купить заранее и использовать позже из инвентаря.
    state.inventory[id] = (state.inventory[id] || 0) + 1;
  } else {
    if (state.energy >= state.maxEnergy) state.lastEnergyAt = Date.now();
    if (state.hp >= state.maxHp) state.lastHpAt = Date.now();
    item.apply();
  }

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

  toast(`${item.icon} ${item.name} — Куплено`, 'good');
  playSound('coin');
  haptic('success');
}

function renderResetConfirm(el) {
  el.innerHTML = `
    <div class="sheet-emoji">🔄</div>
    <h3 class="sheet-title">Начать службу заново?</h3>
    <p class="sheet-text">Весь прогресс, деньги и уровни будут сброшены${cloudReady ? ' также в аккаунте Telegram' : ' на этом устройстве'}. Как будто снова призыв.</p>
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

const MAP_TABS = new Set(['map', 'actions', 'shop', 'plaz', 'kpp', 'canteen', 'sickbay', 'staff']);

function setTab(tab) {
  if (tab === 'log' && !document.querySelector('[data-panel="log"]')?.classList.contains('is-active')) {
    renderLog(true);
    const scroll = $('#logScroll');
    if (scroll) scroll.scrollTop = 0;
  }
  if (tab === 'staff') {
    staffTab = 'leaderboard';
    renderStaffTab();
  }
  if (tab === 'admin') renderAdminPanel();
  $$('.panel').forEach((panel) => {
    panel.classList.toggle('is-active', panel.dataset.panel === tab);
  });
  $$('.nav-btn').forEach((btn) => {
    const active = btn.dataset.tab === tab || (btn.dataset.tab === 'map' && MAP_TABS.has(tab));
    btn.classList.toggle('is-active', active);
  });
  if (tab === 'inventory') renderInventory();

  if (window.matchMedia('(max-width: 719px)').matches) {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
}

/* ---------- game loop ---------- */

let lastCareKey = '';
let lastPackageState = '';
let lastMapBusyKey = '';
let gameTickTimer = 0;

function updateCareLive() {
  const pkg = packageState();
  if (lastPackageState === 'onway' && pkg === 'ready') {
    toast('📦 Посылка из дома прибыла', 'good');
    notifyPlayer('Посылка прибыла', 'Забери посылку на КПП.');
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
  renderKppCare();
}

function tick() {
  // В фоне телефон может замораживать таймеры и дорого перерисовывать DOM.
  // При возвращении visibilitychange вызывает tick() с актуальным временем.
  if (document.hidden) return;
  const now = Date.now();
  let changed = false;

  if (state.busy?.id && state.busy.until <= now) {
    const title = state.busy.title || 'Занятие';
    const icon = state.busy.icon || '✅';
    const reward = state.busy.reward;
    if (!reward) {
      state.busy = { id: null, title: '', icon: '', until: 0 };
      toast(`${icon} ${title} завершено`, 'good');
      renderAll();
      save();
      return;
    }
    const xpGain = Number(reward.xpGain) || 0;
    const moneyGain = Number(reward.moneyGain) || 0;
    const moraleGain = Number(reward.moraleGain) || 0;
    state.money += moneyGain;
    state.morale = clamp(state.morale + moraleGain, 0, 100);
    if (reward.duty) state.stats.duties += 1;
    state.stats.totalEarned += moneyGain;
    state.stats.actionsTotal = (state.stats.actionsTotal || 0) + 1;
    state.stats.hours = (state.stats.hours || 0) + (Number(reward.hours) || 0);
    state.stats.byAction = state.stats.byAction || {};
    state.stats.byAction[state.busy.id] = (state.stats.byAction[state.busy.id] || 0) + 1;
    addXp(xpGain);
    dailyAdd('hours', Number(reward.hours) || 0);
    dailyAdd('earn', moneyGain);
    if (state.busy.id === 'call') dailyAdd('call', 1);
    const gains = [`+${xpGain} XP`, `🕒 +${reward.hours || 0} игровых ч`];
    if (moneyGain > 0) gains.push(`+${fmt(moneyGain)} ₽`);
    if (moraleGain) gains.push(`${moraleGain > 0 ? '+' : ''}${moraleGain} 🔥`);
    state.busy = { id: null, title: '', icon: '', until: 0 };
    pushLog({
      icon,
      text: reward.flavor || `${title}: действие выполнено.`,
      gains,
      type: moraleGain < 0 ? 'bad' : 'good'
    });
    if (Math.random() < EVENT_CHANCE) {
      const event = triggerEvent();
      openModal((el) => renderEventSheet(el, event));
    }
    checkAchievements();
    renderAll();
    toast(`${icon} ${title} выполнено · награда получена`, 'good');
    notifyPlayer('Занятие завершено', `${title}: можно выбрать следующее занятие.`);
    playSound('success');
    changed = true;
  }

  if (state.sideBusy?.id && state.sideBusy.until <= now) {
    finishSideAction();
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
  updateDutyStatuses();
  renderStatusLine();
  updateEnergyPopover();
  if ($('[data-panel="actions"]')?.classList.contains('is-active')) renderCurrentDuty();
  updateCareLive();
  checkDailyReset();
  // Карта не меняется каждую секунду: не заставляем мобильный браузер
  // заново пересчитывать её стеклянные узлы без изменения состояния.
  const mapBusyKey = state.busy?.id ? `${state.busy.id}:${state.busy.until}` : '';
  if (mapBusyKey !== lastMapBusyKey) {
    lastMapBusyKey = mapBusyKey;
    renderMap();
  }
  if (pruneLog(now)) { renderLog(); save(); }

}

function scheduleGameTick() {
  clearTimeout(gameTickTimer);
  if (document.hidden) return;
  const active = Boolean(state.busy?.id) || Boolean(state.sideBusy?.id);
  const actionsOpen = $('[data-panel="actions"]')?.classList.contains('is-active');
  gameTickTimer = window.setTimeout(() => {
    tick();
    scheduleGameTick();
  }, active || actionsOpen ? 1000 : 5000);
}

/* ---------- boot ---------- */

function initTelegram() {
  if (!tg) return;
  try {
    tg.ready();
    tg.expand();
    if (tg.setHeaderColor) tg.setHeaderColor('#0a0c12');
    if (tg.setBackgroundColor) tg.setBackgroundColor('#0a0c12');
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
  $('#activityTop')?.addEventListener('click', () => { setTab('actions'); haptic(); });
  $('#clearArchiveBtn')?.addEventListener('click', () => openModal((el) => {
    const count = readLogArchive().length;
    el.innerHTML = `<h3 class="sheet-title">Очистить старые события?</h3><p class="sheet-text">Будет удалён только локальный архив событий старше 24 часов: ${count} записей. Прогресс и недавние события сохранятся.</p><div class="sheet-actions"><button class="btn btn-ghost" data-close>Отмена</button><button class="btn btn-danger" id="confirmClearArchive">Очистить</button></div>`;
    $('#confirmClearArchive', el).addEventListener('click', () => {
      try {
        if (!archiveOldEvents(state.log)) throw new Error('archive unavailable');
        localStorage.removeItem(LOG_ARCHIVE_KEY);
        state.log = state.log.filter((entry) => Number(entry.t) >= Date.now() - LOG_RETENTION_MS);
        save(); renderLog(); closeModal(); toast('🧹 Старые события удалены', 'good');
      } catch { toast('Не удалось очистить локальный архив', 'bad'); }
    });
  }));
  $('#logMore')?.addEventListener('click', () => {
    logHoursShown = Math.min(24, logHoursShown + 1);
    renderLog();
  });
  $$('[data-theme-choice]').forEach((button) => button.addEventListener('click', () => {
    state.settings.theme = button.dataset.themeChoice === 'light' ? 'light' : 'dark';
    renderSettings();
    save();
  }));
  $$('[data-back]').forEach((button) => { button.textContent = '← Гарнизон'; });
  const energyButton = $('#energyDetailsBtn');
  const energyPopover = $('#energyPopover');
  energyButton?.addEventListener('click', (event) => {
    event.stopPropagation();
    energyPopover.hidden = !energyPopover.hidden;
    energyButton.setAttribute('aria-expanded', String(!energyPopover.hidden));
    updateEnergyPopover();
  });
  document.addEventListener('click', (event) => {
    if (!energyPopover || event.target.closest('#energyDetailsBtn')) return;
    energyPopover.hidden = true;
    energyButton?.setAttribute('aria-expanded', 'false');
  });
  $('#healthDetailsBtn')?.addEventListener('click', () => openModal((el) => renderRecoverySheet(el, 'health')));
  $('#rankBadge')?.addEventListener('click', () => openModal(renderLevelsSheet));
  $('#claimLoginReward')?.addEventListener('click', claimLoginReward);
  $('#inventoryList')?.addEventListener('click', (event) => {
    const button = event.target.closest('[data-use-item]');
    if (button) useInventoryItem(button.dataset.useItem);
  });
  $('#inventoryTabs')?.addEventListener('click', (event) => {
    const button = event.target.closest('[data-inventory-tab]');
    if (!button) return;
    inventoryTab = button.dataset.inventoryTab;
    inventoryFilters.clear();
    renderInventory();
  });
  $('#inventoryFilters')?.addEventListener('click', (event) => {
    const button = event.target.closest('[data-inventory-filter]');
    if (!button) return;
    const category = button.dataset.inventoryFilter;
    if (inventoryFilters.has(category)) inventoryFilters.delete(category);
    else inventoryFilters.add(category);
    renderInventory();
  });
  $('#locationFilters')?.addEventListener('click', (event) => {
    const button = event.target.closest('[data-location-filter]');
    if (!button) return;
    locationFilter = locationFilter === button.dataset.locationFilter ? null : button.dataset.locationFilter;
    renderDutyPicker();
    renderActions();
  });
  if (els.profileTop) els.profileTop.addEventListener('click', () => setTab('hero'));
  if (els.editNameBtn) els.editNameBtn.addEventListener('click', () => openModal((el) => renderProfileSheet(el, { focusName: true })));
  if (els.avatarBtn) els.avatarBtn.addEventListener('click', () => { haptic(); playSound('click'); openModal((el) => renderProfileSheet(el, { focusName: false })); });
  if (els.avatarInput) els.avatarInput.addEventListener('change', () => {
    const file = els.avatarInput.files?.[0];
    els.avatarInput.value = '';
    if (file) applyAvatarFile(file);
  });
  const actionHost = $('.layout');
  if (actionHost) {
    actionHost.addEventListener('click', (e) => {
      const side = e.target.closest('[data-side-action]');
      if (side) {
        doSideAction(side.dataset.sideAction);
        return;
      }
      const card = e.target.closest('[data-action]');
      if (!card) return;
      if (card.dataset.dutyType) state.duty = { date: gameDayKey(), type: card.dataset.dutyType };
      doAction(card.dataset.action);
    });
  }

  $$('.nav-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      setTab(btn.dataset.tab);
      haptic();
      playSound('click');
    });
  });

  if (els.mapStage) {
    els.mapStage.addEventListener('click', (e) => {
      const node = e.target.closest('[data-building]');
      if (!node) return;
      haptic();
      playSound('click');
      setTab(node.dataset.building);
    });
  }

  $$('[data-back]').forEach((btn) => {
    btn.addEventListener('click', () => {
      haptic();
      playSound('click');
      setTab('map');
    });
  });

  const mapTutorialBtn = $('#mapTutorialBtn');
  if (mapTutorialBtn) mapTutorialBtn.addEventListener('click', () => showTutorial(true));

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

  if (els.canteenMenu) {
    els.canteenMenu.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-buy]');
      if (btn) buyItem(btn.dataset.buy);
    });
  }

  [els.careList, els.kppCareList].filter(Boolean).forEach((list) => {
    list.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-care]');
      if (!btn) return;
      const action = btn.dataset.care;
      if (action === 'sendPackage') sendPackage();
      else if (action === 'claimPackage') claimPackage();
      else if (action === 'useSickbay') useSickbay();
      else if (action === 'takeLeave') takeLeave();
      else if (action === 'visit') visit();
    });
  });
  if (els.healthList) els.healthList.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-buy]');
    if (btn) buyItem(btn.dataset.buy);
  });

  if (els.questBody) {
    els.questBody.addEventListener('click', (e) => {
      if (e.target.closest('[data-claim-quest]')) claimQuest();
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
  const adminBtn = $('#adminBtn');
  if (adminBtn) adminBtn.addEventListener('click', () => { if (isAdmin && cloudReady) setTab('admin'); });
  $('#adminLocalBtn')?.addEventListener('click', () => {
    if (['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)) setTab('admin');
  });
  $('#tutorialSkip').addEventListener('click', closeTutorial);

  const leaderboardBtn = $('#leaderboardBtn');
  if (leaderboardBtn) {
    leaderboardBtn.addEventListener('click', async () => {
      haptic();
      staffTab = 'leaderboard';
      renderStaffTab();
      if (tg?.initData && cloudReady) {
        await refreshLeaderboard(true);
        renderStaffTab();
      }
    });
  }

  const achievementsBtn = $('#achievementsBtn');
  if (achievementsBtn) {
    achievementsBtn.addEventListener('click', () => {
      haptic();
      staffTab = 'achievements';
      renderStaffTab();
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
      scheduleGameTick();
    }
  });
  window.addEventListener('pageshow', () => {
    tick();
    renderStatusLine();
    scheduleGameTick();
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
  updateAdminTab();
  tick();
  checkAchievements(true);
  setTab('map');
  save();
  ensureAvatarMini();


  scheduleGameTick();
  window.setInterval(() => { if (!document.hidden) refreshCloud(); }, 15000);
  window.setInterval(() => { if (!document.hidden && cloudReady) refreshLeaderboard(); }, 60000);
  window.setInterval(() => {
    if (document.hidden) return;
    if ($('[data-panel="hero"]')?.classList.contains('is-active')) updateHpHint();
  }, 1000);
  if (!state.nameChosen) openModal((el) => renderProfileSheet(el, { required: true, focusName: true }));
  else showTutorial();
}

boot();
