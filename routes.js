/* Walking routes are stored separately from building records and API credentials. */
(() => {
  const STORAGE_KEY = "walking-route";
  const GROUP_SIZE = 40;
  const TILE_ZOOM = 16;
  const MAX_TILES = 100;
  const MAX_BUILDINGS = 2000;
  const API_ORIGIN = "https://api.heigit.org";
  let librariesPromise;

  async function libraries() {
    if (!librariesPromise) {
      librariesPromise = Promise.all([
        import("https://esm.sh/@mapbox/vector-tile@2.0.4"),
        import("https://esm.sh/pbf@4.0.1"),
        import("https://esm.sh/@turf/nearest-point-on-line@7.2.0"),
        import("https://esm.sh/@turf/line-slice-along@7.2.0"),
        import("https://esm.sh/@turf/distance@7.2.0"),
        import("https://esm.sh/@turf/point-on-feature@7.2.0"),
      ]).then(([vector, pbf, nearest, slice, distance, point]) => ({
        VectorTile: vector.VectorTile, Pbf: pbf.default,
        nearest: nearest.default, slice: slice.default,
        distance: distance.default, point: point.default,
      })).catch((error) => { librariesPromise = null; throw error; });
    }
    return librariesPromise;
  }

  const collection = (features = []) => ({ type: "FeatureCollection", features });
  const line = (coordinates) => ({ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates } });

  class PostingRoutePlanner {
    constructor(options) {
      this.options = options;
      this.map = options.map;
      this.plan = null;
      this.busy = false;
      this.visible = false;
      this.collapsed = false;
      this.recording = false;
      this.previousFix = null;
      this.controller = null;
      this.saveTimer = null;
      this.saveQueue = Promise.resolve();
      this.apiCalls = 0;
      this.libs = null;
      this.els = {};
      ["routePanel", "routeSummary", "routeGroupSelect", "routeCreateButton", "routeReplanButton",
        "routeRecordButton", "routeFitButton", "routeClearButton", "routeCloseButton", "routeCancelButton",
        "routeStatus", "routeMenuButton"].forEach((id) => { this.els[id] = document.getElementById(id); });
      this.els.routeMenuButton.addEventListener("click", () => this.open());
      this.els.routeCreateButton.addEventListener("click", () => this.create());
      this.els.routeReplanButton.addEventListener("click", () => this.replan());
      this.els.routeRecordButton.addEventListener("click", () => this.toggleRecording());
      this.els.routeFitButton.addEventListener("click", () => this.fit());
      this.els.routeClearButton.addEventListener("click", () => this.clear());
      this.els.routeCancelButton.addEventListener("click", () => this.controller?.abort());
      this.els.routeCloseButton.addEventListener("click", () => {
        this.collapsed = !this.collapsed;
        this.render();
      });
      this.els.routeGroupSelect.addEventListener("change", () => {
        this.previousFix = null;
        this.plan.activeGroup = Number(this.els.routeGroupSelect.value);
        this.save();
        this.render();
        this.fit();
      });
      window.addEventListener("pagehide", () => this.save());
      document.addEventListener("visibilitychange", () => {
        this.previousFix = null;
        if (document.hidden) this.save();
      });
    }

    async initialize() {
      try {
        const value = await this.read();
        if (value?.version === 1 && Array.isArray(value.groups) && value.areaSignature) {
          this.plan = value;
          this.visible = this.matchesArea();
        }
      } catch { this.options.toast("保存したルートを読み込めませんでした"); }
      if (this.matchesArea()) this.setStatus("保存したルートを表示しています（API追加消費なし）");
      this.render();
    }

    onMapLoad() {
      ["walking-route", "walked-route", "route-stops"].forEach((id) => {
        this.map.addSource(id, { type: "geojson", data: collection() });
      });
      this.map.addLayer({ id: "walking-route-line", type: "line", source: "walking-route",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": "#2563eb", "line-width": 5, "line-opacity": 0.75 } });
      this.map.addLayer({ id: "walked-route-line", type: "line", source: "walked-route",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": "#16835b", "line-width": 6 } });
      this.map.addLayer({ id: "route-stop-dots", type: "circle", source: "route-stops",
        paint: { "circle-radius": 9, "circle-color": "#fff", "circle-stroke-width": 2, "circle-stroke-color": "#2563eb" } });
      this.map.addLayer({ id: "route-stop-labels", type: "symbol", source: "route-stops",
        layout: { "text-field": ["get", "order"], "text-size": 11, "text-allow-overlap": false },
        paint: { "text-color": "#1e40af", "text-halo-color": "#fff", "text-halo-width": 1 } });
      this.renderMap();
    }

    matchesArea() {
      const area = this.options.getArea();
      return Boolean(area && this.plan && this.options.hash(area.geometry) === this.plan.areaSignature);
    }

    areaChanged() {
      this.controller?.abort();
      this.setRecording(false);
      this.render();
    }

    group() { return this.matchesArea() ? this.plan.groups[this.plan.activeGroup] : null; }

    open() {
      document.getElementById("menuPanel").classList.add("hidden");
      this.visible = true;
      this.collapsed = false;
      this.render();
    }

    render() {
      const group = this.group();
      this.els.routePanel.classList.toggle("hidden", !this.visible);
      this.els.routePanel.classList.toggle("collapsed", this.collapsed);
      this.els.routeCloseButton.textContent = this.collapsed ? "+" : "−";
      this.els.routeCloseButton.title = this.collapsed ? "ルート操作を開く" : "ルート操作を畳む";
      this.els.routeCloseButton.setAttribute("aria-label", this.els.routeCloseButton.title);
      this.els.routeCloseButton.setAttribute("aria-expanded", String(!this.collapsed));
      this.els.routeGroupSelect.replaceChildren();
      if (this.matchesArea()) {
        this.plan.groups.forEach((item, index) => {
          const option = document.createElement("option");
          option.value = String(index);
          option.textContent = `区間${index + 1}（${item.targets.length}軒${item.path ? "" : "・未作成"}）`;
          this.els.routeGroupSelect.appendChild(option);
        });
        this.els.routeGroupSelect.value = String(this.plan.activeGroup);
      }
      this.els.routeGroupSelect.disabled = this.busy || !group;
      this.els.routeSummary.textContent = group?.path
        ? `${(group.distance / 1000).toFixed(1)}km・徒歩約${Math.max(1, Math.ceil(group.duration / 60))}分`
        : (this.options.getArea() ? "範囲内の未配布建物から作成" : "先に配布範囲を設定してください");
      this.els.routeCreateButton.textContent = this.matchesArea() && this.plan.groups.some((item) => !item.path)
        ? "未作成区間を作成" : "ルート作成";
      this.els.routeCreateButton.disabled = this.busy || !this.options.getArea();
      this.els.routeReplanButton.disabled = this.busy || !group?.path;
      this.els.routeFitButton.disabled = this.busy || !group?.path;
      this.els.routeClearButton.disabled = this.busy || !this.plan;
      this.els.routeCloseButton.disabled = this.busy;
      this.els.routeCancelButton.classList.toggle("hidden", !this.busy);
      this.els.routeRecordButton.disabled = this.busy || !group?.path;
      this.els.routeRecordButton.classList.toggle("active", this.recording);
      this.els.routeRecordButton.setAttribute("aria-pressed", String(this.recording));
      this.els.routeRecordButton.textContent = this.recording ? "歩行記録ON" : "歩行記録OFF";
      this.renderMap();
    }

    renderMap() {
      if (!this.map.getSource("walking-route")) return;
      const group = this.visible ? this.group() : null;
      this.map.getSource("walking-route").setData(collection(group?.path ? [group.path] : []));
      this.map.getSource("walked-route").setData(collection(group?.walked || []));
      this.map.getSource("route-stops").setData(collection((group?.orderedTargets || []).map((target, index) => ({
        type: "Feature", properties: { order: String(index + 1) },
        geometry: { type: "Point", coordinates: target.point },
      }))));
    }

    async dependencies() {
      if (!this.libs) this.libs = await libraries();
      return this.libs;
    }

    setStatus(message) { this.els.routeStatus.textContent = message; }

    async run(task) {
      if (this.busy) return;
      this.busy = true;
      this.setRecording(false);
      this.controller = new AbortController();
      this.apiCalls = 0;
      this.render();
      try { await task(this.controller.signal); }
      catch (error) {
        const message = error.name === "AbortError" ? "中止しました。保存済みのルートは残ります。" : error.message;
        this.setStatus(`${message}（今回のAPI送信 ${this.apiCalls}回）`);
        this.options.toast(message);
      } finally {
        this.controller?.abort();
        this.busy = false;
        this.controller = null;
        this.render();
      }
    }

    async create() {
      await this.run(async (signal) => {
        const area = this.options.getArea();
        if (!area) throw new Error("先に配布範囲を設定してください");
        const apiKey = await this.options.loadApiKey();
        if (!apiKey) throw new Error("メニューの徒歩ルートAPI設定で自分のキーを保存してください");
        const snapshot = JSON.parse(JSON.stringify(area));
        const signature = this.options.hash(snapshot.geometry);
        this.setStatus("現在地を確認中");
        let start = await this.currentPosition(signal);
        let candidate;
        if (this.matchesArea() && this.plan.groups.some((group) => !group.path)) {
          candidate = this.plan;
        } else {
          this.setStatus("範囲全体の建物を取得中（ルートAPI消費なし）");
          const targets = await this.collectBuildings(snapshot, signal);
          if (!targets.length) throw new Error("この範囲に未配布の建物が見つかりませんでした");
          candidate = { version: 1, areaSignature: signature, createdAt: new Date().toISOString(), activeGroup: 0,
            groups: this.partition(targets, start).map((items) => ({ targets: items, walked: [] })) };
        }
        const pending = candidate.groups.filter((group) => !group.path);
        const count = pending.reduce((sum, group) => sum + group.targets.length, 0);
        signal.throwIfAborted();
        if (!confirm(`${count}軒・${pending.length}区間の徒歩ルートを作成しますか？\nAPI送信は最大${pending.length * 2}回（順番計算と徒歩経路を各${pending.length}回）。\n建物の位置を経路サービスに送信します。メモは送信しません。\n新規作成の場合、以前のルートと歩行記録を置き換えます。`)) {
          this.setStatus("作成を取りやめました（API送信なし）"); return;
        }
        signal.throwIfAborted();
        if (this.options.hash(this.options.getArea()?.geometry || {}) !== signature) throw new Error("配布範囲が変更されました。もう一度作成してください");
        for (let index = 0; index < candidate.groups.length; index++) {
          const group = candidate.groups[index];
          if (group.path) { start = group.orderedTargets.at(-1)?.point || start; continue; }
          this.setStatus(`区間${index + 1}/${candidate.groups.length}を作成中・API送信 ${this.apiCalls}回`);
          const remaining = group.targets.filter((target) => !this.excluded(target));
          if (!remaining.length) {
            group.targets = []; group.path = line([start, start]);
            group.orderedTargets = []; group.distance = 0; group.duration = 0;
          } else {
            const result = await this.calculate(remaining, start, apiKey, signal);
            Object.assign(group, result, { targets: remaining, walked: [] });
            start = result.orderedTargets.at(-1).point;
          }
          this.plan = candidate;
          await this.save();
          this.render();
        }
        this.fit();
        this.setStatus(`保存済み・今回のAPI送信 ${this.apiCalls}回。再表示・歩行記録は追加消費なし。`);
      });
    }

    async replan() {
      await this.run(async (signal) => {
        const group = this.group();
        if (!group?.path) return;
        const apiKey = await this.options.loadApiKey();
        if (!apiKey) throw new Error("徒歩ルートAPI設定で自分のキーを保存してください");
        const targets = group.targets.filter((target) => !this.excluded(target));
        if (!targets.length) throw new Error("この区間に未配布の建物は残っていません");
        if (!confirm(`この区間の未配布${targets.length}軒だけを、現在地から再検索しますか？\nAPI送信は最大2回です。この区間の歩行記録はリセットされます。`)) return;
        this.setStatus("現在地を確認中");
        const start = await this.currentPosition(signal);
        const result = await this.calculate(targets, start, apiKey, signal);
        Object.assign(group, result, { targets, walked: [] });
        await this.save();
        this.fit();
        this.setStatus(`この区間を保存しました・今回のAPI送信 ${this.apiCalls}回`);
      });
    }

    async calculate(targets, start, apiKey, signal) {
      const optimized = await this.api("/vroom/v0", {
        jobs: targets.map((target, index) => ({ id: index + 1, location: target.point })),
        vehicles: [{ id: 1, profile: "foot-walking", start }],
      }, apiKey, signal);
      if (optimized.code !== 0 || optimized.unassigned?.length || optimized.routes?.length !== 1) {
        throw new Error("全建物を回る順番を作れませんでした。範囲を小さくするか通行可能な道路を確認してください");
      }
      const ids = optimized.routes[0].steps.filter((step) => step.type === "job").map((step) => step.id - 1);
      if (ids.length !== targets.length || new Set(ids).size !== targets.length || ids.some((id) => !targets[id])) {
        throw new Error("巡回順の応答が不完全です。ルートは置き換えていません");
      }
      const orderedTargets = ids.map((id) => targets[id]);
      const directions = await this.api("/openrouteservice/v2/directions/foot-walking/geojson", {
        coordinates: [start, ...orderedTargets.map((target) => target.point)],
        radiuses: Array(targets.length + 1).fill(100), instructions: false,
      }, apiKey, signal);
      const feature = directions.features?.[0];
      const summary = feature?.properties?.summary;
      if (feature?.geometry?.type !== "LineString" || feature.geometry.coordinates.length < 2 ||
          !Number.isFinite(summary?.distance) || !Number.isFinite(summary?.duration)) {
        throw new Error("徒歩ルートの応答が不完全です。ルートは置き換えていません");
      }
      return { path: line(feature.geometry.coordinates), distance: summary.distance,
        duration: summary.duration, orderedTargets, updatedAt: new Date().toISOString() };
    }

    async api(path, body, apiKey, signal) {
      signal.throwIfAborted();
      this.apiCalls++;
      let response;
      try {
        response = await this.fetchWithTimeout(`${API_ORIGIN}${path}`, {
          method: "POST", headers: { "Authorization": apiKey, "Content-Type": "application/json" },
          body: JSON.stringify(body), cache: "no-store", credentials: "omit", redirect: "error",
        }, signal, 60000);
      } catch (error) {
        if (signal.aborted) throw error;
        throw new Error("経路サービスに接続できませんでした。通信を確認してください（自動再試行はしません）");
      }
      if (response.status === 429) throw new Error("短時間の利用上限です。少し待ってから再検索してください");
      if (response.status === 401) throw new Error("APIキーを確認してください");
      if (response.status === 403) throw new Error("APIキーの権限または本日の利用枠を、HeiGITのアカウントで確認してください");
      if (!response.ok) throw new Error(`経路検索に失敗しました（${response.status}）。範囲や道路を確認してください`);
      return response.json();
    }

    async fetchWithTimeout(url, options, signal, timeout = 20000) {
      const controller = new AbortController();
      const abort = () => controller.abort();
      signal.addEventListener("abort", abort, { once: true });
      const timer = setTimeout(abort, timeout);
      try {
        signal.throwIfAborted();
        const response = await fetch(url, { ...options, signal: controller.signal });
        // Consume the response under the same timeout, including slow body downloads.
        const data = await response.arrayBuffer();
        return new Response(data, { status: response.status, headers: response.headers });
      } finally {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
      }
    }

    currentPosition(signal) {
      if (!navigator.geolocation) return Promise.reject(new Error("現在地を取得できません"));
      return new Promise((resolve, reject) => {
        const abort = () => reject(new DOMException("Aborted", "AbortError"));
        signal.addEventListener("abort", abort, { once: true });
        navigator.geolocation.getCurrentPosition((position) => {
          signal.removeEventListener("abort", abort);
          if (signal.aborted) return abort();
          if (position.coords.accuracy > 50) return reject(new Error("現在地の精度が不足しています。屋外で再度お試しください"));
          resolve([position.coords.longitude, position.coords.latitude]);
        }, () => {
          signal.removeEventListener("abort", abort);
          reject(new Error("ルート作成には現在地の利用を許可してください"));
        }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 10000 });
      });
    }

    tilesForArea(area) {
      const coordinates = this.options.flatten(area.geometry.coordinates);
      const bounds = coordinates.reduce((box, point) => [Math.min(box[0], point[0]), Math.min(box[1], point[1]),
        Math.max(box[2], point[0]), Math.max(box[3], point[1])], [Infinity, Infinity, -Infinity, -Infinity]);
      const scale = 2 ** TILE_ZOOM;
      const x = (lng) => Math.floor((lng + 180) / 360 * scale);
      const y = (lat) => Math.floor((1 - Math.asinh(Math.tan(lat * Math.PI / 180)) / Math.PI) / 2 * scale);
      const minX = x(bounds[0]), maxX = x(bounds[2]);
      const minY = y(bounds[3]), maxY = y(bounds[1]);
      if (!coordinates.length || !Number.isFinite(minY) || (maxX - minX + 1) * (maxY - minY + 1) > MAX_TILES) {
        throw new Error("範囲が広すぎます。丁目単位など、もう少し小さい範囲にしてください");
      }
      const tiles = [];
      for (let tx = minX; tx <= maxX; tx++) for (let ty = minY; ty <= maxY; ty++) tiles.push({ x: tx, y: ty });
      return tiles;
    }

    async collectBuildings(area, signal) {
      const tiles = this.tilesForArea(area);
      const libs = await this.dependencies();
      const byId = new Map();
      let next = 0;
      await Promise.all(Array.from({ length: Math.min(4, tiles.length) }, async () => {
        while (next < tiles.length) {
          signal.throwIfAborted();
          const tile = tiles[next++];
          const response = await this.fetchWithTimeout(
            `https://cyberjapandata.gsi.go.jp/xyz/experimental_bvmap/${TILE_ZOOM}/${tile.x}/${tile.y}.pbf`, {}, signal);
          if (!response.ok) throw new Error("範囲全体の建物を取得できませんでした。通信や範囲を確認してください");
          const decoded = new libs.VectorTile(new libs.Pbf(new Uint8Array(await response.arrayBuffer())));
          const layer = decoded.layers.building;
          for (let index = 0; index < (layer?.length || 0); index++) {
            const feature = layer.feature(index).toGeoJSON(tile.x, tile.y, TILE_ZOOM);
            if (!["Polygon", "MultiPolygon"].includes(feature.geometry.type)) continue;
            const point = libs.point(feature).geometry.coordinates;
            // A representative point avoids visiting buildings merely touching the range border.
            if (!this.options.contains(point, area)) continue;
            const id = this.options.hash(feature.geometry);
            if (byId.has(id)) continue;
            const target = { id, point, geometry: feature.geometry };
            if (!this.excluded(target)) byId.set(id, target);
            if (byId.size > MAX_BUILDINGS) throw new Error("建物が多すぎます。範囲を分けて作成してください");
          }
        }
      }));
      Object.values(this.options.getRecords()).filter((record) => record.manual && !record.status).forEach((record) => {
        const point = libs.point({ type: "Feature", properties: {}, geometry: record.geometry }).geometry.coordinates;
        if (this.options.contains(point, area)) byId.set(record.id, { id: record.id, point, geometry: record.geometry });
      });
      if (byId.size > MAX_BUILDINGS) throw new Error("建物が多すぎます。範囲を分けて作成してください");
      return Array.from(byId.values());
    }

    excluded(target) {
      return Object.values(this.options.getRecords()).some((record) => {
        if (!record.status || !record.geometry) return false;
        if (record.id === target.id || this.options.hash(record.geometry) === target.id) return true;
        return this.options.contains(target.point, { type: "Feature", geometry: record.geometry });
      });
    }

    partition(targets, start) {
      const remaining = targets.slice();
      const groups = [];
      let center = start;
      while (remaining.length) {
        remaining.sort((a, b) => this.libs.distance(center, a.point) - this.libs.distance(center, b.point));
        const group = remaining.splice(0, GROUP_SIZE);
        groups.push(group);
        center = group.at(-1).point;
      }
      return groups;
    }

    async toggleRecording() {
      if (this.recording) { this.setRecording(false); this.render(); return; }
      try {
        await this.dependencies();
        if (!this.group()?.path || this.busy) return;
        this.setRecording(true);
        this.options.enableLocation();
        this.setStatus("歩行を記録中（API消費なし）・青:予定 / 緑:歩行済み推定");
        this.render();
      } catch { this.options.toast("歩行記録を準備できませんでした。通信を確認してください"); }
    }

    setRecording(active) {
      const wasRecording = this.recording;
      this.recording = active;
      this.previousFix = null;
      this.els.routeRecordButton.classList.toggle("active", active);
      this.els.routeRecordButton.setAttribute("aria-pressed", String(active));
      this.els.routeRecordButton.textContent = active ? "歩行記録ON" : "歩行記録OFF";
      if (wasRecording && !active) this.save();
      if (wasRecording && !active) this.setStatus("歩行記録を停止しました（API消費なし）");
    }

    onPosition(position) {
      const group = this.group();
      if (!this.recording || !group?.path || !this.libs) return;
      const point = [position.coords.longitude, position.coords.latitude];
      const now = position.timestamp;
      if (!Number.isFinite(position.coords.accuracy) || position.coords.accuracy > 20 || Date.now() - now > 30000) {
        this.previousFix = null;
        this.setStatus("GPS精度を確認中・歩行色の更新を一時停止（API消費なし）"); return;
      }
      const snapped = this.libs.nearest(group.path, point, { units: "meters" });
      if (snapped.properties.dist > 15) { this.previousFix = null; return; }
      const current = { point, time: now, location: snapped.properties.location };
      const previous = this.previousFix;
      if (!previous) { this.previousFix = current; return; }
      const elapsed = (now - previous.time) / 1000;
      const moved = this.libs.distance(previous.point, point, { units: "meters" });
      if (elapsed <= 0) return;
      if (elapsed > 30 || moved / elapsed > 3.5) { this.previousFix = current; return; }
      if (moved < 4) return;
      this.previousFix = current;
      const along = Math.abs(current.location - previous.location);
      if (along < 3 || along > moved * 1.8 + 10) return;
      const midpoint = [(point[0] + previous.point[0]) / 2, (point[1] + previous.point[1]) / 2];
      if (this.libs.nearest(group.path, midpoint, { units: "meters" }).properties.dist > 15) return;
      const walked = this.libs.slice(group.path, Math.min(current.location, previous.location),
        Math.max(current.location, previous.location), { units: "meters" });
      walked.properties = { from: Math.min(current.location, previous.location), to: Math.max(current.location, previous.location) };
      group.walked.push(walked);
      this.mergeWalked(group);
      this.renderMap();
      this.setStatus("歩行を記録中（API消費なし）・青:予定 / 緑:歩行済み推定");
      clearTimeout(this.saveTimer);
      this.saveTimer = setTimeout(() => this.save(), 1000);
    }

    mergeWalked(group) {
      // Merge overlapping observations so walking back and forth does not grow storage.
      const ranges = group.walked.map((feature) => feature.properties).sort((a, b) => a.from - b.from);
      const merged = [];
      for (const range of ranges) {
        const last = merged.at(-1);
        if (last && range.from <= last.to) last.to = Math.max(last.to, range.to);
        else merged.push({ ...range });
      }
      group.walked = merged.map((range) => {
        const feature = this.libs.slice(group.path, range.from, range.to, { units: "meters" });
        feature.properties = range;
        return feature;
      });
    }

    fit() {
      const group = this.group();
      if (!group?.path) return;
      this.options.fit(group.path);
    }

    async clear() {
      if (!this.plan || this.busy || !confirm("保存した徒歩ルートと歩行記録を削除しますか？建物の記録は消えません。")) return;
      this.setRecording(false);
      const previous = this.plan;
      this.plan = null;
      try { await this.save(); }
      catch { this.plan = previous; this.render(); return; }
      this.setStatus("ルートを削除しました（API消費なし）");
      this.render();
    }

    read() {
      return new Promise((resolve, reject) => {
        const tx = this.options.db.transaction(this.options.store, "readonly");
        const request = tx.objectStore(this.options.store).get(STORAGE_KEY);
        tx.oncomplete = () => resolve(request.result || null);
        tx.onerror = tx.onabort = () => reject(tx.error);
      });
    }

    save() {
      clearTimeout(this.saveTimer);
      const value = this.plan ? JSON.parse(JSON.stringify(this.plan)) : null;
      this.saveQueue = this.saveQueue.catch(() => {}).then(() => new Promise((resolve, reject) => {
        const tx = this.options.db.transaction(this.options.store, "readwrite");
        const store = tx.objectStore(this.options.store);
        if (value) store.put(value, STORAGE_KEY);
        else store.delete(STORAGE_KEY);
        tx.oncomplete = resolve;
        tx.onerror = tx.onabort = () => reject(tx.error);
      }));
      this.saveQueue.catch(() => this.options.toast("ルートの保存に失敗しました"));
      return this.saveQueue;
    }
  }

  window.PostingRoutePlanner = PostingRoutePlanner;
})();
