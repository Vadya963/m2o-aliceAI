// ============================================================
//  Mafia II Online — авторизация
//  Ресурс: mafia-auth · Клиент (V8)
// ============================================================

const RESOURCE_NAME = "mafia-auth";
let viewId = -1;

function toPayload(data) {
  return typeof data === "string" ? data : JSON.stringify(data);
}

Events.on("resourceStart", (name) => {
  if (name !== RESOURCE_NAME) return;

  const s = Web.getScreenSize();
  const width  = (s && (s.width ?? s.x)) || 1920;
  const height = (s && (s.height ?? s.y)) || 1080;

  viewId = Web.createView(`fw://resources/${RESOURCE_NAME}/client/ui/index.html`, {
    width, height, x: 0, y: 0, zIndex: 100, visible: false, focus: false,
  });

  Web.on(viewId, "ui:action", (payload) => Events.emitServer("auth:action", payload));
});

Events.on("auth:show", (raw) => {
  if (viewId < 0) return;
  Web.emit(viewId, "auth:show", raw);
  Web.showView(viewId);
  Web.focusView(viewId, true);
  Hud.setVisible(false);
});

Events.on("auth:done", (raw) => {
  if (viewId < 0) return;
  const data = typeof raw === "string" ? JSON.parse(raw) : raw;
  if (!data) return;

  if (data.ok) {
    Web.focusView(viewId, false);
    Web.hideView(viewId);
    Hud.setVisible(true);
    Hud.showMessage(data.message, 5);
  } else {
    Web.emit(viewId, "auth:result", raw);
  }
});

Events.on("resourceStop", (name) => {
  if (name !== RESOURCE_NAME) return;
  if (viewId >= 0) Web.destroyView(viewId);
  viewId = -1;
});
