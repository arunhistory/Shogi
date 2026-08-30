var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// ../src/game/handicaps.ts
var HANDICAP_RULES = {
  even: { id: "even", label: "\u5E73\u624B", firstTurn: "sente", removedFromGote: [] },
  rook: { id: "rook", label: "\u98DB\u8ECA\u843D\u3061", firstTurn: "gote", removedFromGote: ["rook"] },
  bishop: { id: "bishop", label: "\u89D2\u843D\u3061", firstTurn: "gote", removedFromGote: ["bishop"] },
  two: { id: "two", label: "2\u679A\u843D\u3061", firstTurn: "gote", removedFromGote: ["rook", "bishop"] },
  four: { id: "four", label: "4\u679A\u843D\u3061", firstTurn: "gote", removedFromGote: ["rook", "bishop", "lance", "lance"] },
  six: { id: "six", label: "6\u679A\u843D\u3061", firstTurn: "gote", removedFromGote: ["rook", "bishop", "lance", "lance", "knight", "knight"] }
};
var HANDICAP_RULE_LIST = Object.freeze([
  HANDICAP_RULES.even,
  HANDICAP_RULES.rook,
  HANDICAP_RULES.bishop,
  HANDICAP_RULES.two,
  HANDICAP_RULES.four,
  HANDICAP_RULES.six
]);
function isHandicap(value) {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(HANDICAP_RULES, value);
}
__name(isHandicap, "isHandicap");
function handicapRule(handicap) {
  return HANDICAP_RULES[handicap];
}
__name(handicapRule, "handicapRule");

// ../src/game/position-key.ts
var version = "v1";
var boardKinds = [
  "pawn",
  "lance",
  "knight",
  "silver",
  "gold",
  "bishop",
  "rook",
  "king",
  "tokin",
  "promotedLance",
  "promotedKnight",
  "promotedSilver",
  "horse",
  "dragon"
];
var handKinds = ["king", "rook", "bishop", "gold", "silver", "knight", "lance", "pawn"];
var kindIndex = new Map(boardKinds.map((kind, index) => [kind, index]));
function encodeSquare(piece) {
  if (piece === null) return ".";
  const index = kindIndex.get(piece.kind);
  if (index === void 0) throw new Error("INVALID_POSITION_KEY_PIECE");
  const base = piece.side === "sente" ? 65 : 97;
  if (piece.side !== "sente" && piece.side !== "gote") throw new Error("INVALID_POSITION_KEY_SIDE");
  return String.fromCharCode(base + index);
}
__name(encodeSquare, "encodeSquare");
function encodeHand(hands, side) {
  return handKinds.map((kind) => {
    const count = hands?.[side]?.[kind];
    if (!Number.isSafeInteger(count) || count < 0 || count > 40) throw new Error("INVALID_POSITION_KEY_HAND");
    return count.toString(36);
  }).join(",");
}
__name(encodeHand, "encodeHand");
function encodePositionKey(position) {
  if (position.turn !== "sente" && position.turn !== "gote") throw new Error("INVALID_POSITION_KEY_TURN");
  if (!Array.isArray(position.board) || position.board.length !== 9 || !position.board.every((row) => Array.isArray(row) && row.length === 9)) throw new Error("INVALID_POSITION_KEY_BOARD");
  const board = position.board.flatMap((row) => row.map(encodeSquare)).join("");
  return `${version}|${position.turn === "sente" ? "S" : "G"}|${board}|${encodeHand(position.hands, "sente")}|${encodeHand(position.hands, "gote")}`;
}
__name(encodePositionKey, "encodePositionKey");

