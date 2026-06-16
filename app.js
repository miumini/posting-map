const DB_NAME = "posting-map-db";
const DB_VERSION = 1;
const STORE = "state";
const STATUS_LABELS = {
  unvisited: "未配布",
  done: "配布済み",
  nonresidential: "非住居",
  banned: "配布禁止",
};
const STATUS_COLORS = {
  unvisited: "#868e96",
  done: "#16835b",
  nonresidential: "#2274a5",
  banned: "#c24132",
};
const WORLD_WITH_JAPAN_FOCUS = [139.767, 35.681];

let db;
let map;
let selectedBuildingId = null;
let records = {};
let activeArea = null;
let drawing = false;
let draftPoints = [];
let longPressTimer = null;
let longPressPoint = null;
let toastTimer = null;

const els = {
  addressInput: document.getElementById("addressInput"),
  searchForm: document.getElementById("searchForm"),
  locateButton: document.getElementById("locateButton"),
  drawButton: document.getElementById("drawButton"),
  viewAreaButton: document.getElementById("viewAreaButton"),
  geojsonInput: document.getElementById("geojsonInput"),
  drawPanel: document.getElementById("drawPanel"),
  drawCount: document.getElementById("drawCount"),
  undoPointButton: document.getElementById("undoPointButton"),
  finishAreaButton: document.getElementById("finishAreaButton"),
  cancelDrawButton: document.getElementById("cancelDrawButton"),
  selectedLabel: document.getElementById("selectedLabel"),
  memoButton: document.getElementById("memoButton"),
  memoDialog: document.getElementById("memoDialog"),
  memoText: document.getElementById("memoText"),
  saveMemoButton: document.getElementById("saveMemoButton"),
  deleteBuildingButton: document.getElementById("deleteBuildingButton"),
  savedCount: document.getElementById("savedCount"),
  exportButton: document.getElementById("exportButton"),
  backupInput: document.getElementById("backupInput"),
  clearSelectionButton: document.getElementById("clearSelectionButton"),
  toast: document.getElementById("toast"),
};

init();

async function init() {
  db = await openDb();
  const saved = await loadState();
  records = saved.records || {};
  activeArea = saved.activeArea || null;
  setupMap();
  bindUi();
  registerServiceWorker();
}

function setupMap() {
  map = new maplibregl.Map({
    container: "map",
    center: savedCenter(),
    zoom: savedZoom(),
    minZoom: 4,
    maxZoom: 19,
    attributionControl: false,
    style: {
      version: 8,
      glyphs: "https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf",
      sources: {
        gsi_pale: {
          type: "raster",
          tiles: ["https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png"],
          tileSize: 256,
          attribution: "地理院タイル",
        },
        gsi_vector: {
          type: "vector",
          tiles: ["https://cyberjapandata.gsi.go.jp/xyz/experimental_bvmap/{z}/{x}/{y}.pbf"],
          minzoom: 4,
          maxzoom: 16,
          attribution: "国土地理院最適化ベクトルタイル",
        },
      },
      layers: [
        { id: "background", type: "background", paint: { "background-color": "#f7f5ef" } },
        { id: "gsi-pale", type: "raster", source: "gsi_pale", paint: { "raster-opacity": 0.92 } },
        {
          id: "building-base",
          type: "fill",
          source: "gsi_vector",
          "source-layer": "building",
          minzoom: 15,
          paint: {
            "fill-color": "#c8c1b2",
            "fill-opacity": 0.48,
          },
        },
        {
          id: "building-line",
          type: "line",
          source: "gsi_vector",
          "source-layer": "building",
          minzoom: 15,
          paint: {
            "line-color": "#8c8375",
            "line-opacity": 0.45,
            "line-width": 0.7,
          },
        },
      ],
    },
  });

  map.on("load", () => {
    addAppLayers();
    updateStatusLayer();
    updateAreaLayers();
    updateSavedCount();
    wireMapGestures();
    showToast("建物をタップすると状態を変更できます");
  });

  map.on("moveend", () => {
    const center = map.getCenter();
    localStorage.setItem("posting-map-center", JSON.stringify([center.lng, center.lat]));
    localStorage.setItem("posting-map-zoom", String(map.getZoom()));
  });
}

