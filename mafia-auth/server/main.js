// ============================================================
//  Mafia II Online — авторизация, чат, неймтег, в xml ротация и спавн
//  Ресурс: mafia-auth · Сервер (Node.js) · v1.1.5
// ============================================================

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const RESOURCE_NAME = "mafia-auth";
const ACCOUNTS_DIR = path.join(process.cwd(), "resources", RESOURCE_NAME, "accounts");

const authenticated = new Map(); // steamId -> логин
const steamIndex   = new Map();  // steamId -> логин (для автозаполнения)
const lastAttempt  = new Map();  // анти-спам: steamId -> timestamp
const ATTEMPT_COOLDOWN = 1000;

// ---------- XML ----------

function escapeXml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function tag(name, value) {
  return `    <${name}>${escapeXml(value)}</${name}>\n`;
}

function stamp(date = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${p(date.getDate())}.${p(date.getMonth() + 1)}.${date.getFullYear()} ${p(date.getHours())}:${p(date.getMinutes())}`;
}

function accountPath(login) {
  const safe = login.toLowerCase().replace(/[^a-z0-9_]/g, "_");
  return path.join(ACCOUNTS_DIR, `${safe}.xml`);
}

function hashPassword(password, salt) {
  return crypto.createHash("sha256").update(`${salt}:${password}`).digest("hex");
}

function saveAccountXML({ name, email, steamId, salt, passwordHash }) {
  const xml =
    '<?xml version="1.0" encoding="utf-8"?>\n' +
    "<account>\n" +
    tag("name", name) +
    tag("email", email) +
    tag("steamId", steamId) +
    tag("salt", salt) +
    tag("password", passwordHash) +
    tag("created", stamp()) +
    tag("lastlogin", stamp()) +
    "</account>\n";
  fs.writeFileSync(accountPath(name), xml, "utf8");
}

function loadAccountXML(login) {
  let xml;
  try {
    xml = fs.readFileSync(accountPath(login), "utf8");
  } catch (e) {
    return null;
  }
  const get = (t) => {
    const m = xml.match(new RegExp(`<${t}>([\\s\\S]*?)</${t}>`));
    return m ? m[1].trim() : null;
  };
  const passwordHash = get("password");
  if (!passwordHash) return null;
  return {
    name: get("name") || login,
    email: get("email") || "",
    salt: get("salt") || "",
    passwordHash,
  };
}

function touchLastLogin(login) {
  try {
    const file = accountPath(login);
    const xml = fs.readFileSync(file, "utf8");
    fs.writeFileSync(
      file,
      xml.replace(/<lastlogin>[\s\S]*?<\/lastlogin>/, `<lastlogin>${stamp()}</lastlogin>`),
      "utf8"
    );
  } catch (e) { /* не критично */ }
}

function buildIndex() {
  let files = [];
  try { files = fs.readdirSync(ACCOUNTS_DIR); } catch (e) { return; }
  for (const f of files) {
    if (!f.endsWith(".xml")) continue;
    try {
      const xml = fs.readFileSync(path.join(ACCOUNTS_DIR, f), "utf8");
      const steamId = (xml.match(/<steamId>([\s\S]*?)<\/steamId>/) || [])[1];
      const name = (xml.match(/<name>([\s\S]*?)<\/name>/) || [])[1];
      if (steamId && name) steamIndex.set(steamId.trim(), name.trim());
    } catch (e) { /* пропускаем битые файлы */ }
  }
}

// ---------- валидация ----------

const LOGIN_RE = /^[A-Za-z0-9_]{3,20}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

const validateLogin = (login) =>
  LOGIN_RE.test(login) ? null : "Логин: 3–20 символов, латиница, цифры и _";

const validateEmail = (email) =>
  EMAIL_RE.test(email) ? null : "Введите корректный e-mail";

const validatePassword = (password, repeat) => {
  if (typeof password !== "string" || password.length < 6) return "Пароль — минимум 6 символов";
  if (password !== repeat) return "Пароли не совпадают";
  return null;
};

// ---------- мост: нормализация payload ----------

function asPayload(raw) {
  if (typeof raw === "string") {
    try { return JSON.parse(raw); } catch (e) { return { text: raw }; }
  }
  if (raw && typeof raw === "object") return raw;
  return null;
}

// ---------- чат ----------

Chat.setDefaultRelay(false); // нативный relay выключен — рассылаем сами

function loginOf(player) {
  return authenticated.get(player.steamId) || null;
}

function broadcastLine(kind, name, text, extra = {}) {
  Events.emitAllClients("chat:line", JSON.stringify({ kind, name, text, ...extra }));
}

function sendNotice(player, text) {
  player.emit("chat:notice", JSON.stringify({ text }));
}

function handleChat(player, payload) {
  const data = asPayload(payload);
  if (!data) return;

  const text = String(data.text || "").trim();
  if (!text) return;
  if (text.length > 128) text = text.slice(0, 128);

  // команды
  if (text.startsWith("/")) {
    const parts = text.slice(1).split(/\s+/);
    const cmd = (parts[0] || "").toLowerCase();
    const rest = text.slice(1 + cmd.length).trim();

    if (cmd === "help") {
      sendNotice(player, "Команды: /me <действие>; /pm <логин> <текст>; /help; /give <предмет>");
      return;
    }

    if (cmd === "me") {
      if (!loginOf(player)) return sendNotice(player, "Сначала авторизуйтесь.");
      if (!rest) return sendNotice(player, "Использование: /me <действие>");
      broadcastLine("me", loginOf(player), rest);
      return;
    }

    if (cmd === "pm") {
      if (!loginOf(player)) return sendNotice(player, "Сначала авторизуйтесь.");
      const [target, ...msgParts] = rest.split(/\s+/);
      const msg = msgParts.join(" ").trim();
      if (!target || !msg) return sendNotice(player, "Использование: /pm <логин> <текст>");

      let sent = false;
      for (const other of World.players) {
        if (loginOf(other) === target.toLowerCase()) {
          other.emit("chat:line", JSON.stringify({ kind: "pm", name: loginOf(player), text: msg, to: true }));
          sent = true;
        }
      }
      sendNotice(player, sent ? "Личное сообщение доставлено." : `Игрок «${target}» не найден.`);
      if (sent) console.log(`[chat] pm: ${loginOf(player)} -> ${target}`);
      return;
    }

    if (cmd === "give") {
      if (!loginOf(player)) return sendNotice(player, "Сначала авторизуйтесь.");
      const [item, cnt] = rest.split(/\s+/);
      const inv = invStates.get(player.steamId);
      if (!inv) return sendNotice(player, "Инвентарь не загружен.");
      if (!ITEMS[item]) {
        return sendNotice(player, `Нет предмета «${item}». Есть: ${Object.keys(ITEMS).join(", ")}`);
      }
      const n = Math.max(1, parseInt(cnt || "1", 10) || 1);
      const placed = addItem(inv, item, n);
      saveInventoryXML(loginOf(player), inv);
      sendState(player);
      sendNotice(player, placed ? `Получено: ${ITEMS[item].name} ×${n}` : "Инвентарь полон.");
      return;
    }

    sendNotice(player, "Неизвестная команда. /help — список команд.");
    return;
  }

  // обычное сообщение
  if (!loginOf(player)) {
    return sendNotice(player, "Писать в чат могут только авторизованные игроки.");
  }

  broadcastLine("say", loginOf(player), text);
  console.log(`[chat] ${loginOf(player)}: ${text}`);
}

// ---------- события ----------

Events.on("resourceStart", (name) => {
  if (name !== RESOURCE_NAME) return;
  try { fs.mkdirSync(ACCOUNTS_DIR, { recursive: true }); } catch (e) { /* уже есть */ }
  buildIndex();
  startInvTimers();
  console.log(`готово · аккаунтов в базе: ${steamIndex.size}`);
});

Events.on("resourceStop", (name) => {
  if (name !== RESOURCE_NAME) return;
  stopInvTimers();
  if (posSaveTimer >= 0) { clearInterval(posSaveTimer); posSaveTimer = -1; }
});

Events.on("playerConnect", (player) => {
  authenticated.delete(player.steamId);
  player.setNametagVisible(false); // до авторизации имени нет
  player.emit("auth:show", JSON.stringify({
    login: steamIndex.get(player.steamId) || "",
  }));
});

Events.on("playerDisconnect", (player) => {
  flushInventory(player);
  const pl = loginOf(player);
  if (pl) savePositionXML(pl, player);
  authenticated.delete(player.steamId);
  lastAttempt.delete(player.steamId);
});

Events.onClient("auth:action", (player, raw) => {
  if (authenticated.has(player.steamId)) return;

  let data = raw;
  if (typeof data === "string") {
    try { data = JSON.parse(data); } catch (e) { return; }
  }
  if (!data || typeof data !== "object") return;

  const now = Date.now();
  if (now - (lastAttempt.get(player.steamId) || 0) < ATTEMPT_COOLDOWN) return;
  lastAttempt.set(player.steamId, now);

  const reply = (ok, message) =>
    player.emit("auth:done", JSON.stringify({ ok, message }));

  const type = data.type === "register" ? "register" : "login";
  const login = String(data.login || "").trim();

  const loginError = validateLogin(login);
  if (loginError) return reply(false, loginError);

  if (type === "login") {
    const account = loadAccountXML(login);
    if (!account) return reply(false, `Аккаунт «${login}» не найден`);

    const hash = hashPassword(String(data.password || ""), account.salt);
    if (hash !== account.passwordHash) return reply(false, "Неверный пароль");

    authenticated.set(player.steamId, login);
    steamIndex.set(player.steamId, login);
    touchLastLogin(login);

    player.setNametagText(login);
    player.setNametagVisible(true);
    initInventory(player);
    restorePosition(player);

    broadcastLine("system", "", `${login} вошёл в Empire Bay.`);
    console.log(`вход: ${login}`);
    return reply(true, `Добро пожаловать, ${login}!`);
  }

  // --- регистрация ---
  const email = String(data.email || "").trim();
  const emailError = validateEmail(email);
  if (emailError) return reply(false, emailError);

  const passError = validatePassword(data.password, data.passwordRepeat);
  if (passError) return reply(false, passError);

  if (loadAccountXML(login)) return reply(false, `Логин «${login}» уже занят`);

  const salt = crypto.randomBytes(16).toString("hex");
  const passwordHash = hashPassword(String(data.password), salt);

  try {
    saveAccountXML({ name: login, email, steamId: player.steamId, salt, passwordHash });
  } catch (e) {
    console.error(`ошибка записи XML: ${e}`);
    return reply(false, "Ошибка сохранения аккаунта");
  }

  authenticated.set(player.steamId, login);
  steamIndex.set(player.steamId, login);

  player.setNametagText(login);
  player.setNametagVisible(true);
  initInventory(player);
  restorePosition(player);

  broadcastLine("system", "", `${login} вошёл в Empire Bay.`);
  console.log(`регистрация: ${login} (${email})`);
  return reply(true, `Аккаунт «${login}» создан. Welcome to Empire Bay!`);
});

// строки из нативного ввода (Enter в игре)
Events.on("playerChat", (player, text) => {
  handleChat(player, { text });
});

// строки из нашего веб-чата (T)
// payload может прийти и строкой, и объектом — asPayload() всё нормализует
Events.onClient("chat:input", (player, raw) => {
  handleChat(player, raw);
});

// ============================================================
//  Инвентарь (48 слотов) · сытость · жажда · сохранение в XML
// ============================================================

const INVENTORY_SLOTS = 48;
const HUNGER_PER_MIN  = 1;    // шкалы 0..100, полная деградация ~100 минут
const THIRST_PER_MIN  = 1.4;  // жажда уходит быстрее
const INV_SAVE_MS     = 5 * 60 * 1000; // автосохранение раз в 5 минут

const ITEMS = {
  cola:   { name: "Кола",    stack: 8, desc: "Газировка. Утоляет жажду.",   drink: 35, food: 0,  health: 0  },
  hotdog: { name: "Хот-дог", stack: 8, desc: "Уличная еда Empire Bay.",     drink: 5,  food: 40, health: 0  },
  medkit: { name: "Аптечка", stack: 4, desc: "Первая помощь.",              drink: 0,  food: 0,  health: 50 },
  watch:  { name: "Часы",    stack: 1, desc: "Показывают время сервера.",   watch: true },
};

const invStates = new Map(); // steamId -> { slots, hunger, thirst, dirty }
let invTickTimer = -1;
let invSaveTimer = -1;

function emptyInventory() {
  const slots = new Array(INVENTORY_SLOTS).fill(null);
  slots[0] = { id: "watch",  count: 1 };
  slots[1] = { id: "cola",   count: 2 };
  slots[2] = { id: "hotdog", count: 1 };
  slots[3] = { id: "medkit", count: 1 };
  return { slots, hunger: 100, thirst: 100, dirty: true };
}

// ---------- инвентарь в XML аккаунта ----------

function saveInventoryXML(login, inv) {
  try {
    const file = accountPath(login);
    let xml;
    try { xml = fs.readFileSync(file, "utf8"); } catch (e) { return; }
    let rows = `      <hunger>${Math.round(inv.hunger)}</hunger>\n`;
    rows    += `      <thirst>${Math.round(inv.thirst)}</thirst>\n`;
    inv.slots.forEach((it, i) => {
      if (it) rows += `      <item slot="${i}" id="${it.id}" count="${it.count}"/>\n`;
    });
    const block = `<inventory>\n${rows}  </inventory>`;
    if (/<inventory>[\s\S]*?<\/inventory>/.test(xml)) {
      xml = xml.replace(/<inventory>[\s\S]*?<\/inventory>/, block);
    } else {
      xml = xml.replace(/<\/account>/, block + "\n</account>");
    }
    fs.writeFileSync(file, xml, "utf8");
  } catch (e) {
    console.error(`[inventory] ошибка сохранения «${login}»: ${e}`);
  }
}

function loadInventoryXML(login) {
  let xml;
  try { xml = fs.readFileSync(accountPath(login), "utf8"); } catch (e) { return null; }
  const block = (xml.match(/<inventory>([\s\S]*?)<\/inventory>/) || [])[1];
  if (!block) return null;
  const inv = emptyInventory();
  inv.slots.fill(null);
  inv.dirty = false;
  const hunger = (block.match(/<hunger>([\s\S]*?)<\/hunger>/) || [])[1];
  const thirst = (block.match(/<thirst>([\s\S]*?)<\/thirst>/) || [])[1];
  if (hunger != null) inv.hunger = Math.min(100, Math.max(0, parseFloat(hunger) || 0));
  if (thirst != null) inv.thirst = Math.min(100, Math.max(0, parseFloat(thirst) || 0));
  const re = /<item\s+slot="(\d+)"\s+id="([^"]+)"\s+count="(\d+)"\s*\/>/g;
  let m;
  while ((m = re.exec(block))) {
    const slot = Number(m[1]), id = m[2], count = Number(m[3]);
    if (slot >= 0 && slot < INVENTORY_SLOTS && ITEMS[id] && count > 0) {
      inv.slots[slot] = { id, count: Math.min(count, ITEMS[id].stack) };
    }
  }
  return inv;
}

// ---------- состояние в памяти ----------

function initInventory(player) {
  if (!loginOf(player) || invStates.has(player.steamId)) return;
  invStates.set(player.steamId, loadInventoryXML(loginOf(player)) || emptyInventory());
  saveInventoryXML(loginOf(player), invStates.get(player.steamId));
  sendState(player);
}

function flushInventory(player) {
  if (!invStates.has(player.steamId)) return;
  const login = loginOf(player);
  if (login) saveInventoryXML(login, invStates.get(player.steamId));
  invStates.delete(player.steamId);
}

function sendState(player) {
  const inv = invStates.get(player.steamId);
  if (!inv) return;
  player.emit("inv:state", JSON.stringify({
    slots: inv.slots,
    hunger: Math.round(inv.hunger),
    thirst: Math.round(inv.thirst),
    items: ITEMS,
  }));
}

function sendBars(player) {
  const inv = invStates.get(player.steamId);
  if (!inv) return;
  player.emit("inv:bar", JSON.stringify({
    hunger: Math.round(inv.hunger),
    thirst: Math.round(inv.thirst),
  }));
}

function addItem(inv, id, count = 1) {
  const meta = ITEMS[id];
  if (!meta) return false;
  let left = count;
  for (const slot of inv.slots) { // докидываем в неполные стеки
    if (slot && slot.id === id && slot.count < meta.stack) {
      const take = Math.min(meta.stack - slot.count, left);
      slot.count += take;
      left -= take;
      if (!left) return true;
    }
  }
  for (let i = 0; i < inv.slots.length; i++) { // раскладываем по пустым слотам
    if (!inv.slots[i]) {
      const take = Math.min(meta.stack, left);
      inv.slots[i] = { id, count: take };
      left -= take;
      if (!left) return true;
    }
  }
  return left === 0;
}

// ---------- использование / выброс / удаление ----------

function useItem(player, inv, slot) {
  const it = inv.slots[slot];
  if (!it) return;
  const meta = ITEMS[it.id];

  if (meta.watch) { // часы — многоразовые, не тратятся
    const time = stamp();
    player.emit("inv:time", JSON.stringify({ text: time }));
    sendNotice(player, `Часы показывают ${time}`);
    return;
  }

  if (meta.food)  inv.hunger = Math.min(100, inv.hunger + meta.food);
  if (meta.drink) inv.thirst = Math.min(100, inv.thirst + meta.drink);

  if (meta.health) {
    let healed = false;
    try {
      player.setHealth(player.getHealth() + meta.health);
      healed = true;
    } catch (e) { /* в этой сборке API здоровья недоступно */ }
    sendNotice(player, healed ? "Вы использовали аптечку. Здоровье восстановлено." : "Вы использовали аптечку.");
  } else {
    sendNotice(player, `Вы использовали: ${meta.name}`);
  }

  it.count--;
  if (it.count <= 0) inv.slots[slot] = null;
}

Events.onClient("inv:open", (player) => {
  if (!loginOf(player)) return;
  if (!invStates.has(player.steamId)) initInventory(player);
  sendState(player);
});

Events.onClient("inv:action", (player, raw) => {
  const data = asPayload(raw);
  if (!data) return;
  const login = loginOf(player);
  if (!login) return sendNotice(player, "Сначала авторизуйтесь.");
  const inv = invStates.get(player.steamId);
  if (!inv) return;

  const slot = Math.floor(Number(data.slot));
  if (!(slot >= 0 && slot < INVENTORY_SLOTS)) return;
  const it = inv.slots[slot];
  if (!it) return;
  const meta = ITEMS[it.id];

  if (data.action === "use") {
    useItem(player, inv, slot);
  } else if (data.action === "drop") {
    inv.slots[slot] = null;
    // здесь можно будет создать пикап на земле — API подставим позже
    sendNotice(player, `Вы выбросили: ${meta.name}`);
  } else if (data.action === "delete") {
    inv.slots[slot] = null;
    sendNotice(player, `Удалено навсегда: ${meta.name}`);
  } else {
    return;
  }

  inv.dirty = true;
  saveInventoryXML(login, inv);
  sendState(player);
});

// ---------- тик голода/жажды и автосохранение ----------

function startInvTimers() {
  if (invTickTimer < 0) {
    invTickTimer = setInterval(() => {
      for (const inv of invStates.values()) {
        inv.hunger = Math.max(0, inv.hunger - HUNGER_PER_MIN);
        inv.thirst = Math.max(0, inv.thirst - THIRST_PER_MIN);
        inv.dirty = true;
      }
      World.players.forEach(sendBars); // каждое значение пересылать не хочется — шлём раз в минуту
    }, 60 * 1000);
  }

  if (invSaveTimer < 0) {
    invSaveTimer = setInterval(() => {
      for (const [steamId, inv] of invStates) {
        if (!inv.dirty) continue;
        const login = steamIndex.get(steamId);
        if (login) saveInventoryXML(login, inv);
        inv.dirty = false;
      }
    }, INV_SAVE_MS);
  }

  if (posSaveTimer < 0) {
    posSaveTimer = setInterval(() => {
      World.players.forEach((p) => {
        const l = loginOf(p);
        if (l) savePositionXML(l, p);
      });
    }, POS_SAVE_MS);
  }
}

function stopInvTimers() {
  if (invTickTimer >= 0) { clearInterval(invTickTimer); invTickTimer = -1; }
  if (invSaveTimer >= 0) { clearInterval(invSaveTimer); invSaveTimer = -1; }
}

// ============================================================
//  Сохранение позиции в XML аккаунта
// ============================================================

const POS_SAVE_MS = 5 * 60 * 1000; // раз в 5 минут — вместе с инвентарём
let posSaveTimer = -1;

function savePositionXML(login, player) {
  try {
    const p = player.position;
    if (!p || ![p.x, p.y, p.z].every((v) => typeof v === "number" && isFinite(v))) return; // ещё не в мире

    const r = player.rotation;
    // чтение возвращает кватернион: x, y, z, w
    const q = (r && [r.x, r.y, r.z, r.w].every((v) => typeof v === "number" && isFinite(v)))
    ? r : { x: 0, y: 0, z: 0, w: 1 };

    const file = accountPath(login);
    let xml;
    try { xml = fs.readFileSync(file, "utf8"); } catch (e) { return; }

    const block =
      `<position>\n` +
      `    <x>${p.x.toFixed(2)}</x>\n` +
      `    <y>${p.y.toFixed(2)}</y>\n` +
      `    <z>${p.z.toFixed(2)}</z>\n` +
      `    <rot x="${q.x.toFixed(6)}" y="${q.y.toFixed(6)}" z="${q.z.toFixed(6)}" w="${q.w.toFixed(6)}"/>\n` +
      `  </position>`;

    if (/<position>[\s\S]*?<\/position>/.test(xml)) {
      xml = xml.replace(/<position>[\s\S]*?<\/position>/, block);
    } else {
      xml = xml.replace(/<\/account>/, block + "\n</account>");
    }
    fs.writeFileSync(file, xml, "utf8");
  } catch (e) {
    console.error(`[position] ошибка сохранения «${login}»: ${e}`);
  }
}

function loadPositionXML(login) {
  try {
    const xml = fs.readFileSync(accountPath(login), "utf8");
    const block = (xml.match(/<position>([\s\S]*?)<\/position>/) || [])[1];
    if (!block) return null;
    const num = (t) => {
      const m = block.match(new RegExp(`<${t}>([-\\d.eE+]+)<\\/${t}>`));
      return m ? parseFloat(m[1]) : null;
    };
    const x = num("x"), y = num("y"), z = num("z");
    if (![x, y, z].every((v) => typeof v === "number" && isFinite(v))) return null;
    const rotM = block.match(
      /<rot\s+x="([^"]+)"\s+y="([^"]+)"\s+z="([^"]+)"(?:\s+w="([^"]+)")?\s*\/>/
    );
    const rot = rotM
      ? {
          x: parseFloat(rotM[1]) || 0,
          y: parseFloat(rotM[2]) || 0,
          z: parseFloat(rotM[3]) || 0,
          w: rotM[4] != null ? parseFloat(rotM[4]) : 1, // старые записи без w — считаем идентичностью
        }
      : null;
    return { x, y, z, rot };
  } catch (e) {
    return null;
  }
}

function restorePosition(player) {
  const login = loginOf(player);
  if (!login) return;
  const pos = loadPositionXML(login);
  if (!pos) return; // первый вход — остаётся на стартовой точке

  try {
    player.position = new Vector3(pos.x, pos.y, pos.z);
  } catch (e) {
    try { player.spawn(pos.x, pos.y, pos.z); } catch (e2) {
      console.error(`[position] не удалось вернуть позицию ${login}: ${e2}`);
      return;
    }
  }

  if (pos.rot) {
    try {
      player.rotation = new Quaternion(pos.rot.w, pos.rot.x, pos.rot.y, pos.rot.z);
    } catch (e) {
      console.error(`[position] поворот «${login}» не принят: ${e}`);
    }
  }

  sendNotice(player, "Позиция восстановлена.");
}
