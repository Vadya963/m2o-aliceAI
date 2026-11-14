// ============================================================
//  Mafia II Online — Инвентарь · Клиент · v1.0.0
//  Открывается на I. Вью существует всегда, панель прячется сама
// ============================================================

const RESOURCE_NAME = "mafia-auth";

let invViewId = -1;
let invOpen = false;

function pass(id, payload) {
  if (invViewId < 0) return;
  Web.emit(invViewId, id, typeof payload === "string" ? payload : JSON.stringify(payload));
}

function openInv() {
  if (invViewId < 0) return;
  invOpen = true;
  pass("inv:show", {});
  Web.focusView(invViewId, true); // фокус — чтобы работала мышь по слотам и кнопкам
}

function closeInv() {
  if (invViewId < 0) return;
  invOpen = false;
  pass("inv:hide", {});
  Web.focusView(invViewId, false);
}

function toggleInv() {
  if (invOpen) { closeInv(); return; }
  Events.emitServer("inv:open", JSON.stringify({})); // сервер пришлёт свежий state
  openInv();
}

Events.on("resourceStart", (name) => {
  if (name !== RESOURCE_NAME) return;

  const s = Web.getScreenSize();
  const width  = (s && (s.width ?? s.x)) || 1920;
  const height = (s && (s.height ?? s.y)) || 1080;

  invViewId = Web.createView(
    `fw://resources/${RESOURCE_NAME}/client/ui/inventory.html`,
    { width, height, x: 0, y: 0, zIndex: 85, visible: true, focus: false }
  );

  Events.on("inv:state", (raw) => pass("inv:state", raw));
  Events.on("inv:bar",   (raw) => pass("inv:bar", raw));
  Events.on("inv:time",  (raw) => pass("inv:time", raw));

  Web.on(invViewId, "inv:action", (payload) => Events.emitServer("inv:action", payload));
  Web.on(invViewId, "inv:close", closeInv);

  Key.bind("i", "down", toggleInv);
});

Events.on("resourceStop", (name) => {
  if (name !== RESOURCE_NAME) return;
  closeInv();
  if (invViewId >= 0) { try { Web.destroyView(invViewId); } catch (e) {} }
  invViewId = -1;
});
