const DB_NAME = "posting-map-db";
const DB_VERSION = 1;
const STORE = "state";
const STATUS_LABELS = {
  unvisited: "未配布",
  done: "配布済",
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
let selectedBuilding = null;
let records = {};
let activeArea = null;
let cityIndexPromise = null;
let drawing = false;
let draftPoints = [];
let longPressTimer = null;
let longPressPoint = null;
let toastTimer = null;
let currentLocationMarker = null;
let locationWatchId = null;
let silentLocationFailure = false;
let centerOnNextLocation = false;
let lastUiInteractionAt = 0;

const els = {
  addressInput: document.getElementById("addressInput"),
  searchForm: document.getElementById("searchForm"),
  suggestionPanel: document.getElementById("suggestionPanel"),
  locateButton: document.getElementById("locateButton"),
  clearAreaButton: document.getElementById("clearAreaButton"),
  drawButton: document.getElementById("drawButton"),
  areaTotal: document.getElementById("areaTotal"),
  menuButton: document.getElementById("menuButton"),
  menuPanel: document.getElementById("menuPanel"),
  drawPanel: document.getElementById("drawPanel"),
  statusPanel: document.getElementById("statusPanel"),
  panelGrabber: document.getElementById("panelGrabber"),
  drawCount: document.getElementById("drawCount"),
  undoPointButton: document.getElementById("undoPointButton"),
  finishAreaButton: document.getElementById("finishAreaButton"),
  cancelDrawButton: document.getElementById("cancelDrawButton"),
  selectedLabel: document.getElementById("selectedLabel"),
  deliveryCountInput: document.getElementById("deliveryCountInput"),
  memoButton: document.getElementById("memoButton"),
  memoPreview: document.getElementById("memoPreview"),
  memoDialog: document.getElementById("memoDialog"),
  memoText: document.getElementById("memoText"),
  confirmDeleteDialog: document.getElementById("confirmDeleteDialog"),
  confirmDeleteButton: document.getElementById("confirmDeleteButton"),
  confirmClearAreaDialog: document.getElementById("confirmClearAreaDialog"),
  confirmClearAreaButton: document.getElementById("confirmClearAreaButton"),
  saveMemoButton: document.getElementById("saveMemoButton"),
  deleteBuildingButton: document.getElementById("deleteBuildingButton"),
  savedCount: document.getElementById("savedCount"),
  deleteRecordButton: document.getElementById("deleteRecordButton"),
  exportButton: document.getElementById("exportButton"),
  backupInput: document.getElementById("backupInput"),
  deleteAreaRecordsButton: document.getElementById("deleteAreaRecordsButton"),
  initializeButton: document.getElementById("initializeButton"),
  confirmDeleteAreaRecordsDialog: document.getElementById("confirmDeleteAreaRecordsDialog"),
  confirmDeleteAreaRecordsButton: document.getElementById("confirmDeleteAreaRecordsButton"),
  confirmInitializeDialog: document.getElementById("confirmInitializeDialog"),
  confirmInitializeButton: document.getElementById("confirmInitializeButton"),
  deleteAreaRecordsSummary: document.getElementById("deleteAreaRecordsSummary"),
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
  refreshSelectionLabel();
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
    updateSelectedBuildingLayer();
    updateAreaLayers();
    updateSavedCount();
    wireMapGestures();
    startLocationWatch(false);
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
  map.addSource("count-labels", emptyGeoJsonSource());
  map.addSource("selected-building", emptyGeoJsonSource());

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
    id: "count-label-text",
    type: "symbol",
    source: "count-labels",
    layout: {
      "text-field": ["get", "deliveryCount"],
      "text-font": ["Noto Sans Regular"],
      "text-size": 15,
      "text-allow-overlap": true,
      "text-ignore-placement": true,
    },
    paint: {
      "text-color": "#111111",
      "text-halo-color": "#ffffff",
      "text-halo-width": 2.4,
      "text-halo-blur": 0.2,
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
    id: "selected-building-line",
    type: "line",
    source: "selected-building",
    paint: {
      "line-color": "#e11d48",
      "line-width": 3,
      "line-dasharray": [1.2, 1.2],
      "line-opacity": 0.96,
    },
  });

  map.addLayer({
    id: "draft-area-line",
    type: "line",
    source: "draft-area",
    filter: ["==", ["geometry-type"], "LineString"],
    paint: {
      "line-color": "#2457a7",
      "line-width": 3,
      "line-dasharray": [1.2, 1.2],
    },
  });

  map.addLayer({
    id: "draft-area-points",
    type: "circle",
    source: "draft-area",
    filter: ["==", ["geometry-type"], "Point"],
    paint: {
      "circle-radius": 6,
      "circle-color": "#e11d48",
      "circle-stroke-color": "#ffffff",
      "circle-stroke-width": 2,
    },
  });
}