function addAppLayers() {
  map.addSource("selected-area", emptyGeoJsonSource());
  map.addSource("outside-mask", emptyGeoJsonSource());
  map.addSource("draft-area", emptyGeoJsonSource());
  map.addSource("status-buildings", emptyGeoJsonSource());

  map.addLayer({
    id: "status-building-fill",
    type: "fill",
    source: "status-buildings",
    paint: {
      "fill-color": ["get", "color"],
      "fill-opacity": 0.72,
    },
  });

  map.addLayer({
    id: "status-building-line",
    type: "line",
    source: "status-buildings",
    paint: {
      "line-color": "#ffffff",
      "line-width": 1.4,
      "line-opacity": 0.9,
    },
  });

  map.addLayer({
    id: "outside-mask-fill",
    type: "fill",
    source: "outside-mask",
    paint: {
      "fill-color": "#111827",
      "fill-opacity": 0.28,
    },
  });

  map.addLayer({
    id: "selected-area-fill",
    type: "fill",
    source: "selected-area",
    paint: {
      "fill-color": "#f5c84b",
      "fill-opacity": 0.11,
    },
  });

  map.addLayer({
    id: "selected-area-line",
    type: "line",
    source: "selected-area",
    paint: {
      "line-color": "#d09a00",
      "line-width": 3,
      "line-opacity": 0.95,
    },
  });

  map.addLayer({
    id: "draft-area-line",
    type: "line",
    source: "draft-area",
    paint: {
      "line-color": "#2457a7",
      "line-width": 3,
      "line-dasharray": [1.2, 1.2],
    },
  });
}

function bindUi() {
  els.searchForm.addEventListener("submit", searchAddress);
  els.locateButton.addEventListener("click", locateUser);
  els.drawButton.addEventListener("click", startDrawing);
  els.viewAreaButton.addEventListener("click", createAreaFromView);
  els.geojsonInput.addEventListener("change", importAreaGeoJson);
  els.undoPointButton.addEventListener("click", undoDraftPoint);
  els.finishAreaButton.addEventListener("click", finishDrawing);
  els.cancelDrawButton.addEventListener("click", cancelDrawing);
  els.memoButton.addEventListener("click", openMemo);
  els.saveMemoButton.addEventListener("click", saveMemo);
  els.deleteBuildingButton.addEventListener("click", deleteSelectedBuilding);
  els.exportButton.addEventListener("click", exportBackup);
  els.backupInput.addEventListener("change", importBackup);
  els.clearSelectionButton.addEventListener("click", clearSelection);

  document.querySelectorAll(".status-button").forEach((button) => {
    button.addEventListener("click", () => setSelectedStatus(button.dataset.status));
  });
}

function wireMapGestures() {
  map.on("click", (event) => {
    if (drawing) {
      addDraftPoint([event.lngLat.lng, event.lngLat.lat]);
      return;
    }
    selectBuildingAt(event.point);
  });

  map.getCanvas().addEventListener("touchstart", (event) => {
    if (event.touches.length !== 1 || drawing) return;
    const touch = event.touches[0];
    const rect = map.getCanvas().getBoundingClientRect();
    longPressPoint = [touch.clientX - rect.left, touch.clientY - rect.top];
    clearTimeout(longPressTimer);
    longPressTimer = setTimeout(() => {
      const selected = selectBuildingAt(longPressPoint, true);
      if (selected) openMemo();
    }, 650);
  }, { passive: true });

  ["touchmove", "touchend", "touchcancel"].forEach((name) => {
    map.getCanvas().addEventListener(name, () => clearTimeout(longPressTimer), { passive: true });
  });
}

