// ============================================================
//  Mafia II Online — Кастомный чат · Клиент
//  Ресурс: mafia-auth · Файл: client/chat.js (v1.2.0)
//  Лента видна всегда, по T открывается только ввод,
//  при простое лента сама затухает (логика в chat.html)
// ============================================================

const RESOURCE_NAME = "mafia-auth";

let chatViewId = -1;
let inputOpen = false;

function openInput() {
  if (chatViewId < 0) return;
  if (!inputOpen) {
    inputOpen = true;
    Web.emit(chatViewId, "chat:openInput");
  }
  Web.focusView(chatViewId, true); // фокус мог слететь — ставим всегда
}

function closeInput() {
  if (chatViewId < 0) return;
  inputOpen = false;
  Web.emit(chatViewId, "chat:closeInput");
  Web.focusView(chatViewId, false);
  // вью НЕ прячем — лента остаётся на экране (затухает сама)
}

Events.on("resourceStart", (name) => {
  if (name !== RESOURCE_NAME) return;

  const s = Web.getScreenSize();
  const width  = (s && (s.width ?? s.x)) || 1920;
  const height = (s && (s.height ?? s.y)) || 1080;

  // вью показан сразу: лента чата видна постоянно
  chatViewId = Web.createView(
    `fw://resources/${RESOURCE_NAME}/client/ui/chat.html`,
    { width, height, x: 0, y: 0, zIndex: 90, visible: true, focus: false }
  );

  // ввод из страницы -> на сервер (JSON-строкой, как ждёт сервер)
  Web.on(chatViewId, "chat:input", (payload) => {
    let data;
    try { data = typeof payload === "string" ? JSON.parse(payload) : payload; }
    catch (e) { data = null; }
    if (!data || !data.text) { closeInput(); return; } // пусто — просто закрыть ввод
    Events.emitServer("chat:input", JSON.stringify({ text: data.text }));
    closeInput();
  });

  // страница попросила закрыть (Enter на пустом поле или Esc)
  Web.on(chatViewId, "chat:close", closeInput);

  // T — открыть ввод
  Key.bind("enter", "down", openInput);

  // Esc — закрыть, если страница не поймала сама
  Key.bind("escape", "down", () => { if (inputOpen) closeInput(); });
});

// ---- входящие данные от сервера ----

Events.on("chat:line", (raw) => {
  if (chatViewId < 0) return;
  Web.emit(chatViewId, "chat:line", typeof raw === "string" ? raw : JSON.stringify(raw));
});

Events.on("chat:history", (raw) => {
  if (chatViewId < 0) return;
  Web.emit(chatViewId, "chat:history", typeof raw === "string" ? raw : JSON.stringify(raw));
});

Events.on("chat:notice", (raw) => {
  if (chatViewId < 0) return;
  Web.emit(chatViewId, "chat:notice", typeof raw === "string" ? raw : JSON.stringify(raw));
});

Events.on("resourceStop", (name) => {
  if (name !== RESOURCE_NAME) return;
  closeInput();
  if (chatViewId >= 0) { try { Web.destroyView(chatViewId); } catch (e) {} }
  chatViewId = -1;
});
