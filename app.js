const state = {
  payload: null,
  view: "opportunities",
  sort: "attention",
  direction: "all",
  timeframe: "all",
  query: "",
  favoritesOnly: false,
  favorites: new Set(JSON.parse(localStorage.getItem("aijiaoyi-favorites") || "[]")),
  live: new Map(),
  socket: null,
};

const els = {
  cards: document.querySelector("#cards"),
  empty: document.querySelector("#empty"),
  notice: document.querySelector("#notice"),
  search: document.querySelector("#search"),
  sort: document.querySelector("#sort"),
  direction: document.querySelector("#direction"),
  timeframe: document.querySelector("#timeframe"),
  favoritesOnly: document.querySelector("#favorites-only"),
  refresh: document.querySelector("#refresh"),
  dialog: document.querySelector("#detail-dialog"),
  dialogContent: document.querySelector("#dialog-content"),
  dialogClose: document.querySelector("#dialog-close"),
  template: document.querySelector("#card-template"),
};

const directionText = { long: "偏多", short: "偏空", neutral: "等待" };

async function loadSnapshot({ silent = false } = {}) {
  try {
    const response = await fetch(`data/latest.json?v=${Date.now()}`, { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    if (payload.schema_version !== 1 || !Array.isArray(payload.markets)) {
      throw new Error("数据格式不兼容");
    }
    state.payload = payload;
    updateSummary();
    updateHealth("snapshot");
    render();
    connectMarketStream();
    if (payload.scan.degraded) showNotice("部分品种本轮获取失败；页面保留已成功覆盖的数据。", true);
    else if (!silent) showNotice("策略快照已更新。", false);
    openLinkedCandidate();
  } catch (error) {
    updateHealth("error");
    showNotice(`快照加载失败：${error.message}。请稍后重试。`, true);
  }
}

function updateSummary() {
  const markets = state.payload.markets;
  const candidates = markets.flatMap((market) => market.candidates || []);
  document.querySelector("#market-count").textContent = markets.length;
  document.querySelector("#candidate-count").textContent = candidates.length;
  document.querySelector("#long-count").textContent = candidates.filter((item) => item.direction === "long").length;
  document.querySelector("#short-count").textContent = candidates.filter((item) => item.direction === "short").length;
  document.querySelector("#scan-count").textContent = state.payload.scan.scanned_count;
  document.querySelector("#disclaimer").textContent = state.payload.disclaimer;
}

function updateHealth(mode) {
  const dot = document.querySelector("#live-dot");
  const status = document.querySelector("#live-status");
  const updated = document.querySelector("#updated-at");
  dot.className = "health-dot";
  if (mode === "live") {
    dot.classList.add("online");
    status.textContent = "实时行情已连接";
  } else if (mode === "error") {
    dot.classList.add("offline");
    status.textContent = "数据连接异常";
  } else {
    status.textContent = "策略快照已加载";
  }
  if (state.payload) updated.textContent = `生成于 ${formatDate(state.payload.generated_at)}`;
}

function showNotice(message, persistent) {
  els.notice.textContent = message;
  els.notice.classList.remove("hidden");
  if (!persistent) window.setTimeout(() => els.notice.classList.add("hidden"), 2400);
}

function render() {
  if (!state.payload) return;
  const markets = state.payload.markets
    .filter(matchesFilters)
    .sort(compareMarkets);
  els.cards.replaceChildren(...markets.map(renderCard));
  els.empty.classList.toggle("hidden", markets.length > 0);
}

function matchesFilters(market) {
  const symbolMatch = market.symbol.toLowerCase().includes(state.query.toLowerCase());
  const favoriteMatch = !state.favoritesOnly || state.favorites.has(market.symbol);
  const candidateMatch = (market.candidates || []).some(candidateMatches);
  const candidateFilterActive = state.direction !== "all" || state.timeframe !== "all";
  const viewMatch = state.view === "opportunities"
    ? candidateMatch
    : !candidateFilterActive || candidateMatch;
  return symbolMatch && favoriteMatch && viewMatch;
}

function candidateMatches(candidate) {
  return (state.direction === "all" || candidate.direction === state.direction)
    && (state.timeframe === "all" || candidate.timeframe === state.timeframe);
}

function visibleCandidates(market) {
  const items = (market.candidates || []).filter(candidateMatches);
  return items.length ? items : state.view === "all" ? [] : items;
}

function compareMarkets(a, b) {
  if (state.sort === "volume") return liveValue(b, "quote_volume", b.quote_volume_24h) - liveValue(a, "quote_volume", a.quote_volume_24h);
  if (state.sort === "change") return Math.abs(liveChange(b)) - Math.abs(liveChange(a));
  const ac = bestCandidate(a);
  const bc = bestCandidate(b);
  if (state.sort === "updated") return (bc?.data_as_of_ms || 0) - (ac?.data_as_of_ms || 0);
  if (state.sort === "score") return (bc?.score || 0) - (ac?.score || 0);
  return attentionValue(bc) - attentionValue(ac)
    || liveValue(b, "quote_volume", b.quote_volume_24h) - liveValue(a, "quote_volume", a.quote_volume_24h);
}

function bestCandidate(market) {
  return [...visibleCandidates(market)].sort((a, b) => attentionValue(b) - attentionValue(a))[0];
}

function attentionValue(candidate) {
  if (!candidate) return 0;
  const importance = candidate.importance.includes("重点") ? 3 : candidate.importance.includes("较高") ? 2 : 1;
  const distance = Number.isFinite(candidate.distance_atr) ? Math.max(0, 3 - candidate.distance_atr) : 0;
  return importance * 1_000_000 + candidate.aligned_timeframes.length * 100_000 + candidate.score * 1_000 + distance * 100;
}

function renderCard(market) {
  const card = els.template.content.firstElementChild.cloneNode(true);
  card.dataset.symbol = market.symbol;
  card.querySelector("h2").textContent = market.display_symbol;
  card.querySelector(".rank").textContent = `成交额排名 #${market.rank}`;
  const favorite = card.querySelector(".favorite-button");
  favorite.textContent = state.favorites.has(market.symbol) ? "★" : "☆";
  favorite.classList.toggle("active", state.favorites.has(market.symbol));
  favorite.addEventListener("click", () => toggleFavorite(market.symbol));
  updateCardTicker(card, market);

  const container = card.querySelector(".candidate-content");
  const candidates = visibleCandidates(market);
  if (!candidates.length) {
    container.innerHTML = `<div class="no-candidate"><strong>当前无有效候选</strong><span>仍在 Top30 观察池中，等待完成K线形成可解释结构。</span></div>`;
    return card;
  }
  container.append(...candidates.slice(0, state.view === "all" ? 1 : 3).map((candidate) => renderCandidate(market, candidate)));
  return card;
}

function renderCandidate(market, candidate) {
  const section = document.createElement("section");
  section.className = "candidate";
  const image = candidate.chart_url
    ? `<div class="candidate-image"><img src="${escapeAttr(candidate.chart_url)}" alt="${escapeAttr(market.display_symbol)} ${escapeAttr(candidate.timeframe)} 价格行为图" loading="lazy"></div>`
    : "";
  section.innerHTML = `${image}<div class="candidate-body">
    <div class="badges">
      <span class="badge ${candidate.direction}">${directionText[candidate.direction] || candidate.direction}</span>
      <span class="badge">${escapeHtml(candidate.timeframe)}</span>
      <span class="badge score">匹配 ${candidate.score}</span>
      <span class="badge importance">${escapeHtml(candidate.importance)}</span>
    </div>
    <h3 class="setup">${escapeHtml(candidate.setup)}</h3>
    <p class="regime">${escapeHtml(candidate.regime)} · ${escapeHtml(candidate.proximity)}</p>
    <div class="levels">
      <div><span>分析价</span><strong>${formatPrice(candidate.analysis_price)}</strong></div>
      <div><span>关注位</span><strong>${formatPrice(candidate.trigger)}</strong></div>
      <div><span>失效位</span><strong>${formatPrice(candidate.invalidation)}</strong></div>
    </div>
    <ul class="reason-list">${candidate.reasons.slice(0, 3).map((reason) => `<li>${escapeHtml(reason)}</li>`).join("")}</ul>
    <p class="missing">还缺：${escapeHtml(candidate.missing_confirmation)}</p>
    <button class="detail-button" type="button">查看完整理由与图形</button>
  </div>`;
  section.querySelector(".detail-button").addEventListener("click", () => openDetail(market, candidate));
  return section;
}

function updateCardTicker(card, market) {
  const price = liveValue(market, "last_price", market.last_price);
  const change = liveChange(market);
  const volume = liveValue(market, "quote_volume", market.quote_volume_24h);
  card.querySelector(".price").textContent = formatPrice(price);
  const changeEl = card.querySelector(".change");
  changeEl.textContent = Number.isFinite(change) ? `${change >= 0 ? "+" : ""}${change.toFixed(2)}%` : "--";
  changeEl.className = `change ${change >= 0 ? "positive" : "negative"}`;
  card.querySelector(".volume").textContent = formatVolume(volume);
}

function liveValue(market, key, fallback) {
  const live = state.live.get(market.symbol);
  return live && Number.isFinite(live[key]) ? live[key] : fallback;
}

function liveChange(market) {
  const live = state.live.get(market.symbol);
  return live && Number.isFinite(live.change_percent) ? live.change_percent : market.change_24h_percent;
}

function connectMarketStream() {
  if (!state.payload || state.socket?.readyState === WebSocket.OPEN) return;
  if (state.socket) state.socket.close();
  const streams = state.payload.markets.map((market) => `${market.symbol.replace("-", "").toLowerCase()}@miniTicker`);
  state.socket = new WebSocket(`wss://fstream.binance.com/stream?streams=${streams.join("/")}`);
  state.socket.addEventListener("open", () => updateHealth("live"));
  state.socket.addEventListener("message", (event) => {
    const payload = JSON.parse(event.data).data || {};
    const raw = String(payload.s || "");
    if (!raw.endsWith("USDT")) return;
    const symbol = `${raw.slice(0, -4)}-USDT`;
    const close = Number(payload.c);
    const open = Number(payload.o);
    state.live.set(symbol, {
      last_price: close,
      quote_volume: Number(payload.q),
      change_percent: open ? ((close - open) / open) * 100 : 0,
    });
    const card = els.cards.querySelector(`[data-symbol="${CSS.escape(symbol)}"]`);
    const market = state.payload.markets.find((item) => item.symbol === symbol);
    if (card && market) updateCardTicker(card, market);
  });
  state.socket.addEventListener("close", () => {
    updateHealth("snapshot");
    window.setTimeout(connectMarketStream, 5000);
  });
  state.socket.addEventListener("error", () => updateHealth("snapshot"));
}

function openDetail(market, candidate) {
  const image = candidate.chart_url ? `<img src="${escapeAttr(candidate.chart_url)}" alt="${escapeAttr(market.display_symbol)} ${escapeAttr(candidate.timeframe)} 完整价格行为图">` : "";
  els.dialogContent.innerHTML = `<article class="dialog-detail">${image}<div class="dialog-copy">
    <h2>${escapeHtml(market.display_symbol)} · ${escapeHtml(candidate.timeframe)} · ${escapeHtml(directionText[candidate.direction])}</h2>
    <p>${escapeHtml(candidate.importance)} · 规则匹配度 ${candidate.score}/100（非胜率）</p>
    <h3>价格行为结构</h3><p>${escapeHtml(candidate.setup)}；${escapeHtml(candidate.regime)}</p>
    <h3>支持理由</h3><ul>${candidate.reasons.map((reason) => `<li>${escapeHtml(reason)}</li>`).join("")}</ul>
    <h3>等待与风险</h3><p>${escapeHtml(candidate.missing_confirmation)}</p>
    <p>关注位 ${formatPrice(candidate.trigger)}；失效位 ${formatPrice(candidate.invalidation)}；${escapeHtml(candidate.proximity)}。</p>
    <p>同向周期：${candidate.aligned_timeframes.map(escapeHtml).join(" / ") || "当前周期"}。完成K线：${formatDate(candidate.data_as_of_ms)}。</p>
  </div></article>`;
  const url = new URL(location.href);
  url.searchParams.set("symbol", market.symbol);
  url.searchParams.set("timeframe", candidate.timeframe);
  history.replaceState(null, "", url);
  els.dialog.showModal();
}

function openLinkedCandidate() {
  const params = new URLSearchParams(location.search);
  const symbol = params.get("symbol");
  const timeframe = params.get("timeframe");
  if (!symbol || !timeframe || els.dialog.open) return;
  const market = state.payload.markets.find((item) => item.symbol === symbol);
  const candidate = market?.candidates.find((item) => item.timeframe === timeframe);
  if (market && candidate) openDetail(market, candidate);
}

function closeDetail() {
  els.dialog.close();
  const url = new URL(location.href);
  url.searchParams.delete("symbol");
  url.searchParams.delete("timeframe");
  history.replaceState(null, "", url);
}

function toggleFavorite(symbol) {
  if (state.favorites.has(symbol)) state.favorites.delete(symbol);
  else state.favorites.add(symbol);
  localStorage.setItem("aijiaoyi-favorites", JSON.stringify([...state.favorites]));
  render();
}

function formatPrice(value) {
  if (!Number.isFinite(value)) return "--";
  const digits = value >= 1000 ? 2 : value >= 1 ? 4 : 6;
  return value.toLocaleString("zh-CN", { maximumFractionDigits: digits });
}

function formatVolume(value) {
  if (!Number.isFinite(value)) return "--";
  if (value >= 1e9) return `${(value / 1e9).toFixed(2)}B USDT`;
  if (value >= 1e6) return `${(value / 1e6).toFixed(1)}M USDT`;
  return `${value.toLocaleString("zh-CN", { maximumFractionDigits: 0 })} USDT`;
}

function formatDate(value) {
  const date = typeof value === "number" ? new Date(value) : new Date(value);
  return Number.isNaN(date.getTime()) ? "--" : new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  }).format(date);
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[char]));
}

function escapeAttr(value) { return escapeHtml(value); }

document.querySelectorAll(".tab").forEach((button) => button.addEventListener("click", () => {
  document.querySelectorAll(".tab").forEach((item) => item.classList.toggle("active", item === button));
  state.view = button.dataset.view;
  render();
}));
els.search.addEventListener("input", () => { state.query = els.search.value.trim(); render(); });
els.sort.addEventListener("change", () => { state.sort = els.sort.value; render(); });
els.direction.addEventListener("change", () => { state.direction = els.direction.value; render(); });
els.timeframe.addEventListener("change", () => { state.timeframe = els.timeframe.value; render(); });
els.favoritesOnly.addEventListener("change", () => { state.favoritesOnly = els.favoritesOnly.checked; render(); });
els.refresh.addEventListener("click", () => loadSnapshot());
els.dialogClose.addEventListener("click", closeDetail);
els.dialog.addEventListener("click", (event) => { if (event.target === els.dialog) closeDetail(); });
window.setInterval(() => loadSnapshot({ silent: true }), 60_000);

loadSnapshot();
