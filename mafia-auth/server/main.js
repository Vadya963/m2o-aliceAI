// ============================================================
//  Mafia II Online — авторизация, чат, неймтег
//  Ресурс: mafia-auth · Сервер (Node.js) · v1.1.2
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

const GOLD  = "#FFD700";
const CREAM = "#F5E6C8"; // кремовый текст — как у системных уведомлений
const DIM   = "#8D7B58";

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
      sendNotice(player, "Команды: /me <действие> · /pm <логин> <текст> · /help");
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
  console.log(`[mafia-auth] готово · аккаунтов в базе: ${steamIndex.size}`);
});

Events.on("playerConnect", (player) => {
  authenticated.delete(player.steamId);
  player.setNametagVisible(false); // до авторизации имени нет
  player.emit("auth:show", JSON.stringify({
    login: steamIndex.get(player.steamId) || "",
  }));
});

Events.on("playerDisconnect", (player) => {
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

    broadcastLine("system", "", `${login} вошёл в Empire Bay.`);
    console.log(`[mafia-auth] вход: ${login}`);
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
    console.error(`[mafia-auth] ошибка записи XML: ${e}`);
    return reply(false, "Ошибка сохранения аккаунта");
  }

  authenticated.set(player.steamId, login);
  steamIndex.set(player.steamId, login);

  player.setNametagText(login);
  player.setNametagVisible(true);

  broadcastLine("system", "", `${login} вошёл в Empire Bay.`);
  console.log(`[mafia-auth] регистрация: ${login} (${email})`);
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