// ../src/game/engine.ts
var baseKinds = ["king", "rook", "bishop", "gold", "silver", "knight", "lance", "pawn"];
var promoteMap = { rook: "dragon", bishop: "horse", silver: "promotedSilver", knight: "promotedKnight", lance: "promotedLance", pawn: "tokin" };
var unpromoteMap = { king: "king", rook: "rook", bishop: "bishop", gold: "gold", silver: "silver", knight: "knight", lance: "lance", pawn: "pawn", dragon: "rook", horse: "bishop", promotedSilver: "silver", promotedKnight: "knight", promotedLance: "lance", tokin: "pawn" };
var emptyHands = /* @__PURE__ */ __name(() => ({
  sente: Object.fromEntries(baseKinds.map((k) => [k, 0])),
  gote: Object.fromEntries(baseKinds.map((k) => [k, 0]))
}), "emptyHands");
var p = /* @__PURE__ */ __name((side, kind) => ({ side, kind }), "p");
var enemy = /* @__PURE__ */ __name((s) => s === "sente" ? "gote" : "sente", "enemy");
var inside = /* @__PURE__ */ __name((y, x) => y >= 0 && y < 9 && x < 9 && x >= 0, "inside");
var zone = /* @__PURE__ */ __name((side, y) => side === "sente" ? y <= 2 : y >= 6, "zone");
var goldDirs = [[-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, 0]];
function positionKey(pos) {
  return encodePositionKey(pos);
}
__name(positionKey, "positionKey");
function initialPosition(handicap = "even") {
  const board = Array.from({ length: 9 }, () => Array(9).fill(null));
  const back = ["lance", "knight", "silver", "gold", "king", "gold", "silver", "knight", "lance"];
  for (let x = 0; x < 9; x++) {
    board[0][x] = p("gote", back[8 - x]);
    board[8][x] = p("sente", back[x]);
    board[2][x] = p("gote", "pawn");
    board[6][x] = p("sente", "pawn");
  }
  board[1][1] = p("gote", "rook");
  board[1][7] = p("gote", "bishop");
  board[7][1] = p("sente", "bishop");
  board[7][7] = p("sente", "rook");
  const remove = /* @__PURE__ */ __name((kind) => {
    for (let y = 0; y < 9; y++) for (let x = 0; x < 9; x++) {
      if (board[y][x]?.side === "gote" && board[y][x]?.kind === kind) {
        board[y][x] = null;
        return;
      }
    }
  }, "remove");
  const rule = handicapRule(handicap);
  for (const kind of rule.removedFromGote) remove(kind);
  const position = { board, hands: emptyHands(), turn: rule.firstTurn, ply: 0, history: [] };
  position.history.push({ key: positionKey(position), mover: null, gaveCheck: false });
  return position;
}
__name(initialPosition, "initialPosition");
function dirs(piece) {
  const f = piece.side === "sente" ? -1 : 1;
  const k = piece.kind;
  if (k === "king") return { step: [[-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, -1], [1, 0], [1, 1]], slide: [] };
  if (k === "gold" || ["promotedSilver", "promotedKnight", "promotedLance", "tokin"].includes(k)) {
    return { step: goldDirs.map(([dy, dx]) => [dy * (piece.side === "sente" ? 1 : -1), dx]), slide: [] };
  }
  if (k === "silver") return { step: [[f, -1], [f, 0], [f, 1], [-f, -1], [-f, 1]], slide: [] };
  if (k === "knight") return { step: [[2 * f, -1], [2 * f, 1]], slide: [] };
  if (k === "lance") return { step: [], slide: [[f, 0]] };
  if (k === "pawn") return { step: [[f, 0]], slide: [] };
  if (k === "rook") return { step: [], slide: [[-1, 0], [1, 0], [0, -1], [0, 1]] };
  if (k === "bishop") return { step: [], slide: [[-1, -1], [-1, 1], [1, -1], [1, 1]] };
  if (k === "dragon") return { step: [[-1, -1], [-1, 1], [1, -1], [1, 1]], slide: [[-1, 0], [1, 0], [0, -1], [0, 1]] };
  return { step: [[-1, 0], [1, 0], [0, -1], [0, 1]], slide: [[-1, -1], [-1, 1], [1, -1], [1, 1]] };
}
__name(dirs, "dirs");
function pseudoTargets(pos, y, x) {
  const piece = pos.board[y]?.[x];
  if (!piece) return [];
  const out = [];
  const d = dirs(piece);
  for (const [dy, dx] of d.step) {
    const ny = y + dy, nx = x + dx;
    if (inside(ny, nx) && pos.board[ny][nx]?.side !== piece.side) out.push([ny, nx]);
  }
  for (const [dy, dx] of d.slide) {
    let ny = y + dy, nx = x + dx;
    while (inside(ny, nx)) {
      const q = pos.board[ny][nx];
      if (!q) out.push([ny, nx]);
      else {
        if (q.side !== piece.side) out.push([ny, nx]);
        break;
      }
      ny += dy;
      nx += dx;
    }
  }
  return out;
}
__name(pseudoTargets, "pseudoTargets");
function isCheck(pos, side) {
  let king = null;
  for (let y = 0; y < 9; y++) for (let x = 0; x < 9; x++) {
    const q = pos.board[y][x];
    if (q?.side === side && q.kind === "king") king = [y, x];
  }
  if (!king) return true;
  for (let y = 0; y < 9; y++) for (let x = 0; x < 9; x++) {
    const q = pos.board[y][x];
    if (q?.side === enemy(side) && pseudoTargets(pos, y, x).some(([a, b]) => a === king[0] && b === king[1])) return true;
  }
  return false;
}
__name(isCheck, "isCheck");
function mustPromote(kind, side, y) {
  return (kind === "pawn" || kind === "lance") && (side === "sente" ? y === 0 : y === 8) || kind === "knight" && (side === "sente" ? y <= 1 : y >= 7);
}
__name(mustPromote, "mustPromote");
function rawApply(pos, m) {
  const mover = pos.turn;
  const next = {
    board: pos.board.map((r) => r.map((q) => q ? { ...q } : null)),
    hands: { sente: { ...pos.hands.sente }, gote: { ...pos.hands.gote } },
    turn: enemy(pos.turn),
    ply: pos.ply + 1,
    history: [...pos.history]
  };
  if (m.drop) {
    next.board[m.to[0]][m.to[1]] = { side: mover, kind: m.drop };
    next.hands[mover][m.drop]--;
  } else if (m.from) {
    const [fy, fx] = m.from;
    let piece = next.board[fy][fx];
    const captured = next.board[m.to[0]][m.to[1]];
    if (captured) next.hands[mover][unpromoteMap[captured.kind]]++;
    next.board[fy][fx] = null;
    if (m.promote && promoteMap[unpromoteMap[piece.kind]]) {
      piece = { ...piece, kind: promoteMap[unpromoteMap[piece.kind]] };
    }
    next.board[m.to[0]][m.to[1]] = piece;
  }
  next.history.push({ key: positionKey(next), mover, gaveCheck: isCheck(next, next.turn) });
  return next;
}
__name(rawApply, "rawApply");
function legalDropBase(pos, kind, y, x) {
  if (pos.board[y][x] || pos.hands[pos.turn][kind] <= 0) return false;
  if ((kind === "pawn" || kind === "lance") && (pos.turn === "sente" ? y === 0 : y === 8)) return false;
  if (kind === "knight" && (pos.turn === "sente" ? y <= 1 : y >= 7)) return false;
  if (kind === "pawn") {
    for (let yy = 0; yy < 9; yy++) {
      const q = pos.board[yy][x];
      if (q?.side === pos.turn && q.kind === "pawn") return false;
    }
  }
  return true;
}
__name(legalDropBase, "legalDropBase");
function legalMovesInternal(pos) {
  const out = [];
  for (let y = 0; y < 9; y++) for (let x = 0; x < 9; x++) {
    const piece = pos.board[y][x];
    if (piece?.side !== pos.turn) continue;
    for (const to of pseudoTargets(pos, y, x)) {
      if (pos.board[to[0]][to[1]]?.kind === "king") continue;
      const base = unpromoteMap[piece.kind];
      const canPromote = !!promoteMap[base] && piece.kind === base && (zone(piece.side, y) || zone(piece.side, to[0]));
      const forced = mustPromote(base, piece.side, to[0]);
      const variants = forced ? [{ from: [y, x], to, promote: true }] : canPromote ? [{ from: [y, x], to }, { from: [y, x], to, promote: true }] : [{ from: [y, x], to }];
      for (const move of variants) {
        if (!isCheck(rawApply(pos, move), piece.side)) out.push(move);
      }
    }
  }
  for (const kind of baseKinds.filter((k) => k !== "king")) {
    if (pos.hands[pos.turn][kind] <= 0) continue;
    for (let y = 0; y < 9; y++) for (let x = 0; x < 9; x++) {
      if (!legalDropBase(pos, kind, y, x)) continue;
      const move = { drop: kind, to: [y, x] };
      const next = rawApply(pos, move);
      if (isCheck(next, pos.turn)) continue;
      if (kind === "pawn" && isCheck(next, next.turn) && legalMovesInternal(next).length === 0) continue;
      out.push(move);
    }
  }
  return out;
}
__name(legalMovesInternal, "legalMovesInternal");
function legalMoves(pos) {
  return legalMovesInternal(pos);
}
__name(legalMoves, "legalMoves");
function moveEquals(a, b) {
  return a.to[0] === b.to[0] && a.to[1] === b.to[1] && a.from?.[0] === b.from?.[0] && a.from?.[1] === b.from?.[1] && a.drop === b.drop && !!a.promote === !!b.promote;
}
__name(moveEquals, "moveEquals");
function applyMove(pos, m) {
  if (gameOutcome(pos).ended) throw new Error("GAME_ENDED");
  const legal = legalMoves(pos).find((candidate) => moveEquals(candidate, m));
  if (!legal) throw new Error("ILLEGAL_MOVE");
  return rawApply(pos, legal);
}
__name(applyMove, "applyMove");
function isMate(pos) {
  return isCheck(pos, pos.turn) && legalMoves(pos).length === 0;
}
__name(isMate, "isMate");
function repetitionStatus(pos) {
  const key = positionKey(pos);
  const occurrences = [];
  pos.history.forEach((entry, index) => {
    if (entry.key === key) occurrences.push(index);
  });
  if (occurrences.length < 4) return { kind: "none" };
  const lastFour = occurrences.slice(-4);
  const start = lastFour[0];
  const end = lastFour[3];
  for (const side of ["sente", "gote"]) {
    const moves = pos.history.slice(start + 1, end + 1).filter((entry) => entry.mover === side);
    if (moves.length > 0 && moves.every((entry) => entry.gaveCheck)) return { kind: "perpetual-check", loser: side };
  }
  return { kind: "normal" };
}
__name(repetitionStatus, "repetitionStatus");
function gameOutcome(pos) {
  if (isMate(pos)) return { ended: true, reason: "mate", winner: enemy(pos.turn), loser: pos.turn };
  const repetition = repetitionStatus(pos);
  if (repetition.kind === "normal") return { ended: true, reason: "repetition", draw: true };
  if (repetition.kind === "perpetual-check") return {
    ended: true,
    reason: "perpetual-check",
    winner: enemy(repetition.loser),
    loser: repetition.loser
  };
  return { ended: false };
}
__name(gameOutcome, "gameOutcome");

// ../src/game/setup.ts
var EVEN_HANDICAPS = Object.freeze({ sente: "even", gote: "even" });
function isOrderPreference(value) {
  return value === "random" || value === "sente" || value === "gote";
}
__name(isOrderPreference, "isOrderPreference");
function isSide(value) {
  return value === "sente" || value === "gote";
}
__name(isSide, "isSide");
function handicapPairFromLegacy(handicap = "even", handicapSide = "gote") {
  return handicapSide === "sente" ? { sente: handicap, gote: "even" } : { sente: "even", gote: handicap };
}
__name(handicapPairFromLegacy, "handicapPairFromLegacy");
function configuredInitialPosition(handicapsOrLegacy = EVEN_HANDICAPS, legacySide = "gote") {
  const handicaps2 = typeof handicapsOrLegacy === "string" ? handicapPairFromLegacy(handicapsOrLegacy, legacySide) : handicapsOrLegacy;
  const position = initialPosition("even");
  const remove = /* @__PURE__ */ __name((side, kind) => {
    for (let y = 0; y < 9; y++) for (let x = 0; x < 9; x++) {
      const piece = position.board[y][x];
      if (piece?.side === side && piece.kind === kind) {
        position.board[y][x] = null;
        return;
      }
    }
  }, "remove");
  for (const side of ["sente", "gote"]) {
    for (const kind of handicapRule(handicaps2[side]).removedFromGote) remove(side, kind);
  }
  position.turn = "sente";
  position.ply = 0;
  position.history = [];
  position.history.push({ key: positionKey(position), mover: null, gaveCheck: false });
  return position;
}
__name(configuredInitialPosition, "configuredInitialPosition");