async function searchAddress(event) {
  event.preventDefault();
  const query = els.addressInput.value.trim();
  if (!query) return;
  showToast("住所を検索中");
  try {
    const url = `https://msearch.gsi.go.jp/address-search/AddressSearch?q=${encodeURIComponent(query)}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error("search failed");
    const results = await res.json();
    if (!Array.isArray(results) || results.length === 0) {
      showToast("住所が見つかりませんでした");
      return;
    }
    const [lng, lat] = results[0].geometry.coordinates;
    map.flyTo({ center: [lng, lat], zoom: Math.max(map.getZoom(), 16.2), essential: true });
    showToast("中心へ移動しました。境界は範囲作成か境界読込で指定できます");
  } catch {
    showToast("住所検索に失敗しました");
  }
}

function locateUser() {
  if (!navigator.geolocation) {
    showToast("このブラウザでは現在地を取得できません");
    return;
  }
  navigator.geolocation.getCurrentPosition(
    (position) => {
      map.flyTo({
        center: [position.coords.longitude, position.coords.latitude],
        zoom: Math.max(map.getZoom(), 17),
        essential: true,
      });
      showToast("現在地へ移動しました");
    },
    () => showToast("位置情報を許可してください"),
    { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 },
  );
}

function selectBuildingAt(point, fromLongPress = false) {
  const features = map.queryRenderedFeatures(point, { layers: ["building-base", "status-building-fill"] });
  const feature = features.find((item) => item.geometry && ["Polygon", "MultiPolygon"].includes(item.geometry.type));
  if (!feature) {
    if (!fromLongPress) showToast("建物が見つかりません。ズームして建物をタップしてください");
    return false;
  }

  const geometry = cloneGeometry(feature.geometry);
  const id = existingRecordIdForGeometry(geometry) || hashGeometry(geometry);
  if (!records[id]) {
    records[id] = {
      id,
      status: "unvisited",
      memo: "",
      geometry,
      updatedAt: new Date().toISOString(),
    };
  }
  selectedBuildingId = id;
  refreshSelectionLabel();
  updateStatusLayer();
  persist();
  return true;
}

function setSelectedStatus(status) {
  const record = selectedRecord();
  if (!record) {
    showToast("先に建物をタップしてください");
    return;
  }
  record.status = status;
  record.updatedAt = new Date().toISOString();
  refreshSelectionLabel();
  updateStatusLayer();
  persist();
}

function openMemo() {
  const record = selectedRecord();
  if (!record) {
    showToast("先に建物を選択してください");
    return;
  }
  els.memoText.value = record.memo || "";
  if (typeof els.memoDialog.showModal === "function") {
    els.memoDialog.showModal();
  } else {
    const memo = prompt("メモ", record.memo || "");
    if (memo !== null) {
      record.memo = memo;
      record.updatedAt = new Date().toISOString();
      persist();
      showToast("メモを保存しました");
    }
  }
}

function saveMemo() {
  const record = selectedRecord();
  if (!record) return;
  record.memo = els.memoText.value.trim();
  record.updatedAt = new Date().toISOString();
  persist();
  els.memoDialog.close();
  showToast("メモを保存しました");
}

function deleteSelectedBuilding() {
  if (!selectedBuildingId) return;
  delete records[selectedBuildingId];
  selectedBuildingId = null;
  updateStatusLayer();
  refreshSelectionLabel();
  persist();
  els.memoDialog.close();
  showToast("選択した建物を削除しました");
}

function startDrawing() {
  drawing = true;
  draftPoints = [];
  els.drawPanel.classList.remove("hidden");
  updateDraftArea();
  showToast("地図をタップして範囲の角を追加してください");
}

function addDraftPoint(point) {
  draftPoints.push(point);
  updateDraftArea();
}

function undoDraftPoint() {
  draftPoints.pop();
  updateDraftArea();
}

function finishDrawing() {
  if (draftPoints.length < 3) {
    showToast("範囲には3点以上必要です");
    return;
  }
  const ring = closeRing(draftPoints);
  activeArea = {
    type: "Feature",
    properties: { name: "手動範囲", updatedAt: new Date().toISOString() },
    geometry: { type: "Polygon", coordinates: [ring] },
  };
  drawing = false;
  draftPoints = [];
  els.drawPanel.classList.add("hidden");
  updateDraftArea();
  updateAreaLayers();
  persist();
  showToast("配布範囲を設定しました");
}

function cancelDrawing() {
  drawing = false;
  draftPoints = [];
  els.drawPanel.classList.add("hidden");
  updateDraftArea();
}

function createAreaFromView() {
  const bounds = map.getBounds();
  const ring = [
    [bounds.getWest(), bounds.getSouth()],
    [bounds.getEast(), bounds.getSouth()],
    [bounds.getEast(), bounds.getNorth()],
    [bounds.getWest(), bounds.getNorth()],
    [bounds.getWest(), bounds.getSouth()],
  ];
  activeArea = {
    type: "Feature",
    properties: { name: "画面範囲", updatedAt: new Date().toISOString() },
    geometry: { type: "Polygon", coordinates: [ring] },
  };
  updateAreaLayers();
  persist();
  showToast("現在の画面を配布範囲にしました");
}

async function importAreaGeoJson(event) {
  const file = event.target.files[0];
  event.target.value = "";
  if (!file) return;
  try {
    const text = await file.text();
    const json = JSON.parse(text);
    const feature = firstPolygonFeature(json);
    if (!feature) {
      showToast("ポリゴンのGeoJSONを選んでください");
      return;
    }
    activeArea = feature;
    updateAreaLayers();
    fitFeature(feature);
    persist();
    showToast("境界を読み込みました");
  } catch {
    showToast("境界ファイルを読み込めませんでした");
  }
}

function updateAreaLayers() {
  if (!map || !map.getSource("selected-area")) return;
  const featureCollection = activeArea ? { type: "FeatureCollection", features: [activeArea] } : emptyFeatureCollection();
  map.getSource("selected-area").setData(featureCollection);
  map.getSource("outside-mask").setData(activeArea ? maskFeatureFor(activeArea) : emptyFeatureCollection());
}

function updateDraftArea() {
  els.drawCount.textContent = `${draftPoints.length}点`;
  if (!map || !map.getSource("draft-area")) return;
  if (draftPoints.length < 2) {
    map.getSource("draft-area").setData(emptyFeatureCollection());
    return;
  }
  map.getSource("draft-area").setData({
    type: "FeatureCollection",
    features: [{
      type: "Feature",
      properties: {},
      geometry: { type: "LineString", coordinates: draftPoints.length > 2 ? closeRing(draftPoints) : draftPoints },
    }],
  });
}

function updateStatusLayer() {
  if (!map || !map.getSource("status-buildings")) return;
  const features = Object.values(records).map((record) => ({
    type: "Feature",
    properties: {
      id: record.id,
      status: record.status,
      color: STATUS_COLORS[record.status] || STATUS_COLORS.unvisited,
      memo: record.memo || "",
    },
    geometry: record.geometry,
  }));
  map.getSource("status-buildings").setData({ type: "FeatureCollection", features });
  updateSavedCount();
}

function clearSelection() {
  selectedBuildingId = null;
  refreshSelectionLabel();
}

function refreshSelectionLabel() {
  const record = selectedRecord();
  els.selectedLabel.textContent = record ? STATUS_LABELS[record.status] : "建物をタップ";
}

function updateSavedCount() {
  const count = Object.keys(records).length;
  els.savedCount.textContent = `保存 ${count}件`;
}

async function exportBackup() {
  const payload = {
    version: 1,
    exportedAt: new Date().toISOString(),
    attribution: [
      "地理院タイル",
      "国土地理院最適化ベクトルタイル",
    ],
    note: "建物形状を含むバックアップを共有・公開する場合は、国土地理院コンテンツ利用規約に従い出典を明示してください。",
    records,
    activeArea,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `posting-map-backup-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

async function importBackup(event) {
  const file = event.target.files[0];
  event.target.value = "";
  if (!file) return;
  try {
    const json = JSON.parse(await file.text());
    if (!json.records || typeof json.records !== "object") throw new Error("invalid");
    records = json.records;
    activeArea = json.activeArea || activeArea;
    selectedBuildingId = null;
    updateStatusLayer();
    updateAreaLayers();
    refreshSelectionLabel();
    persist();
    showToast("バックアップを読み込みました");
  } catch {
    showToast("バックアップを読み込めませんでした");
  }
}

function selectedRecord() {
  return selectedBuildingId ? records[selectedBuildingId] : null;
}

function firstPolygonFeature(json) {
  if (json.type === "FeatureCollection") {
    return json.features.find((feature) => feature.geometry && ["Polygon", "MultiPolygon"].includes(feature.geometry.type));
  }
  if (json.type === "Feature" && json.geometry && ["Polygon", "MultiPolygon"].includes(json.geometry.type)) {
    return json;
  }
  if (["Polygon", "MultiPolygon"].includes(json.type)) {
    return { type: "Feature", properties: {}, geometry: json };
  }
  return null;
}

function maskFeatureFor(feature) {
  const rings = [];
  if (feature.geometry.type === "Polygon") {
    rings.push(feature.geometry.coordinates[0]);
  } else {
    for (const polygon of feature.geometry.coordinates) rings.push(polygon[0]);
  }

  return {
    type: "FeatureCollection",
    features: [{
      type: "Feature",
      properties: {},
      geometry: {
        type: "Polygon",
        coordinates: [
          [[-180, -85], [180, -85], [180, 85], [-180, 85], [-180, -85]],
          ...rings.map(closeRing),
        ],
      },
    }],
  };
}

function fitFeature(feature) {
  const coords = flattenCoordinates(feature.geometry.coordinates);
  if (!coords.length) return;
  const bounds = coords.reduce((box, coord) => box.extend(coord), new maplibregl.LngLatBounds(coords[0], coords[0]));
  map.fitBounds(bounds, { padding: 48, maxZoom: 17.2, duration: 600 });
}

function existingRecordIdForGeometry(geometry) {
  const nextHash = hashGeometry(geometry);
  return Object.values(records).find((record) => hashGeometry(record.geometry) === nextHash)?.id || null;
}

function hashGeometry(geometry) {
  const rounded = roundGeometry(geometry);
  return `b_${hashString(JSON.stringify(rounded))}`;
}

function hashString(value) {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function roundGeometry(geometry) {
  return {
    type: geometry.type,
    coordinates: mapCoordinates(geometry.coordinates, (coord) => [
      Number(coord[0].toFixed(6)),
      Number(coord[1].toFixed(6)),
    ]),
  };
}

function mapCoordinates(value, fn) {
  if (typeof value[0] === "number") return fn(value);
  return value.map((item) => mapCoordinates(item, fn));
}

function cloneGeometry(geometry) {
  return JSON.parse(JSON.stringify(geometry));
}

function flattenCoordinates(value, acc = []) {
  if (!Array.isArray(value)) return acc;
  if (typeof value[0] === "number") {
    acc.push(value);
    return acc;
  }
  value.forEach((item) => flattenCoordinates(item, acc));
  return acc;
}

function closeRing(points) {
  const ring = points.map((point) => [point[0], point[1]]);
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (!last || first[0] !== last[0] || first[1] !== last[1]) ring.push([first[0], first[1]]);
  return ring;
}

function emptyGeoJsonSource() {
  return { type: "geojson", data: emptyFeatureCollection() };
}

function emptyFeatureCollection() {
  return { type: "FeatureCollection", features: [] };
}

function showToast(message) {
  clearTimeout(toastTimer);
  els.toast.textContent = message;
  els.toast.classList.add("visible");
  toastTimer = setTimeout(() => els.toast.classList.remove("visible"), 2600);
}

function savedCenter() {
  try {
    return JSON.parse(localStorage.getItem("posting-map-center")) || WORLD_WITH_JAPAN_FOCUS;
  } catch {
    return WORLD_WITH_JAPAN_FOCUS;
  }
}

function savedZoom() {
  const zoom = Number(localStorage.getItem("posting-map-zoom"));
  return Number.isFinite(zoom) ? zoom : 15;
}

function persist() {
  updateSavedCount();
  saveState({ records, activeArea }).catch(() => showToast("保存に失敗しました"));
}

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE)) database.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function loadState() {
  return new Promise((resolve) => {
    const tx = db.transaction(STORE, "readonly");
    const request = tx.objectStore(STORE).get("app");
    request.onsuccess = () => resolve(request.result || {});
    request.onerror = () => resolve({});
  });
}

function saveState(value) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(value, "app");
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  });
}