function bindUi() {
  bindUiEventGuards();
  els.searchForm.addEventListener("submit", searchAddress);
  els.locateButton.addEventListener("click", locateUser);
  els.clearAreaButton.addEventListener("click", requestClearArea);
  els.drawButton.addEventListener("click", startDrawing);
  els.menuButton.addEventListener("click", toggleMenu);
  els.panelGrabber.addEventListener("click", toggleStatusPanel);
  els.undoPointButton.addEventListener("click", undoDraftPoint);
  els.finishAreaButton.addEventListener("click", finishDrawing);
  els.cancelDrawButton.addEventListener("click", cancelDrawing);
  els.deliveryCountInput.addEventListener("input", saveDeliveryCount);
  els.memoButton.addEventListener("click", openMemo);
  els.saveMemoButton.addEventListener("click", saveMemo);
  els.deleteBuildingButton.addEventListener("click", requestDeleteSelectedBuilding);
  els.deleteRecordButton.addEventListener("click", requestDeleteSelectedBuilding);
  els.confirmDeleteButton.addEventListener("click", deleteSelectedBuilding);
  els.confirmClearAreaButton.addEventListener("click", clearArea);
  els.exportButton.addEventListener("click", exportBackup);
  els.backupInput.addEventListener("change", importBackup);
  els.deleteAreaRecordsButton.addEventListener("click", requestDeleteAreaRecords);
  els.initializeButton.addEventListener("click", requestInitializeApp);
  els.confirmDeleteAreaRecordsButton.addEventListener("click", deleteAreaRecords);
  els.confirmInitializeButton.addEventListener("click", initializeApp);
  els.clearSelectionButton.addEventListener("click", clearSelection);

  document.querySelectorAll(".status-button").forEach((button) => {
    button.addEventListener("click", () => setSelectedStatus(button.dataset.status));
  });

  document.addEventListener("click", (event) => {
    if (!els.menuPanel.classList.contains("hidden") && !event.target.closest(".tool-row") && !event.target.closest(".menu-panel")) {
      els.menuPanel.classList.add("hidden");
    }
  });
}

function toggleMenu() {
  els.menuPanel.classList.toggle("hidden");
}

function toggleStatusPanel() {
  els.statusPanel.classList.toggle("collapsed");
}

function bindUiEventGuards() {
  const uiRoots = [
    document.querySelector(".top-panel"),
    document.getElementById("drawPanel"),
    document.getElementById("statusPanel"),
    ...document.querySelectorAll("dialog"),
  ].filter(Boolean);

  uiRoots.forEach((root) => {
    ["pointerdown", "touchstart", "mousedown", "click"].forEach((eventName) => {
      root.addEventListener(eventName, markUiInteraction, { passive: true });
    });
  });
}

function markUiInteraction(event) {
  lastUiInteractionAt = Date.now();
  event.stopPropagation();
}

function recentlyTouchedUi() {
  return Date.now() - lastUiInteractionAt < 700;
}

