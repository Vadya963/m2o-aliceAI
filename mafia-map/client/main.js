// ============================================================
//  Mafia II Online — карта города
//  Ресурс: mafia-map · Клиент
//
//  Важно из документации:
//  - В скриптовых сессиях Tab/M сами карту НЕ открывают.
//  - У открытой карты нет встроенного закрытия: каждый open()
//    обязан иметь путь к close(), иначе игрок застрянет.
//  - isOpen() переворачивается только когда fade открытия
//    закончился, поэтому держим собственный флаг requestedOpen.
//  - Key.bind продолжает срабатывать, пока карта открыта.
// ============================================================

const RESOURCE_NAME = "mafia-map";

let requestedOpen = false;
let lastToggleAt = 0;
const TOGGLE_DEBOUNCE = 300; // мс: гасим дребезг во время fade

function toggleMap() {
  const now = Date.now();
  if (now - lastToggleAt < TOGGLE_DEBOUNCE) return; // гасим дребезг во время fade
  lastToggleAt = now;

  // Единственный источник истины — реальное состояние карты
  if (WorldMap.isOpen()) {
    WorldMap.close();
  } else {
    WorldMap.open();
  }
}

Events.on("resourceStart", (name) => {
  if (name !== RESOURCE_NAME) return;

  // Клавиша M — открыть/закрыть карту.
  // Срабатывает и пока карта открыта — это и есть путь закрытия.
  Key.bind("m", "down", toggleMap);
});

// Команда /map с сервера: игроку открыли карту дистанционно
Events.on("map:toggle", toggleMap);

// GPS-точка: сервер прислал координаты — открываем карту и ставим метку
Events.on("map:waypoint", (data) => {
  if (!data || !Number.isFinite(data.x) || !Number.isFinite(data.y)) return;
  requestedOpen = true;
  WorldMap.open();
  WorldMap.setWaypoint(data.x, data.y);
});

// Подстраховка: не оставлять карту открытой при выгрузке ресурса
Events.on("resourceStop", (name) => {
  if (name !== RESOURCE_NAME) return;
  if (WorldMap.isOpen()) WorldMap.close();
  requestedOpen = false;
});