// src/runtime/common.ts
var jsonHeaders = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
var passcodeAlphabet = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
var handicaps = new Set(HANDICAP_RULE_LIST.map((rule) => rule.id));
var contentKeys = /* @__PURE__ */ new Set(["terms", "credits", "licenses"]);
var roomIdPattern = /^[A-Za-z0-9_-]{16,128}$/;
var requestIdPattern = /^[A-Za-z0-9_-]{8,128}$/;
function responseJson(value, status = 200, extra = {}) {
  return new Response(JSON.stringify(value), { status, headers: { ...jsonHeaders, ...extra } });
}
__name(responseJson, "responseJson");
function errorJson(code, status = 400, extra = {}) {
  return responseJson({ ok: false, code }, status, extra);
}
__name(errorJson, "errorJson");
function directoryStub(env) {
  return env.DIRECTORY.get(env.DIRECTORY.idFromName("shogi-directory-v2"));
}
__name(directoryStub, "directoryStub");
function contentStub(env) {
  return env.CONTENT.get(env.CONTENT.idFromName("shogi-content-v1"));
}
__name(contentStub, "contentStub");
function roomStub(env, roomId) {
  return env.ROOMS.get(env.ROOMS.idFromName(roomId));
}
__name(roomStub, "roomStub");
function randomToken(bytes) {
  const data = new Uint8Array(bytes);
  crypto.getRandomValues(data);
  let binary = "";
  for (const byte of data) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
__name(randomToken, "randomToken");
function randomPasscode(length = 8) {
  const data = new Uint8Array(length);
  crypto.getRandomValues(data);
  let out = "";
  for (const byte of data) out += passcodeAlphabet[byte % passcodeAlphabet.length];
  return out;
}
__name(randomPasscode, "randomPasscode");
function randomSide() {
  const data = new Uint8Array(1);
  crypto.getRandomValues(data);
  return (data[0] & 1) === 0 ? "sente" : "gote";
}
__name(randomSide, "randomSide");
function oppositeSide(side) {
  return side === "sente" ? "gote" : "sente";
}
__name(oppositeSide, "oppositeSide");
async function sha256(value) {
  const bytes = new TextEncoder().encode(value);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
__name(sha256, "sha256");
function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
__name(safeEqual, "safeEqual");
async function readJson(request, maxBytes = 16384) {
  const length = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(length) && length > maxBytes) throw new Error("BODY_TOO_LARGE");
  const text = await request.text();
  if (text.length > maxBytes) throw new Error("BODY_TOO_LARGE");
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("INVALID_JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("INVALID_JSON_OBJECT");
  return value;
}
__name(readJson, "readJson");
function requestId(value) {
  if (typeof value !== "string" || !requestIdPattern.test(value)) throw new Error("INVALID_REQUEST_ID");
  return value;
}
__name(requestId, "requestId");
function parseHandicap(value) {
  if (!isHandicap(value)) throw new Error("INVALID_HANDICAP");
  return value;
}
__name(parseHandicap, "parseHandicap");
function parseSide(value) {
  if (!isSide(value)) throw new Error("INVALID_SIDE");
  return value;
}
__name(parseSide, "parseSide");
function parseOrder(value) {
  if (!isOrderPreference(value)) throw new Error("INVALID_ORDER");
  return value;
}
__name(parseOrder, "parseOrder");
function normalizeHandicaps(value) {
  if (isHandicap(value.senteHandicap) && isHandicap(value.goteHandicap)) return { sente: value.senteHandicap, gote: value.goteHandicap };
  const handicap = isHandicap(value.handicap) ? value.handicap : "even";
  const side = isSide(value.handicapSide) ? value.handicapSide : "gote";
  return handicapPairFromLegacy(handicap, side);
}
__name(normalizeHandicaps, "normalizeHandicaps");
function legacyHandicapProjection(handicapsValue) {
  if (handicapsValue.gote !== "even") return { handicap: handicapsValue.gote, handicapSide: "gote" };
  if (handicapsValue.sente !== "even") return { handicap: handicapsValue.sente, handicapSide: "sente" };
  return { handicap: "even", handicapSide: "gote" };
}
__name(legacyHandicapProjection, "legacyHandicapProjection");
function normalizeOrder(state) {
  return isOrderPreference(state.order) ? state.order : "sente";
}
__name(normalizeOrder, "normalizeOrder");
function normalizeCreatorSide(state) {
  return isSide(state.creatorSide) ? state.creatorSide : "sente";
}
__name(normalizeCreatorSide, "normalizeCreatorSide");
function parseMove(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("INVALID_MOVE");
  const data = value;
  const to = parseSquare(data.to);
  const promote = data.promote === true;
  if (data.drop !== void 0) {
    if (promote) throw new Error("INVALID_MOVE");
    if (typeof data.drop !== "string" || !["rook", "bishop", "gold", "silver", "knight", "lance", "pawn"].includes(data.drop)) throw new Error("INVALID_MOVE");
    return { drop: data.drop, to };
  }
  const from = parseSquare(data.from);
  return { from, to, ...promote ? { promote: true } : {} };
}
__name(parseMove, "parseMove");
function parseSquare(value) {
  if (!Array.isArray(value) || value.length !== 2) throw new Error("INVALID_SQUARE");
  const y = Number(value[0]), x = Number(value[1]);
  if (!Number.isInteger(y) || !Number.isInteger(x) || y < 0 || y > 8 || x < 0 || x > 8) throw new Error("INVALID_SQUARE");
  return [y, x];
}
__name(parseSquare, "parseSquare");
function moveFingerprint(move) {
  if (move.drop) return `d:${move.drop}:${move.to[0]},${move.to[1]}`;
  return `m:${move.from[0]},${move.from[1]}:${move.to[0]},${move.to[1]}:${move.promote ? 1 : 0}`;
}
__name(moveFingerprint, "moveFingerprint");
function corsHeaders(request, env) {
  const origin = request.headers.get("origin");
  if (origin === env.APP_ORIGIN) {
    return {
      "access-control-allow-origin": origin,
      "access-control-allow-methods": "GET,POST,OPTIONS",
      "access-control-allow-headers": "content-type",
      "access-control-max-age": "600",
      "vary": "Origin"
    };
  }
  return {};
}
__name(corsHeaders, "corsHeaders");
function hasExpectedOrigin(request, env) {
  return request.headers.get("origin") === env.APP_ORIGIN;
}
__name(hasExpectedOrigin, "hasExpectedOrigin");
function clientIp(request) {
  return request.headers.get("cf-connecting-ip")?.trim() || "unknown";
}
__name(clientIp, "clientIp");
function asInternalRequest(path, body, request) {
  return new Request(`https://internal${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-client-ip": clientIp(request) },
    body: JSON.stringify(body)
  });
}
__name(asInternalRequest, "asInternalRequest");
function validateAppUrl(value) {
  if (typeof value !== "string") throw new Error("INVALID_APP_URL");
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("INVALID_APP_URL");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.hash) throw new Error("INVALID_APP_URL");
  return url.toString();
}
__name(validateAppUrl, "validateAppUrl");
function inviteUrl(appUrl, inviteToken) {
  const url = new URL(appUrl);
  url.searchParams.set("invite", inviteToken);
  return url.toString();
}
__name(inviteUrl, "inviteUrl");

// src/runtime/socket-auth.ts
var websocketProtocol = "shogi-v1";
var playerTokenPattern = /^[A-Za-z0-9_-]{32,128}$/;
function websocketPlayerToken(headers) {
  const raw = headers.get("sec-websocket-protocol") ?? "";
  if (raw.length === 0 || raw.length > 512) return null;
  const protocols = raw.split(",").map((value) => value.trim()).filter(Boolean);
  if (protocols.length !== 2 || !protocols.includes(websocketProtocol)) return null;
  const playerProtocols = protocols.filter((value) => value.startsWith("player."));
  if (playerProtocols.length !== 1) return null;
  const token = playerProtocols[0].slice("player.".length);
  return playerTokenPattern.test(token) ? token : null;
}
__name(websocketPlayerToken, "websocketPlayerToken");

// src/runtime/directory.ts
import { DurableObject } from "cloudflare:workers";
function normalizeCreateOperation(operation) {
  const stored = operation;
  const handicapsValue = normalizeHandicaps(operation);
  const legacy = legacyHandicapProjection(handicapsValue);
  return {
    ...operation,
    senteHandicap: handicapsValue.sente,
    goteHandicap: handicapsValue.gote,
    handicap: legacy.handicap,
    handicapSide: legacy.handicapSide,
    order: isOrderPreference(stored.order) ? stored.order : "sente",
    creatorSide: isSide(stored.creatorSide) ? stored.creatorSide : "sente"
  };
}
__name(normalizeCreateOperation, "normalizeCreateOperation");
function parseRequestedHandicaps(body) {
  const hasSente = body.senteHandicap !== void 0;
  const hasGote = body.goteHandicap !== void 0;
  if (hasSente || hasGote) {
    if (!hasSente || !hasGote) throw new Error("INCOMPLETE_HANDICAP_PAIR");
    if (body.handicap !== void 0 || body.handicapSide !== void 0 || body.handicapTarget !== void 0) throw new Error("AMBIGUOUS_HANDICAP_RULES");
    return { sente: parseHandicap(body.senteHandicap), gote: parseHandicap(body.goteHandicap) };
  }
  if (body.handicapTarget !== void 0) throw new Error("HANDICAP_TARGET_OBSOLETE");
  const handicap = body.handicap === void 0 ? "even" : parseHandicap(body.handicap);
  const side = body.handicapSide === void 0 ? "gote" : parseSide(body.handicapSide);
  return side === "sente" ? { sente: handicap, gote: "even" } : { sente: "even", gote: handicap };
}
__name(parseRequestedHandicaps, "parseRequestedHandicaps");
var ShogiDirectory = class extends DurableObject {
  static {
    __name(this, "ShogiDirectory");
  }
  gate = Promise.resolve();
  identityKey = null;
  constructor(ctx, env) {
    super(ctx, env);
  }
  async fetch(request) {
    if (request.method !== "POST") return errorJson("METHOD_NOT_ALLOWED", 405);
    return this.exclusive(async () => {
      const url = new URL(request.url);
      try {
        const body = await readJson(request);
        const ip = request.headers.get("x-client-ip") ?? "unknown";
        if (url.pathname === "/create") return await this.create(body, ip);
        if (url.pathname === "/join-passcode") return await this.join(body, ip, "passcode");
        if (url.pathname === "/join-invite") return await this.join(body, ip, "invite");
        return errorJson("NOT_FOUND", 404);
      } catch (error) {
        return errorJson(error instanceof Error ? error.message : "INVALID_REQUEST", 400);
      }
    });
  }
  async exclusive(operation) {
    const previous = this.gate;
    let release;
    this.gate = new Promise((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
  async getIdentityKey() {
    if (this.identityKey) return this.identityKey;
    let secret = await this.ctx.storage.get("identity-secret:v1");
    if (!secret) {
      secret = randomToken(32);
      await this.ctx.storage.put("identity-secret:v1", secret);
    }
    this.identityKey = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    return this.identityKey;
  }
  async derivePlayerToken(scope) {
    const signature = new Uint8Array(await crypto.subtle.sign("HMAC", await this.getIdentityKey(), new TextEncoder().encode(scope)));
    return encodeBase64Url(signature);
  }
  async enforceRateLimit(ip, scope) {
    const bucket = Math.floor(Date.now() / 6e4);
    const ipHash = await sha256(ip);
    const key = `rate:${scope}:${ipHash}:${bucket}`;
    const count = await this.ctx.storage.get(key) ?? 0;
    const limit = scope === "create" ? 12 : 40;
    if (count >= limit) throw new Error("RATE_LIMITED");
    await this.ctx.storage.put(key, count + 1);
    await this.ctx.storage.delete(`rate:${scope}:${ipHash}:${bucket - 2}`);
  }
  async allocatePasscode(opKey) {
    for (let attempt = 0; attempt < 32; attempt++) {
      const candidate = randomPasscode();
      const [mapped, reserved] = await Promise.all([
        this.ctx.storage.get(`pass:${candidate}`),
        this.ctx.storage.get(`reserve-pass:${candidate}`)
      ]);
      if (!mapped && !reserved) {
        await this.ctx.storage.put(`reserve-pass:${candidate}`, opKey);
        return candidate;
      }
    }
    throw new Error("PASSCODE_ALLOCATION_FAILED");
  }
  async create(body, ip) {
    const id = requestId(body.requestId);
    const handicapsValue = parseRequestedHandicaps(body);
    const order = body.order === void 0 ? "sente" : parseOrder(body.order);
    const appUrl = validateAppUrl(body.appUrl);
    const opKey = `create:${id}`;
    const stored = await this.ctx.storage.get(opKey);
    if (stored) {
      const existing = normalizeCreateOperation(stored);
      if (existing.kind !== "create" || existing.requestId !== id || existing.senteHandicap !== handicapsValue.sente || existing.goteHandicap !== handicapsValue.gote || existing.order !== order || existing.appUrl !== appUrl) return errorJson("REQUEST_ID_CONFLICT", 409);
      return await this.resumeCreate(opKey, existing);
    }
    await this.enforceRateLimit(ip, "create");
    const passcode = await this.allocatePasscode(opKey);
    const creatorSide = order === "random" ? randomSide() : order;
    const legacy = legacyHandicapProjection(handicapsValue);
    const operation = {
      kind: "create",
      phase: "pending",
      requestId: id,
      senteHandicap: handicapsValue.sente,
      goteHandicap: handicapsValue.gote,
      handicap: legacy.handicap,
      handicapSide: legacy.handicapSide,
      order,
      creatorSide,
      appUrl,
      roomId: randomToken(18),
      inviteToken: randomToken(24),
      passcode
    };
    await this.ctx.storage.put(opKey, operation);
    return await this.resumeCreate(opKey, operation);
  }
  async resumeCreate(opKey, rawOperation) {
    const operation = normalizeCreateOperation(rawOperation);
    const legacyIdentity = !isSide(rawOperation.creatorSide);
    const tokenScope = legacyIdentity ? `sente:${operation.requestId}:${operation.roomId}` : `creator:${operation.requestId}:${operation.roomId}`;
    const playerToken = await this.derivePlayerToken(tokenScope);
    const creatorTokenHash = await sha256(playerToken);
    const init = await this.env.ROOMS.get(this.env.ROOMS.idFromName(operation.roomId)).fetch(new Request("https://internal/init", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        roomId: operation.roomId,
        senteHandicap: operation.senteHandicap,
        goteHandicap: operation.goteHandicap,
        handicap: operation.handicap,
        handicapSide: operation.handicapSide,
        order: operation.order,
        creatorSide: operation.creatorSide,
        creatorTokenHash,
        creationRequestId: operation.requestId
      })
    }));
    if (!init.ok) return new Response(init.body, { status: init.status, headers: jsonHeaders });
    const room = await init.json();
    const done = { ...operation, phase: "done" };
    await this.ctx.storage.put({
      [`pass:${operation.passcode}`]: operation.roomId,
      [`invite:${operation.inviteToken}`]: operation.roomId,
      [`room-pass:${operation.roomId}`]: operation.passcode,
      [`room-invite:${operation.roomId}`]: operation.inviteToken,
      [opKey]: done
    });
    await this.ctx.storage.delete(`reserve-pass:${operation.passcode}`);
    const result = {
      roomId: operation.roomId,
      inviteUrl: inviteUrl(operation.appUrl, operation.inviteToken),
      passcode: operation.passcode,
      playerToken,
      seat: operation.creatorSide,
      revision: room.revision,
      senteHandicap: operation.senteHandicap,
      goteHandicap: operation.goteHandicap,
      handicap: operation.handicap,
      handicapSide: operation.handicapSide,
      order: operation.order
    };
    return responseJson(result);
  }
  async join(body, ip, method) {
    const id = requestId(body.requestId);
    const appUrl = validateAppUrl(body.appUrl);
    const credential = method === "passcode" ? String(body.passcode ?? "").trim().toUpperCase() : String(body.inviteToken ?? "").trim();
    if (method === "passcode" && (credential.length !== 8 || ![...credential].every((char) => passcodeAlphabet.includes(char)))) throw new Error("INVALID_PASSCODE");
    if (method === "invite" && !/^[A-Za-z0-9_-]{24,128}$/.test(credential)) throw new Error("INVALID_INVITE");
    const opKey = `join:${method}:${id}`;
    const existing = await this.ctx.storage.get(opKey);
    if (existing) {
      if (existing.kind !== "join" || existing.method !== method || existing.requestId !== id || existing.credential !== credential || existing.appUrl !== appUrl) return errorJson("REQUEST_ID_CONFLICT", 409);
      return await this.resumeJoin(opKey, existing);
    }
    await this.enforceRateLimit(ip, "join");
    const lookup = method === "passcode" ? `pass:${credential}` : `invite:${credential}`;
    const roomId = await this.ctx.storage.get(lookup);
    if (!roomId) return errorJson(method === "passcode" ? "PASSCODE_NOT_FOUND" : "INVITE_NOT_FOUND", 404);
    const [passcode, inviteToken] = await Promise.all([
      this.ctx.storage.get(`room-pass:${roomId}`),
      this.ctx.storage.get(`room-invite:${roomId}`)
    ]);
    if (!passcode || !inviteToken) throw new Error("ROOM_MAPPING_MISSING");
    const operation = {
      kind: "join",
      phase: "pending",
      method,
      requestId: id,
      credential,
      appUrl,
      roomId,
      passcode,
      inviteToken
    };
    await this.ctx.storage.put(opKey, operation);
    return await this.resumeJoin(opKey, operation);
  }
  async resumeJoin(opKey, operation) {
    const joinRequestId = `${operation.method}:${operation.requestId}`;
    const playerToken = await this.derivePlayerToken(`guest:${joinRequestId}:${operation.roomId}`);
    const playerTokenHash = await sha256(playerToken);
    const joined = await this.env.ROOMS.get(this.env.ROOMS.idFromName(operation.roomId)).fetch(new Request("https://internal/join", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ playerTokenHash, joinRequestId })
    }));
    if (!joined.ok) return new Response(joined.body, { status: joined.status, headers: jsonHeaders });
    const room = await joined.json();
    await this.ctx.storage.put(opKey, { ...operation, phase: "done" });
    const result = {
      roomId: operation.roomId,
      inviteUrl: inviteUrl(operation.appUrl, operation.inviteToken),
      passcode: operation.passcode,
      playerToken,
      seat: room.seat,
      revision: room.revision,
      senteHandicap: room.senteHandicap,
      goteHandicap: room.goteHandicap,
      handicap: room.handicap,
      handicapSide: room.handicapSide,
      order: room.order
    };
    return responseJson(result);
  }
};
function encodeBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
__name(encodeBase64Url, "encodeBase64Url");

// src/runtime/room.ts
import { DurableObject as DurableObject2 } from "cloudflare:workers";

// src/runtime/wasm-engine.ts
import shogiWasmModule from "./6120ba35c21785d739add30645ce2a0658b5c51b-shogi_engine.wasm";
var POSITION_MAGIC = 1397245769;
var POSITION_WORDS = 97;
var MAX_LEGAL_MOVES = 768;
var pieceCodes = {
  pawn: 1,
  lance: 2,
  knight: 3,
  silver: 4,
  gold: 5,
  bishop: 6,
  rook: 7,
  king: 8,
  tokin: 9,
  promotedLance: 10,
  promotedKnight: 11,
  promotedSilver: 12,
  horse: 13,
  dragon: 14
};
var dropCodes = {
  pawn: 1,
  lance: 2,
  knight: 3,
  silver: 4,
  gold: 5,
  bishop: 6,
  rook: 7
};
var handKinds2 = ["pawn", "lance", "knight", "silver", "gold", "bishop", "rook"];
var sideCode = /* @__PURE__ */ __name((side) => side === "sente" ? 1 : -1, "sideCode");
function validExports(value) {
  const candidate = value;
  return candidate.memory instanceof WebAssembly.Memory && typeof candidate.shogi_engine_version === "function" && typeof candidate.shogi_input_buffer === "function" && typeof candidate.shogi_input_capacity === "function" && typeof candidate.shogi_legal_move_count === "function" && typeof candidate.shogi_legal_move_at === "function" && typeof candidate.shogi_is_check === "function" && typeof candidate.shogi_is_mate === "function";
}
__name(validExports, "validExports");
function encodePosition(position) {
  const words = new Int32Array(POSITION_WORDS);
  words[0] = POSITION_MAGIC;
  words[1] = sideCode(position.turn);
  let index = 2;
  for (const row of position.board) {
    if (!Array.isArray(row) || row.length !== 9) throw new Error("WASM_INVALID_BOARD");
    for (const piece of row) {
      if (piece === null) {
        words[index++] = 0;
        continue;
      }
      const code = pieceCodes[piece.kind];
      if (!code) throw new Error("WASM_INVALID_PIECE");
      words[index++] = (piece.side === "sente" ? 1 : -1) * code;
    }
  }
  for (const side of ["sente", "gote"]) {
    for (const kind of handKinds2) {
      const count = position.hands[side][kind];
      if (!Number.isSafeInteger(count) || count < 0 || count > 40) throw new Error("WASM_INVALID_HAND");
      words[index++] = count;
    }
  }
  return words;
}
__name(encodePosition, "encodePosition");
function squareCode(square) {
  const [row, column] = square;
  if (!Number.isInteger(row) || !Number.isInteger(column) || row < 0 || row > 8 || column < 0 || column > 8) throw new Error("WASM_INVALID_SQUARE");
  return row * 9 + column;
}
__name(squareCode, "squareCode");
function encodeMove(move) {
  const to = squareCode(move.to);
  if (move.drop) {
    if (move.drop === "king" || move.promote) throw new Error("WASM_INVALID_DROP");
    return to & 127 | 127 << 7 | dropCodes[move.drop] << 14;
  }
  if (!move.from) throw new Error("WASM_MOVE_FROM_MISSING");
  const from = squareCode(move.from);
  return to & 127 | (from & 127) << 7 | (move.promote ? 1 : 0) << 18;
}
__name(encodeMove, "encodeMove");
var instantiated = await WebAssembly.instantiate(shogiWasmModule, {});
var instance = instantiated instanceof WebAssembly.Instance ? instantiated : instantiated.instance;
if (!validExports(instance.exports)) throw new Error("CLOUDFLARE_WASM_EXPORTS_INVALID");
var wasm = instance.exports;
var version2 = wasm.shogi_engine_version();
if (!Number.isSafeInteger(version2) || version2 < 3) throw new Error("CLOUDFLARE_WASM_VERSION_INVALID");
var capacity = wasm.shogi_input_capacity();
var pointer = wasm.shogi_input_buffer();
if (!Number.isSafeInteger(capacity) || capacity < POSITION_WORDS || capacity > 4096 || !Number.isSafeInteger(pointer) || pointer < 0) {
  throw new Error("CLOUDFLARE_WASM_BUFFER_INVALID");
}
function writePosition(position) {
  const words = encodePosition(position);
  const requiredBytes = pointer + capacity * Int32Array.BYTES_PER_ELEMENT;
  if (requiredBytes > wasm.memory.buffer.byteLength) throw new Error("CLOUDFLARE_WASM_MEMORY_RANGE");
  const input = new Int32Array(wasm.memory.buffer, pointer, capacity);
  input.fill(0, 0, POSITION_WORDS);
  input.set(words, 0);
  return POSITION_WORDS;
}
__name(writePosition, "writePosition");
function legalMoveCodes(position) {
  const count = writePosition(position);
  const total = wasm.shogi_legal_move_count(count);
  if (!Number.isSafeInteger(total) || total < 0 || total > MAX_LEGAL_MOVES) throw new Error("CLOUDFLARE_WASM_LEGAL_FAILURE");
  const result = [];
  for (let index = 0; index < total; index++) {
    const code = wasm.shogi_legal_move_at(index);
    if (!Number.isSafeInteger(code) || code < 0) throw new Error("CLOUDFLARE_WASM_MOVE_ENCODING");
    result.push(code);
  }
  return result;
}
__name(legalMoveCodes, "legalMoveCodes");
function isLegalMove(position, move) {
  const target = encodeMove(move);
  return legalMoveCodes(position).includes(target);
}
__name(isLegalMove, "isLegalMove");
function isCheck2(position, side) {
  const value = wasm.shogi_is_check(writePosition(position), sideCode(side));
  if (value !== 0 && value !== 1) throw new Error("CLOUDFLARE_WASM_CHECK_FAILURE");
  return value === 1;
}
__name(isCheck2, "isCheck");
function isMate2(position) {
  const value = wasm.shogi_is_mate(writePosition(position));
  if (value !== 0 && value !== 1) throw new Error("CLOUDFLARE_WASM_MATE_FAILURE");
  return value === 1;
}
__name(isMate2, "isMate");
var initial = initialPosition("even");
var tsInitial = [...new Set(legalMoves(initial).map(encodeMove))].sort((a, b) => a - b);
var wasmInitial = [...new Set(legalMoveCodes(initial))].sort((a, b) => a - b);
if (tsInitial.length !== 30 || wasmInitial.length !== tsInitial.length || tsInitial.some((code, index) => code !== wasmInitial[index])) {
  throw new Error("CLOUDFLARE_WASM_STARTUP_PARITY_FAILURE");
}
var cloudflareWasmEngine = { version: version2, isLegalMove, isCheck: isCheck2, isMate: isMate2 };

// src/runtime/rule-parity.ts
function validateMoveWithWasm(position, move) {
  let wasmLegal;
  try {
    wasmLegal = cloudflareWasmEngine.isLegalMove(position, move);
  } catch {
    return { ok: false, code: "ENGINE_UNAVAILABLE" };
  }
  let next;
  try {
    next = applyMove(position, move);
  } catch (error) {
    if (wasmLegal) return { ok: false, code: "ENGINE_PARITY_FAILURE" };
    return {
      ok: false,
      code: error instanceof Error && error.message === "GAME_ENDED" ? "GAME_NOT_PLAYING" : "ILLEGAL_MOVE"
    };
  }
  if (!wasmLegal) return { ok: false, code: "ENGINE_PARITY_FAILURE" };
  const outcome = gameOutcome(next);
  try {
    const tsCheck = isCheck(next, next.turn);
    const wasmCheck = cloudflareWasmEngine.isCheck(next, next.turn);
    const tsMate = outcome.ended && outcome.reason === "mate";
    const wasmMate = cloudflareWasmEngine.isMate(next);
    if (tsCheck !== wasmCheck || tsMate !== wasmMate) return { ok: false, code: "ENGINE_PARITY_FAILURE" };
  } catch {
    return { ok: false, code: "ENGINE_UNAVAILABLE" };
  }
  return { ok: true, position: next, outcome };
}
__name(validateMoveWithWasm, "validateMoveWithWasm");

// src/runtime/room.ts
var joinRequestPattern = /^(passcode|invite):[A-Za-z0-9_-]{8,128}$/;
function parseInitHandicaps(body) {
  const hasSente = body.senteHandicap !== void 0;
  const hasGote = body.goteHandicap !== void 0;
  if (hasSente || hasGote) {
    if (!hasSente || !hasGote) throw new Error("INCOMPLETE_HANDICAP_PAIR");
    return { sente: parseHandicap(body.senteHandicap), gote: parseHandicap(body.goteHandicap) };
  }
  const handicap = body.handicap === void 0 ? "even" : parseHandicap(body.handicap);
  const side = body.handicapSide === void 0 ? "gote" : parseSide(body.handicapSide);
  return side === "sente" ? { sente: handicap, gote: "even" } : { sente: "even", gote: handicap };
}
__name(parseInitHandicaps, "parseInitHandicaps");
var ShogiRoom = class extends DurableObject2 {
  static {
    __name(this, "ShogiRoom");
  }
  gate = Promise.resolve();
  constructor(ctx, env) {
    super(ctx, env);
  }
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/socket" && request.headers.get("upgrade")?.toLowerCase() === "websocket") {
      return this.exclusive(() => this.openSocket(request));
    }
    return this.exclusive(async () => {
      if (url.pathname === "/init" && request.method === "POST") return await this.initialize(request);
      if (url.pathname === "/join" && request.method === "POST") return await this.join(request);
      return errorJson("NOT_FOUND", 404);
    });
  }
  async webSocketMessage(socket, message) {
    await this.exclusive(() => this.handleSocketMessage(socket, message));
  }
  async webSocketClose(socket, _code, _reason, _wasClean) {
    const state = await this.ctx.storage.get("state");
    if (state) this.broadcastState(state, socket);
  }
  async webSocketError(socket, _error) {
    const state = await this.ctx.storage.get("state");
    if (state) this.broadcastState(state, socket);
  }
  async exclusive(operation) {
    const previous = this.gate;
    let release;
    this.gate = new Promise((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
  async openSocket(request) {
    const state = await this.ctx.storage.get("state");
    if (!state) return errorJson("ROOM_NOT_FOUND", 404);
    const playerToken = websocketPlayerToken(request.headers);
    if (!playerToken) return errorJson("PLAYER_AUTH_REQUIRED", 401);
    const tokenHash = await sha256(playerToken);
    const seat = state.players.sente && safeEqual(tokenHash, state.players.sente) ? "sente" : state.players.gote && safeEqual(tokenHash, state.players.gote) ? "gote" : null;
    if (!seat) return errorJson("PLAYER_AUTH_REJECTED", 403);
    if (this.ctx.getWebSockets().length >= 8) return errorJson("TOO_MANY_CONNECTIONS", 429);
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ connectionId: randomToken(12), authenticated: false, seat });
    return new Response(null, {
      status: 101,
      webSocket: client,
      headers: { "sec-websocket-protocol": websocketProtocol }
    });
  }
  async initialize(request) {
    const body = await readJson(request);
    const roomId = typeof body.roomId === "string" ? body.roomId : "";
    const creatorTokenHash = typeof body.creatorTokenHash === "string" ? body.creatorTokenHash : "";
    const creationRequestId = typeof body.creationRequestId === "string" ? body.creationRequestId : "";
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(roomId) || !/^[a-f0-9]{64}$/.test(creatorTokenHash) || !requestIdPattern.test(creationRequestId)) return errorJson("INVALID_ROOM_INIT", 400);
    const handicapsValue = parseInitHandicaps(body);
    const legacy = legacyHandicapProjection(handicapsValue);
    const order = body.order === void 0 ? "sente" : parseOrder(body.order);
    const creatorSide = body.creatorSide === void 0 ? "sente" : parseSide(body.creatorSide);
    const existing = await this.ctx.storage.get("state");
    if (existing) {
      const existingCreator = normalizeCreatorSide(existing);
      const existingHash = existing.players[existingCreator];
      const existingHandicaps = normalizeHandicaps(existing);
      if (existing.roomId === roomId && existingHandicaps.sente === handicapsValue.sente && existingHandicaps.gote === handicapsValue.gote && normalizeOrder(existing) === order && existingCreator === creatorSide && existing.creationRequestId === creationRequestId && !!existingHash && safeEqual(existingHash, creatorTokenHash)) return responseJson({ ok: true, revision: existing.revision });
      return errorJson("ROOM_ALREADY_INITIALIZED", 409);
    }
    const players = { sente: null, gote: null };
    players[creatorSide] = creatorTokenHash;
    const state = {
      roomId,
      senteHandicap: handicapsValue.sente,
      goteHandicap: handicapsValue.gote,
      handicap: legacy.handicap,
      handicapSide: legacy.handicapSide,
      order,
      creatorSide,
      creationRequestId,
      revision: 0,
      status: "waiting",
      position: configuredInitialPosition(handicapsValue),
      players,
      processed: { sente: {}, gote: {} }
    };
    await this.ctx.storage.put("state", state);
    return responseJson({ ok: true, revision: 0 });
  }
  async join(request) {
    const body = await readJson(request);
    const tokenHash = typeof body.playerTokenHash === "string" ? body.playerTokenHash : "";
    const joinRequestId = typeof body.joinRequestId === "string" ? body.joinRequestId : "";
    if (!/^[a-f0-9]{64}$/.test(tokenHash) || !joinRequestPattern.test(joinRequestId)) return errorJson("INVALID_PLAYER_TOKEN", 400);
    const state = await this.ctx.storage.get("state");
    if (!state) return errorJson("ROOM_NOT_FOUND", 404);
    const existingSeat = state.players.sente && safeEqual(state.players.sente, tokenHash) ? "sente" : state.players.gote && safeEqual(state.players.gote, tokenHash) ? "gote" : null;
    if (existingSeat) {
      const sameRequest = state.joinRequestId === joinRequestId || existingSeat === "gote" && state.goteJoinRequestId === joinRequestId;
      if (sameRequest) return this.joinResponse(state, existingSeat);
      return errorJson("PLAYER_ALREADY_ASSIGNED", 409);
    }
    if (state.players.sente && state.players.gote) return errorJson("ROOM_FULL", 409);
    if (state.status !== "waiting") return errorJson("ROOM_NOT_JOINABLE", 409);
    const seat = state.players.sente ? "gote" : "sente";
    const nextPlayers = { ...state.players, [seat]: tokenHash };
    const next = {
      ...state,
      players: nextPlayers,
      joinRequestId,
      ...seat === "gote" ? { goteJoinRequestId: joinRequestId } : {},
      status: "playing",
      startedAt: Date.now(),
      revision: state.revision + 1
    };
    await this.ctx.storage.put("state", next);
    this.broadcastState(next);
    return this.joinResponse(next, seat);
  }
  joinResponse(state, seat) {
    const handicapsValue = normalizeHandicaps(state);
    const legacy = legacyHandicapProjection(handicapsValue);
    return responseJson({
      ok: true,
      revision: state.revision,
      seat,
      senteHandicap: handicapsValue.sente,
      goteHandicap: handicapsValue.gote,
      handicap: legacy.handicap,
      handicapSide: legacy.handicapSide,
      order: normalizeOrder(state)
    });
  }
  async handleSocketMessage(socket, message) {
    if (typeof message !== "string" || message.length > 32768) {
      this.send(socket, { type: "error", code: "INVALID_MESSAGE" });
      return;
    }
    let value;
    try {
      value = JSON.parse(message);
    } catch {
      this.send(socket, { type: "error", code: "INVALID_JSON" });
      return;
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      this.send(socket, { type: "error", code: "INVALID_MESSAGE" });
      return;
    }
    const data = value;
    const attachment = socket.deserializeAttachment();
    if (!attachment?.seat) {
      this.rejectAuthentication(socket);
      return;
    }
    const state = await this.ctx.storage.get("state");
    if (!state) {
      this.send(socket, { type: "error", code: "ROOM_NOT_FOUND" });
      return;
    }
    if (!attachment.authenticated) {
      if (data.type !== "authenticate" || typeof data.playerToken !== "string" || !playerTokenPattern.test(data.playerToken)) {
        this.rejectAuthentication(socket);
        return;
      }
      const tokenHash = await sha256(data.playerToken);
      const expectedHash = state.players[attachment.seat];
      if (!expectedHash || !safeEqual(tokenHash, expectedHash)) {
        this.rejectAuthentication(socket);
        return;
      }
      socket.serializeAttachment({ ...attachment, authenticated: true });
      this.send(socket, { type: "authenticated", seat: attachment.seat });
      this.sendState(socket, state);
      this.broadcastState(state);
      return;
    }
    if (data.type === "sync") {
      this.sendState(socket, state);
      return;
    }
    if (data.type !== "move" && data.type !== "resign") {
      this.send(socket, { type: "error", code: "UNKNOWN_MESSAGE" });
      return;
    }
    const seat = attachment.seat;
    const id = typeof data.requestId === "string" ? data.requestId : "";
    if (!requestIdPattern.test(id)) {
      this.reject(socket, id, "INVALID_REQUEST_ID", state.revision);
      return;
    }
    let fingerprint;
    let move = null;
    if (data.type === "move") {
      try {
        move = parseMove(data.move);
      } catch {
        this.reject(socket, id, "INVALID_MOVE", state.revision);
        return;
      }
      fingerprint = moveFingerprint(move);
    } else fingerprint = "resign";
    const prior = state.processed[seat][id];
    if (prior !== void 0) {
      if (prior === fingerprint) this.sendState(socket, state);
      else this.reject(socket, id, "REQUEST_ID_CONFLICT", state.revision);
      return;
    }
    if (state.status !== "playing") {
      this.reject(socket, id, "GAME_NOT_PLAYING", state.revision);
      return;
    }
    const expectedRevision = Number(data.expectedRevision);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision !== state.revision) {
      this.reject(socket, id, "STALE_REVISION", state.revision);
      return;
    }
    const processed = { ...state.processed[seat], [id]: fingerprint };
    if (data.type === "resign") {
      const next2 = {
        ...state,
        status: "ended",
        winner: oppositeSide(seat),
        resultReason: "resignation",
        endedAt: Date.now(),
        revision: state.revision + 1,
        processed: { ...state.processed, [seat]: processed }
      };
      await this.ctx.storage.put("state", next2);
      this.broadcastState(next2);
      return;
    }
    if (state.position.turn !== seat) {
      this.reject(socket, id, "NOT_YOUR_TURN", state.revision);
      return;
    }
    const validated = validateMoveWithWasm(state.position, move);
    if (!validated.ok) {
      this.reject(socket, id, validated.code, state.revision);
      return;
    }
    const { position, outcome } = validated;
    const terminal = outcome.ended ? {
      status: "ended",
      ..."winner" in outcome ? { winner: outcome.winner } : {},
      resultReason: outcome.reason,
      endedAt: Date.now()
    } : { status: "playing" };
    const next = {
      ...state,
      position,
      revision: state.revision + 1,
      processed: { ...state.processed, [seat]: processed },
      ...terminal
    };
    await this.ctx.storage.put("state", next);
    this.broadcastState(next);
  }
  rejectAuthentication(socket) {
    this.send(socket, { type: "auth-rejected" });
    try {
      socket.close(4003, "authentication-failed");
    } catch {
    }
  }
  stateForClient(state, excludedSocket) {
    const connections = { sente: 0, gote: 0 };
    for (const socket of this.ctx.getWebSockets()) {
      if (socket === excludedSocket) continue;
      const attachment = socket.deserializeAttachment();
      if (attachment?.authenticated && attachment.seat) connections[attachment.seat]++;
    }
    const clientPosition = { ...state.position, history: state.position.history.slice(-1) };
    const handicapsValue = normalizeHandicaps(state);
    const legacy = legacyHandicapProjection(handicapsValue);
    return {
      roomId: state.roomId,
      revision: state.revision,
      position: clientPosition,
      status: state.status,
      connections,
      senteHandicap: handicapsValue.sente,
      goteHandicap: handicapsValue.gote,
      handicap: legacy.handicap,
      handicapSide: legacy.handicapSide,
      order: normalizeOrder(state),
      ...state.startedAt ? { startedAt: state.startedAt } : {},
      ...state.endedAt ? { endedAt: state.endedAt } : {},
      ...state.winner ? { winner: state.winner } : {},
      ...state.resultReason ? { resultReason: state.resultReason } : {}
    };
  }
  reject(socket, requestIdValue, code, revision) {
    this.send(socket, { type: "rejected", requestId: requestIdValue, code, revision });
  }
  sendState(socket, state, excludedSocket) {
    this.send(socket, { type: "state", state: this.stateForClient(state, excludedSocket) });
  }
  broadcastState(state, excludedSocket) {
    for (const socket of this.ctx.getWebSockets()) {
      if (socket === excludedSocket) continue;
      const attachment = socket.deserializeAttachment();
      if (attachment?.authenticated) this.sendState(socket, state, excludedSocket);
    }
  }
  send(socket, value) {
    try {
      socket.send(JSON.stringify(value));
    } catch {
    }
  }
};

// src/runtime/content.ts
import { DurableObject as DurableObject3 } from "cloudflare:workers";
var MAX_MANAGED_CONTENT_BYTES = 131072;
function requireContentKey(value) {
  if (typeof value !== "string" || !contentKeys.has(value)) throw new Error("INVALID_CONTENT_KEY");
  return value;
}
__name(requireContentKey, "requireContentKey");
function requireRevision(value) {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error("INVALID_REVISION");
  return Number(value);
}
__name(requireRevision, "requireRevision");
function requireManagedBody(value) {
  let encoded;
  try {
    encoded = JSON.stringify(value);
  } catch {
    throw new Error("CONTENT_NOT_SERIALIZABLE");
  }
  if (encoded === void 0) throw new Error("CONTENT_NOT_SERIALIZABLE");
  if (new TextEncoder().encode(encoded).byteLength > MAX_MANAGED_CONTENT_BYTES) throw new Error("CONTENT_TOO_LARGE");
  return value;
}
__name(requireManagedBody, "requireManagedBody");
var ShogiContent = class extends DurableObject3 {
  static {
    __name(this, "ShogiContent");
  }
  constructor(ctx, env) {
    super(ctx, env);
  }
  async current(key) {
    const [body, storedRevision] = await Promise.all([
      this.ctx.storage.get(`content:${key}`),
      this.ctx.storage.get(`revision:${key}`)
    ]);
    return { body, revision: storedRevision ?? (body === void 0 ? 0 : 1) };
  }
  async fetch(request) {
    if (request.method !== "GET") return errorJson("METHOD_NOT_ALLOWED", 405);
    const url = new URL(request.url);
    const match = url.pathname.match(/^\/get\/(terms|credits|licenses)$/);
    if (!match) return errorJson("NOT_FOUND", 404);
    const key = match[1];
    if (!contentKeys.has(key)) return errorJson("NOT_FOUND", 404);
    const { body, revision } = await this.current(key);
    if (body === void 0) return responseJson({ key, available: false, revision, body: null });
    return responseJson({ key, available: true, revision, body });
  }
  // Internal management boundary only. Durable Objects are not Internet-addressable;
  // no public Worker route forwards user requests to these RPC methods.
  async upsertManagedContent(keyValue, bodyValue, expectedRevisionValue) {
    const key = requireContentKey(keyValue);
    const body = requireManagedBody(bodyValue);
    const expectedRevision = requireRevision(expectedRevisionValue);
    const current = await this.current(key);
    if (current.revision !== expectedRevision) throw new Error("CONTENT_REVISION_CONFLICT");
    const nextRevision = current.revision + 1;
    await this.ctx.storage.put({ [`content:${key}`]: body, [`revision:${key}`]: nextRevision });
    return { key, revision: nextRevision };
  }
  async deleteManagedContent(keyValue, expectedRevisionValue) {
    const key = requireContentKey(keyValue);
    const expectedRevision = requireRevision(expectedRevisionValue);
    const current = await this.current(key);
    if (current.revision !== expectedRevision) throw new Error("CONTENT_REVISION_CONFLICT");
    if (current.body === void 0) return { key, revision: current.revision, deleted: false };
    const nextRevision = current.revision + 1;
    const deletion = this.ctx.storage.delete(`content:${key}`);
    const revisionWrite = this.ctx.storage.put(`revision:${key}`, nextRevision);
    const [deleted] = await Promise.all([deletion, revisionWrite]);
    return { key, revision: nextRevision, deleted };
  }
};

// src/index-v2.ts
async function workerFetch(request, env) {
  const url = new URL(request.url);
  const cors = corsHeaders(request, env);
  if (request.method === "OPTIONS") {
    if (!hasExpectedOrigin(request, env)) return errorJson("ORIGIN_NOT_ALLOWED", 403);
    return new Response(null, { status: 204, headers: cors });
  }
  if (url.pathname === "/health" && request.method === "GET") {
    return responseJson({ ok: true, service: "shogi-system", runtime: "authoritative-v2" }, 200, cors);
  }
  if (url.pathname === "/v1/rooms" && request.method === "POST") {
    if (!hasExpectedOrigin(request, env)) return errorJson("ORIGIN_NOT_ALLOWED", 403, cors);
    try {
      const body = await readJson(request);
      const result = await directoryStub(env).fetch(asInternalRequest("/create", {
        requestId: requestId(body.requestId),
        senteHandicap: body.senteHandicap,
        goteHandicap: body.goteHandicap,
        handicap: body.handicap,
        handicapSide: body.handicapSide,
        order: body.order,
        appUrl: env.APP_URL
      }, request));
      return new Response(result.body, { status: result.status, headers: { ...jsonHeaders, ...cors } });
    } catch (error) {
      return errorJson(error instanceof Error ? error.message : "INVALID_REQUEST", 400, cors);
    }
  }
  if (url.pathname === "/v1/rooms/join" && request.method === "POST") {
    if (!hasExpectedOrigin(request, env)) return errorJson("ORIGIN_NOT_ALLOWED", 403, cors);
    try {
      const body = await readJson(request);
      const passcode = typeof body.passcode === "string" ? body.passcode.trim().toUpperCase() : "";
      if (passcode.length !== 8 || ![...passcode].every((char) => passcodeAlphabet.includes(char))) throw new Error("INVALID_PASSCODE");
      const result = await directoryStub(env).fetch(asInternalRequest("/join-passcode", {
        requestId: requestId(body.requestId),
        passcode,
        appUrl: env.APP_URL
      }, request));
      return new Response(result.body, { status: result.status, headers: { ...jsonHeaders, ...cors } });
    } catch (error) {
      return errorJson(error instanceof Error ? error.message : "INVALID_REQUEST", 400, cors);
    }
  }
  if (url.pathname === "/v1/rooms/invite" && request.method === "POST") {
    if (!hasExpectedOrigin(request, env)) return errorJson("ORIGIN_NOT_ALLOWED", 403, cors);
    try {
      const body = await readJson(request);
      const inviteToken = typeof body.inviteToken === "string" ? body.inviteToken.trim() : "";
      if (!/^[A-Za-z0-9_-]{24,128}$/.test(inviteToken)) throw new Error("INVALID_INVITE");
      const result = await directoryStub(env).fetch(asInternalRequest("/join-invite", {
        requestId: requestId(body.requestId),
        inviteToken,
        appUrl: env.APP_URL
      }, request));
      return new Response(result.body, { status: result.status, headers: { ...jsonHeaders, ...cors } });
    } catch (error) {
      return errorJson(error instanceof Error ? error.message : "INVALID_REQUEST", 400, cors);
    }
  }
  const socketMatch = url.pathname.match(/^\/v1\/rooms\/([A-Za-z0-9_-]{16,128})\/socket$/);
  if (socketMatch && request.method === "GET") {
    if (!hasExpectedOrigin(request, env)) return errorJson("ORIGIN_NOT_ALLOWED", 403, cors);
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") return errorJson("WEBSOCKET_REQUIRED", 426, cors);
    const roomId = socketMatch[1];
    if (!roomIdPattern.test(roomId)) return errorJson("INVALID_ROOM_ID", 400, cors);
    if (!websocketPlayerToken(request.headers)) return errorJson("PLAYER_AUTH_REQUIRED", 401, cors);
    return roomStub(env, roomId).fetch(new Request("https://internal/socket", { headers: request.headers }));
  }
  const contentMatch = url.pathname.match(/^\/v1\/content\/(terms|credits|licenses)$/);
  if (contentMatch && request.method === "GET") {
    const key = contentMatch[1];
    const result = await contentStub(env).fetch(new Request(`https://internal/get/${key}`));
    return new Response(result.body, { status: result.status, headers: { ...jsonHeaders, ...cors } });
  }
  return errorJson("NOT_FOUND", 404, cors);
}
__name(workerFetch, "workerFetch");
var index_v2_default = { fetch: workerFetch };
export {
  ShogiContent,
  ShogiDirectory,
  ShogiRoom,
  index_v2_default as default
};
//# sourceMappingURL=index-v2.js.map