function wireMapGestures() {
  map.on("click", (event) => {
    if (recentlyTouchedUi()) return;
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
  hideSuggestions();
  showToast("町丁目境界を検索中");
  try {
    const boundary = await findBoundaryByAddress(query);
    if (boundary) {
      activeArea = boundary.feature;
      updateAreaLayers();
      fitFeature(activeArea);
      persist();
      showToast(`${boundary.name}を範囲にしました`);
      return;
    }
  } catch {
    cityIndexPromise = null;
  }

  try {
    const boundarySuggestions = await findBoundarySuggestionsByAddress(query);
    if (boundarySuggestions.length > 0) {
      showBoundarySuggestions(boundarySuggestions);
      showToast("範囲候補を選んでください");
      return;
    }
  } catch {
    cityIndexPromise = null;
  }

  showToast("候補を検索中");
  try {
    const results = await searchAddressCandidates(query);
    if (results.length === 0) {
      showToast("住所が見つかりませんでした");
      return;
    }
    showSuggestions(results);
    showToast("候補を選んでください");
  } catch {
    showToast("住所検索に失敗しました");
  }
}

async function searchAddressCandidates(query) {
  const url = `https://msearch.gsi.go.jp/address-search/AddressSearch?q=${encodeURIComponent(query)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error("search failed");
  const json = await res.json();
  const results = Array.isArray(json) ? json : (Array.isArray(json?.value) ? json.value : []);
  return results
    .filter((feature) => feature?.properties?.title && Array.isArray(feature?.geometry?.coordinates))
    .slice(0, 5);
}

function showSuggestions(results) {
  els.suggestionPanel.innerHTML = "";
  const title = document.createElement("div");
  title.className = "suggestion-title";
  title.textContent = "もしかして";
  els.suggestionPanel.appendChild(title);

  results.forEach((feature) => {
    const button = document.createElement("button");
    button.className = "suggestion-button";
    button.type = "button";
    button.textContent = feature.properties.title;
    button.addEventListener("click", () => useAddressSuggestion(feature));
    els.suggestionPanel.appendChild(button);
  });

  els.suggestionPanel.classList.remove("hidden");
}

function showBoundarySuggestions(suggestions) {
  els.suggestionPanel.innerHTML = "";
  const title = document.createElement("div");
  title.className = "suggestion-title";
  title.textContent = "選べる範囲";
  els.suggestionPanel.appendChild(title);

  suggestions.forEach((suggestion) => {
    const button = document.createElement("button");
    button.className = "suggestion-button";
    button.type = "button";
    button.textContent = suggestion.name;
    button.addEventListener("click", () => useBoundarySuggestion(suggestion));
    els.suggestionPanel.appendChild(button);
  });

  els.suggestionPanel.classList.remove("hidden");
}

function hideSuggestions() {
  els.suggestionPanel.classList.add("hidden");
  els.suggestionPanel.innerHTML = "";
}

async function useAddressSuggestion(feature) {
  const title = feature.properties.title;
  els.addressInput.value = title;
  hideSuggestions();
  showToast("候補の範囲を検索中");

  try {
    const boundary = await findBoundaryByAddress(title);
    if (boundary) {
      activeArea = boundary.feature;
      updateAreaLayers();
      fitFeature(activeArea);
      persist();
      showToast(`${boundary.name}を範囲にしました`);
      return;
    }
  } catch {
    cityIndexPromise = null;
  }

  try {
    const boundarySuggestions = await findBoundarySuggestionsByAddress(title);
    if (boundarySuggestions.length > 0) {
      showBoundarySuggestions(boundarySuggestions);
      showToast("範囲候補を選んでください");
      return;
    }
  } catch {
    cityIndexPromise = null;
  }

  const [lng, lat] = feature.geometry.coordinates;
  map.flyTo({ center: [lng, lat], zoom: Math.max(map.getZoom(), 16.2), essential: true });
  showToast("中心へ移動しました。町丁目まで詳しく入れると自動範囲指定できます");
}

function useBoundarySuggestion(suggestion) {
  els.addressInput.value = suggestion.name;
  hideSuggestions();
  activeArea = suggestion.feature;
  updateAreaLayers();
  fitFeature(activeArea);
  persist();
  showToast(`${suggestion.name}を範囲にしました`);
}

async function findBoundaryByAddress(query) {
  if (!window.topojson) return null;
  const normalizedQuery = normalizeAddressText(query);
  const city = await findCityForQuery(normalizedQuery);
  if (!city) return null;

  const topo = await fetchJson(city.topoUrl);
  const cityCollection = topojson.feature(topo, topo.objects.city);
  const townCollection = topojson.feature(topo, topo.objects.town);
  const cityName = cityNameInQuery(city, normalizedQuery);
  const remainder = normalizedQuery.replace(cityName, "");

  if (!remainder) {
    const cityFeature = cityCollection.features?.[0];
    return cityFeature ? {
      name: city.name,
      feature: areaFeatureFromFeatures([cityFeature], city.name, { source: "Geoshape city" }),
    } : null;
  }

  const townMatches = townCollection.features.filter((feature) => {
    const townName = normalizeAddressText(feature.properties?.S_NAME || "");
    return townName && (remainder.includes(townName) || normalizedQuery.includes(townName));
  });
  if (townMatches.length === 0) return null;

  townMatches.sort((a, b) => {
    const aName = normalizeAddressText(a.properties?.S_NAME || "");
    const bName = normalizeAddressText(b.properties?.S_NAME || "");
    return bName.length - aName.length;
  });

  const bestName = normalizeAddressText(townMatches[0].properties?.S_NAME || "");
  const bestMatches = townMatches.filter((feature) => normalizeAddressText(feature.properties?.S_NAME || "") === bestName);
  const displayName = `${city.name}${bestMatches[0].properties?.S_NAME || ""}`;

  return {
    name: displayName,
    feature: areaFeatureFromFeatures(bestMatches, displayName, {
      source: "Geoshape town",
      cityCode: city.code,
      keyCodes: bestMatches.map((feature) => feature.properties?.KEY_CODE).filter(Boolean),
    }),
  };
}

async function findBoundarySuggestionsByAddress(query) {
  if (!window.topojson) return [];
  const normalizedQuery = normalizeAddressText(query);
  const city = await findCityForQuery(normalizedQuery);
  if (!city) return [];

  const topo = await fetchJson(city.topoUrl);
  const townCollection = topojson.feature(topo, topo.objects.town);
  const cityName = cityNameInQuery(city, normalizedQuery);
  const remainder = normalizedQuery.replace(cityName, "");
  if (!remainder) return [];

  const groups = new Map();
  townCollection.features.forEach((feature) => {
    const rawTownName = feature.properties?.S_NAME || "";
    const townName = normalizeAddressText(rawTownName);
    if (!townName) return;
    const matches = townName.includes(remainder) || remainder.includes(townName) || normalizedQuery.includes(townName);
    if (!matches) return;
    if (!groups.has(townName)) groups.set(townName, { rawTownName, features: [] });
    groups.get(townName).features.push(feature);
  });

  return Array.from(groups.entries())
    .sort(([, a], [, b]) => townGroupSortValue(a) - townGroupSortValue(b) || a.rawTownName.localeCompare(b.rawTownName, "ja"))
    .map(([, group]) => {
      const name = `${city.name}${group.rawTownName}`;
      return {
        name,
        feature: areaFeatureFromFeatures(group.features, name, {
          source: "Geoshape town suggestion",
          cityCode: city.code,
          keyCodes: group.features.map((feature) => feature.properties?.KEY_CODE).filter(Boolean),
        }),
      };
    });
}

function townGroupSortValue(group) {
  const value = Number(group.features[0]?.properties?.KIHON2);
  return Number.isFinite(value) ? value : 9999;
}

async function findCityForQuery(normalizedQuery) {
  const cities = await loadCityIndex();
  const matches = cities
    .map((city) => {
      const aliases = cityNameAliases(city.name).filter((name) => normalizedQuery.includes(name));
      const score = aliases.reduce((max, name) => Math.max(max, name.length), 0);
      return score ? { city, score } : null;
    })
    .filter(Boolean);
  matches.sort((a, b) => b.score - a.score);
  return matches[0]?.city || null;
}

function cityNameAliases(name) {
  const normalized = normalizeAddressText(name);
  const withoutPref = normalized.replace(/^(北海道|東京都|京都府|大阪府|.{2,3}県)/, "");
  return Array.from(new Set([normalized, withoutPref].filter(Boolean)));
}

function cityNameInQuery(city, normalizedQuery) {
  const aliases = cityNameAliases(city.name);
  aliases.sort((a, b) => b.length - a.length);
  return aliases.find((name) => normalizedQuery.includes(name)) || "";
}

async function loadCityIndex() {
  if (cityIndexPromise) return cityIndexPromise;
  cityIndexPromise = fetch("https://geoshape.ex.nii.ac.jp/ka/resource/")
    .then((response) => {
      if (!response.ok) throw new Error("city index failed");
      return response.text();
    })
    .then((html) => {
      const doc = new DOMParser().parseFromString(html, "text/html");
      return Array.from(doc.querySelectorAll("tr")).map((row) => {
        const cells = row.querySelectorAll("td");
        if (cells.length < 4) return null;
        const code = cells[1].textContent.trim();
        const name = cells[2].textContent.trim();
        const topoLink = cells[3].querySelector("a")?.getAttribute("href");
        if (!/^\d{5}$/.test(code) || !name || !topoLink) return null;
        return {
          code,
          name,
          topoUrl: new URL(topoLink, "https://geoshape.ex.nii.ac.jp").toString(),
        };
      }).filter(Boolean);
    });
  return cityIndexPromise;
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`fetch failed: ${url}`);
  return response.json();
}

function locateUser() {
  centerOnNextLocation = true;
  startLocationWatch(true);
}

function startLocationWatch(showErrors) {
  if (!navigator.geolocation) {
    if (showErrors) showToast("このブラウザでは現在地を取得できません");
    return;
  }
  if (locationWatchId !== null) {
    if (currentLocationMarker) {
      const lngLat = currentLocationMarker.getLngLat();
      map.flyTo({ center: [lngLat.lng, lngLat.lat], zoom: Math.max(map.getZoom(), 17), essential: true });
    }
    return;
  }

  locationWatchId = navigator.geolocation.watchPosition(
    updateCurrentLocation,
    () => {
      locationWatchId = null;
      if (showErrors || !silentLocationFailure) showToast("現在地表示には位置情報を許可してください");
      silentLocationFailure = true;
    },
    { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 },
  );
}

function updateCurrentLocation(position) {
  const lngLat = [position.coords.longitude, position.coords.latitude];
  if (!currentLocationMarker) {
    const el = document.createElement("div");
    el.className = "current-location-marker";
    currentLocationMarker = new maplibregl.Marker({ element: el, anchor: "center" })
      .setLngLat(lngLat)
      .addTo(map);
  } else {
    currentLocationMarker.setLngLat(lngLat);
  }

  if (centerOnNextLocation) {
    centerOnNextLocation = false;
    map.flyTo({ center: lngLat, zoom: Math.max(map.getZoom(), 17), essential: true });
    showToast("現在地へ移動しました");
  }
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
  selectedBuildingId = id;
  selectedBuilding = { id, geometry };
  refreshSelectionLabel();
  updateSelectedBuildingLayer();
  return true;
}

function setSelectedStatus(status) {
  const record = ensureSelectedRecord();
  if (!record) {
    showToast("先に建物をタップしてください");
    return;
  }
  record.status = record.status === status ? "" : status;
  record.updatedAt = new Date().toISOString();
  pruneSelectedRecordIfEmpty();
  refreshSelectionLabel();
  updateSelectedBuildingLayer();
  updateStatusLayer();
  persist();
}

function saveDeliveryCount() {
  if (!selectedBuilding) {
    els.deliveryCountInput.value = "";
    showToast("先に建物を選択してください");
    return;
  }
  const value = els.deliveryCountInput.value.trim();
  if (value === "" && !selectedRecord()) return;
  const record = ensureSelectedRecord();
  record.deliveryCount = value === "" ? "" : String(Math.max(0, Math.floor(Number(value) || 0)));
  if (record.deliveryCount !== value) els.deliveryCountInput.value = record.deliveryCount;
  record.updatedAt = new Date().toISOString();
  pruneSelectedRecordIfEmpty();
  refreshSelectionLabel();
  updateStatusLayer();
  persist();
}

function openMemo() {
  if (!selectedBuilding) {
    showToast("先に建物を選択してください");
    return;
  }
  const record = selectedRecord();
  els.memoText.value = record?.memo || "";
  if (typeof els.memoDialog.showModal === "function") {
    els.memoDialog.showModal();
  } else {
    const memo = prompt("メモ", record?.memo || "");
    if (memo !== null) {
      const nextRecord = ensureSelectedRecord();
      nextRecord.memo = memo;
      nextRecord.updatedAt = new Date().toISOString();
      refreshSelectionLabel();
      persist();
      showToast("メモを保存しました");
    }
  }
}

function saveMemo() {
  if (!selectedBuilding) return;
  const memo = els.memoText.value.trim();
  if (memo === "" && !selectedRecord()) {
    els.memoDialog.close();
    return;
  }
  const record = ensureSelectedRecord();
  record.memo = memo;
  record.updatedAt = new Date().toISOString();
  pruneSelectedRecordIfEmpty();
  refreshSelectionLabel();
  updateStatusLayer();
  persist();
  els.memoDialog.close();
  showToast("メモを保存しました");
}

function requestDeleteSelectedBuilding() {
  if (!selectedBuildingId) {
    showToast("先に建物を選択してください");
    return;
  }
  if (!records[selectedBuildingId]) {
    clearSelection();
    showToast("この建物の記録はまだありません");
    return;
  }
  if (typeof els.confirmDeleteDialog.showModal === "function") {
    els.confirmDeleteDialog.showModal();
  } else if (confirm("この建物の記録を本当に消しますか？")) {
    deleteSelectedBuilding();
  }
}

function deleteSelectedBuilding() {
  if (!selectedBuildingId) return;
  delete records[selectedBuildingId];
  selectedBuildingId = null;
  selectedBuilding = null;
  updateStatusLayer();
  updateSelectedBuildingLayer();
  refreshSelectionLabel();
  persist();
  if (els.memoDialog.open) els.memoDialog.close();
  if (els.confirmDeleteDialog.open) els.confirmDeleteDialog.close();
  showToast("この建物の記録を削除しました");
}

function requestClearArea() {
  if (!activeArea) {
    showToast("選択範囲はありません");
    return;
  }
  if (typeof els.confirmClearAreaDialog.showModal === "function") {
    els.confirmClearAreaDialog.showModal();
  } else if (confirm("選択範囲を解除しますか？")) {
    clearArea();
  }
}

function clearArea() {
  activeArea = null;
  updateAreaLayers();
  persist();
  if (els.confirmClearAreaDialog.open) els.confirmClearAreaDialog.close();
  showToast("選択範囲を解除しました");
}

function requestDeleteAreaRecords() {
  els.menuPanel.classList.add("hidden");
  if (!activeArea) {
    showToast("先に範囲を指定してください");
    return;
  }
  let ids = [];
  try {
    ids = areaRecordIds();
  } catch {
    showToast("範囲内の記録を確認できませんでした");
    return;
  }
  els.deleteAreaRecordsSummary.textContent = `対象 ${ids.length}件`;
  if (typeof els.confirmDeleteAreaRecordsDialog.showModal === "function") {
    els.confirmDeleteAreaRecordsDialog.showModal();
  } else if (confirm("選択範囲内のすべての建物記録を本当に消しますか？")) {
    deleteAreaRecords();
  }
}

function deleteAreaRecords() {
  const fields = selectedDeleteFields("area");
  if (fields.length === 0) {
    showToast("消す項目を選択してください");
    return;
  }
  const ids = areaRecordIds();
  if (ids.length === 0) {
    if (els.confirmDeleteAreaRecordsDialog.open) els.confirmDeleteAreaRecordsDialog.close();
    showToast("選択範囲内に削除する記録はありません");
    return;
  }
  ids.forEach((id) => clearRecordFields(records[id], fields));
  pruneEmptyRecords();
  if (selectedBuildingId && !records[selectedBuildingId]) {
    selectedBuildingId = null;
    selectedBuilding = null;
  }
  updateStatusLayer();
  updateSelectedBuildingLayer();
  refreshSelectionLabel();
  persist();
  if (els.confirmDeleteAreaRecordsDialog.open) els.confirmDeleteAreaRecordsDialog.close();
  showToast(`範囲内の記録を${ids.length}件更新しました`);
}

function requestInitializeApp() {
  els.menuPanel.classList.add("hidden");
  if (Object.keys(records).length === 0 && !activeArea) {
    showToast("初期化するデータはありません");
    return;
  }
  if (typeof els.confirmInitializeDialog.showModal === "function") {
    els.confirmInitializeDialog.showModal();
  } else if (confirm("すべての建物記録、メモ、配布枚数、選択範囲を本当に消しますか？")) {
    initializeApp();
  }
}

function initializeApp() {
  const fields = selectedDeleteFields("all");
  if (fields.length === 0) {
    showToast("消す項目を選択してください");
    return;
  }
  Object.values(records).forEach((record) => clearRecordFields(record, fields));
  pruneEmptyRecords();
  if (fields.includes("area")) activeArea = null;
  if (selectedBuildingId && !records[selectedBuildingId]) {
    selectedBuildingId = null;
    selectedBuilding = null;
  }
  updateStatusLayer();
  updateSelectedBuildingLayer();
  updateAreaLayers();
  refreshSelectionLabel();
  persist();
  if (els.confirmInitializeDialog.open) els.confirmInitializeDialog.close();
  showToast("選択した項目を削除しました");
}

function areaRecordIds() {
  if (!activeArea) return [];
  return Object.values(records)
    .filter((record) => record?.geometry && geometryIntersectsArea(record.geometry, activeArea))
    .map((record) => record.id);
}

function selectedDeleteFields(scope) {
  return Array.from(document.querySelectorAll(`.delete-options[data-scope="${scope}"] input:checked`))
    .map((input) => input.dataset.deleteField);
}

function clearRecordFields(record, fields) {
  if (!record) return;
  if (fields.includes("status")) record.status = "";
  if (fields.includes("memo")) record.memo = "";
  if (fields.includes("deliveryCount")) record.deliveryCount = "";
  record.updatedAt = new Date().toISOString();
}

function pruneEmptyRecords() {
  Object.keys(records).forEach((id) => {
    const record = records[id];
    if (!record.status && !record.memo && !record.deliveryCount) delete records[id];
  });
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
  updateAreaTotal();
}

function updateDraftArea() {
  els.drawCount.textContent = `${draftPoints.length}点`;
  if (!map || !map.getSource("draft-area")) return;
  const features = draftPoints.map((point, index) => ({
    type: "Feature",
    properties: { index: index + 1 },
    geometry: { type: "Point", coordinates: point },
  }));
  if (draftPoints.length >= 2) {
    features.push({
      type: "Feature",
      properties: {},
      geometry: { type: "LineString", coordinates: draftPoints.length > 2 ? closeRing(draftPoints) : draftPoints },
    });
  }
  map.getSource("draft-area").setData({
    type: "FeatureCollection",
    features,
  });
}

function updateStatusLayer() {
  if (!map || !map.getSource("status-buildings")) return;
  const features = Object.values(records).filter((record) => record.status).map((record) => ({
    type: "Feature",
    properties: {
      id: record.id,
      status: record.status,
      color: STATUS_COLORS[record.status] || STATUS_COLORS.unvisited,
      memo: record.memo || "",
      deliveryCount: record.deliveryCount || "",
    },
    geometry: record.geometry,
  }));
  map.getSource("status-buildings").setData({ type: "FeatureCollection", features });
  updateCountLabels();
  updateSavedCount();
}

function updateCountLabels() {
  if (!map || !map.getSource("count-labels")) return;
  const features = Object.values(records).filter((record) => {
    const count = Number(record.deliveryCount);
    return Number.isFinite(count) && count > 0;
  }).map((record) => ({
    type: "Feature",
    properties: {
      id: record.id,
      deliveryCount: String(record.deliveryCount),
    },
    geometry: {
      type: "Point",
      coordinates: labelPointForGeometry(record.geometry),
    },
  }));
  map.getSource("count-labels").setData({ type: "FeatureCollection", features });
}

function updateSelectedBuildingLayer() {
  if (!map || !map.getSource("selected-building")) return;
  const geometry = selectedBuilding?.geometry || selectedRecord()?.geometry;
  const features = geometry ? [{
    type: "Feature",
    properties: { id: selectedBuildingId },
    geometry,
  }] : [];
  map.getSource("selected-building").setData({ type: "FeatureCollection", features });
}

function clearSelection() {
  selectedBuildingId = null;
  selectedBuilding = null;
  refreshSelectionLabel();
  updateSelectedBuildingLayer();
}

function refreshSelectionLabel() {
  const record = selectedRecord();
  els.selectedLabel.textContent = record ? STATUS_LABELS[record.status] : "";
  els.deliveryCountInput.value = record?.deliveryCount || "";
  els.deliveryCountInput.disabled = !selectedBuilding;
  const memo = record?.memo || "";
  els.memoPreview.textContent = memo || "メモ";
  els.memoButton.classList.toggle("has-memo", Boolean(memo));
}

function updateSavedCount() {
  const count = Object.keys(records).length;
  els.savedCount.textContent = `保存 ${count}件`;
  updateAreaTotal();
}

function updateAreaTotal() {
  if (!els.areaTotal) return;
  const total = activeArea ? Object.values(records).reduce((sum, record) => {
    const count = Number(record.deliveryCount);
    if (!Number.isFinite(count) || count <= 0) return sum;
    return geometryIntersectsArea(record.geometry, activeArea) ? sum + count : sum;
  }, 0) : 0;
  els.areaTotal.textContent = `範囲内 ${total}枚`;
}

async function exportBackup() {
  els.menuPanel.classList.add("hidden");
  const payload = {
    version: 1,
    exportedAt: new Date().toISOString(),
    attribution: [
      "地理院タイル",
      "国土地理院最適化ベクトルタイル",
      "国勢調査町丁・字等別境界データセット（CODH作成、令和2年国勢調査町丁・字等別境界データを加工）",
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
  els.menuPanel.classList.add("hidden");
  const file = event.target.files[0];
  event.target.value = "";
  if (!file) return;
  try {
    const json = JSON.parse(await file.text());
    if (!json.records || typeof json.records !== "object") throw new Error("invalid");
    records = json.records;
    activeArea = json.activeArea || activeArea;
    selectedBuildingId = null;
    selectedBuilding = null;
    updateStatusLayer();
    updateSelectedBuildingLayer();
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

function ensureSelectedRecord() {
  if (!selectedBuilding) return null;
  if (!records[selectedBuilding.id]) {
    records[selectedBuilding.id] = {
      id: selectedBuilding.id,
      status: "",
      memo: "",
      deliveryCount: "",
      geometry: selectedBuilding.geometry,
      updatedAt: new Date().toISOString(),
    };
  }
  return records[selectedBuilding.id];
}

function pruneSelectedRecordIfEmpty() {
  if (!selectedBuildingId || !records[selectedBuildingId]) return;
  pruneEmptyRecords();
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

function areaFeatureFromFeatures(features, name, extraProperties = {}) {
  const polygons = [];
  for (const feature of features) {
    if (feature.geometry.type === "Polygon") {
      polygons.push(feature.geometry.coordinates);
    } else if (feature.geometry.type === "MultiPolygon") {
      polygons.push(...feature.geometry.coordinates);
    }
  }

  return {
    type: "Feature",
    properties: {
      name,
      updatedAt: new Date().toISOString(),
      ...extraProperties,
    },
    geometry: polygons.length === 1
      ? { type: "Polygon", coordinates: polygons[0] }
      : { type: "MultiPolygon", coordinates: polygons },
  };
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

function geometryIntersectsArea(geometry, areaFeature) {
  const coords = flattenCoordinates(geometry.coordinates);
  if (coords.some((coord) => pointInFeature(coord, areaFeature))) return true;
  const centroid = geometryCentroid(coords);
  return centroid ? pointInFeature(centroid, areaFeature) : false;
}

function geometryCentroid(coords) {
  if (!coords.length) return null;
  const total = coords.reduce((sum, coord) => [sum[0] + coord[0], sum[1] + coord[1]], [0, 0]);
  return [total[0] / coords.length, total[1] / coords.length];
}

function labelPointForGeometry(geometry) {
  const coords = flattenCoordinates(geometry.coordinates);
  return geometryCentroid(coords) || coords[0] || [0, 0];
}

function pointInFeature(point, feature) {
  if (!feature?.geometry) return false;
  if (feature.geometry.type === "Polygon") return pointInPolygon(point, feature.geometry.coordinates);
  if (feature.geometry.type === "MultiPolygon") {
    return feature.geometry.coordinates.some((polygon) => pointInPolygon(point, polygon));
  }
  return false;
}

function pointInPolygon(point, rings) {
  if (!rings.length || !pointInRing(point, rings[0])) return false;
  return !rings.slice(1).some((ring) => pointInRing(point, ring));
}

function pointInRing(point, ring) {
  const [x, y] = point;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const xi = ring[i][0];
    const yi = ring[i][1];
    const xj = ring[j][0];
    const yj = ring[j][1];
    const crosses = ((yi > y) !== (yj > y)) && (x < ((xj - xi) * (y - yi)) / (yj - yi) + xi);
    if (crosses) inside = !inside;
  }
  return inside;
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

function normalizeAddressText(value) {
  return toHalfWidth(String(value || ""))
    .replace(/\s+/g, "")
    .replace(/[ヶヵ]/g, "ケ")
    .replace(/([0-9]+)丁目/g, (_, number) => `${numberToKanji(Number(number))}丁目`);
}

function toHalfWidth(value) {
  return value.replace(/[！-～]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xfee0));
}

function numberToKanji(number) {
  const digit = ["", "一", "二", "三", "四", "五", "六", "七", "八", "九"];
  if (!Number.isFinite(number) || number <= 0) return String(number);
  if (number < 10) return digit[number];
  if (number === 10) return "十";
  if (number < 20) return `十${digit[number - 10]}`;
  if (number < 100) {
    const tens = Math.floor(number / 10);
    const ones = number % 10;
    return `${digit[tens]}十${digit[ones]}`;
  }
  return String(number);
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
