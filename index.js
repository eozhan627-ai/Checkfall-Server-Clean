import http from "http";
import express from "express";
import { Server } from "socket.io";
import { Chess } from "chess.js";
import { spawn } from "child_process";
import multer from "multer";
import { v2 as cloudinary } from "cloudinary";
import crypto from "crypto";
import { setupClanHandlers } from "./clanSocket.js";
import { setupCoachHandlers } from "./coachSocket.js"; // NEU
import { setupCoachProfileHandlers } from "./coachProfileSocket.js"; // NEU
import { setupAnalysisHandlers } from "./stockfishSocket.js"; // NEU
import { supabaseAdmin } from "./supabaseAdmin.js";
import { calculateGameRatings } from "./elo.js";



const app = express();

// =============================
// SECURITY / CONFIG
// =============================

const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(",").map((o) => o.trim())
    : "*";

const RECONNECT_GRACE_MS = 25_000;
const MAX_CHAT_MESSAGES_PER_10S = 8;
const MAX_MOVES_PER_2S = 12;

// NEU: wie lange nach Partieende eine Revanche noch möglich ist, bevor der
// Snapshot (Namen/Ratings/authIds) wieder verworfen wird.
const REMATCH_WINDOW_MS = 10 * 60 * 1000;

// Start ratings a new player may pick in the skill-level screen. Must match
// the list in the app (app/auth/skillLevel.tsx).
const ALLOWED_INITIAL_RATINGS = [400, 700, 1000, 1500, 2000];

const DEFAULT_RATING = 1000;
const MAX_GUEST_RATING = 3200;

// CORS for the HTTP endpoints (the web build sends an Authorization header,
// which triggers a preflight request).
app.use((req, res, next) => {
    const origin = req.headers.origin;

    if (ALLOWED_ORIGINS === "*") {
        res.setHeader("Access-Control-Allow-Origin", "*");
    } else if (origin && ALLOWED_ORIGINS.includes(origin)) {
        res.setHeader("Access-Control-Allow-Origin", origin);
        res.setHeader("Vary", "Origin");
    }

    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");

    if (req.method === "OPTIONS") {
        return res.sendStatus(204);
    }

    next();
});

app.use(express.json({ limit: "1mb" }));

const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: 5 * 1024 * 1024,
    },
    fileFilter: (req, file, cb) => {
        if (!file.mimetype?.startsWith("image/")) {
            return cb(new Error("Only image uploads are allowed"));
        }
        cb(null, true);
    },
});

cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
});

const server = http.createServer(app);

const io = new Server(server, {
    cors: {
        origin: ALLOWED_ORIGINS,
    },
});

// =============================
// AUTHENTICATION
// =============================
// The user id is NEVER taken from the client. The client sends its Supabase
// access token; we ask Supabase who that token belongs to.

async function verifyAccessToken(token) {
    if (!supabaseAdmin) return null;
    if (typeof token !== "string" || token.length === 0 || token.length > 8192) {
        return null;
    }

    try {
        const { data, error } = await supabaseAdmin.auth.getUser(token);
        if (error || !data?.user?.id) return null;
        return data.user.id;
    } catch (error) {
        console.log("TOKEN VERIFY ERROR:", error?.message);
        return null;
    }
}

async function getAuthIdFromRequest(req) {
    const header = req.headers.authorization || "";
    const match = /^Bearer (.+)$/i.exec(header);
    if (!match) return null;
    return verifyAccessToken(match[1].trim());
}

// Sockets without a token are guests (socket.data.authId stays null).
// Sockets with a token must have a valid one - otherwise the connection is
// refused, so the client can refresh its session and retry.
io.use(async (socket, next) => {
    socket.data.authId = null;

    const token = socket.handshake.auth?.accessToken;

    if (!token) {
        return next();
    }

    const authId = await verifyAccessToken(token);

    if (!authId) {
        return next(new Error("INVALID_TOKEN"));
    }

    socket.data.authId = authId;
    next();
});


// =============================
// STATE
// =============================

const games = new Map();
const botGames = new Map();

const socketToRoom = new Map();
const authenticatedUsers = new Map();
const authIdToRoom = new Map();
const disconnectTimers = new Map();

const matchmakingQueue = [];

const rateBuckets = new Map();

// NEU: Snapshot von gerade beendeten PvP-Partien (roomId -> Daten), damit
// eine Revanche mit denselben Spielern (Farben getauscht) möglich ist, auch
// nachdem cleanupRoom() das eigentliche Spiel schon gelöscht hat.
const finishedGames = new Map();

setupClanHandlers(io, { authenticatedUsers });
setupAnalysisHandlers(io);
setupCoachHandlers(io); // NEU

setupCoachProfileHandlers(io); // NEU 
function getBucket(socketId) {
    if (!rateBuckets.has(socketId)) {
        rateBuckets.set(socketId, { chat: [], moves: [] });
    }
    return rateBuckets.get(socketId);
}

function allowAction(socketId, kind, maxCount, windowMs) {
    const bucket = getBucket(socketId);
    const now = Date.now();
    bucket[kind] = bucket[kind].filter((t) => now - t < windowMs);

    if (bucket[kind].length >= maxCount) {
        return false;
    }

    bucket[kind].push(now);
    return true;
}

// =============================
// ONLINE COUNT
// =============================
// Echte Anzahl aktuell verbundener Sockets (nicht nur eingeloggte User,
// damit auch Gäste/nicht-authentifizierte Verbindungen mitgezählt werden).
// io.engine.clientsCount wird von Socket.IO selbst hochgezählt/runtergezählt,
// ist also immer korrekt, ohne dass wir selbst mitzählen müssen.
function broadcastOnlineCount() {
    io.emit("online_count", { count: io.engine.clientsCount });
}

// =============================
// SMALL VALIDATION HELPERS
// =============================

function isNonEmptyString(value, maxLen = 200) {
    return typeof value === "string" && value.length > 0 && value.length <= maxLen;
}

function isValidSquare(value) {
    return typeof value === "string" && /^[a-h][1-8]$/.test(value);
}

function normalizeMovePayload(rawMove) {
    if (typeof rawMove === "string") {
        const match = /^([a-h][1-8])([a-h][1-8])([qrbn])?$/.exec(rawMove.trim());
        if (!match) return null;

        const [, from, to, promotion] = match;
        return { from, to, promotion: promotion || undefined };
    }

    if (rawMove && typeof rawMove === "object") {
        if (!isValidSquare(rawMove.from) || !isValidSquare(rawMove.to)) return null;

        if (
            rawMove.promotion !== undefined &&
            rawMove.promotion !== null &&
            !["q", "r", "b", "n"].includes(rawMove.promotion)
        ) {
            return null;
        }

        return {
            from: rawMove.from,
            to: rawMove.to,
            promotion: rawMove.promotion || undefined,
        };
    }

    return null;
}

// =============================
// GAME FACTORIES
// =============================

function createPvPGame() {
    return {
        game: new Chess(),
        whiteTime: 300000,
        blackTime: 300000,
        increment: 2000,
        activeColor: "w",
        lastTick: Date.now(),
        paused: false,
        players: { w: null, b: null },
        authIds: { w: null, b: null },
        ratings: { w: 1000, b: 1000 },
        // NEU: werden nur zum Zeitpunkt des game_start gesetzt und für eine
        // mögliche Revanche gebraucht (sonst nirgends dauerhaft gespeichert).
        names: { w: null, b: null },
        avatars: { w: null, b: null },
    };
}

// =============================
// BOT-STÄRKE / ELO-KALIBRIERUNG
// =============================

// Der Slider im Client geht 0 (bzw. 100) bis 3200. Ab 3200 spielt die Engine
// mit voller Stärke (kein UCI_LimitStrength).
const ELO_MIN = 0;
const ELO_MAX = 3200;

// Native Grenzen, in denen Stockfish selbst über UCI_Elo kalibriert - hängt
// von der Engine-Version ab! Beim Start wird geloggt, was deine Binary
// tatsächlich als min/max für UCI_Elo meldet (siehe "option name UCI_Elo"
// im Log) - diese beiden Werte ggf. daran anpassen.
const ENGINE_ELO_MIN = 1320;
const ENGINE_ELO_MAX = 3190;

// Wie viele Kandidatenzüge wir uns von der Engine geben lassen, um daraus
// im "weak mode" (Ziel-Elo unter ENGINE_ELO_MIN) gewichtet einen auszuwählen
// statt immer stur den Top-Zug zu spielen.
const WEAK_MODE_MULTIPV = 8;

function computeEloProfile(rawElo) {
    const n = Number(rawElo);
    const targetElo = Number.isFinite(n)
        ? Math.min(ELO_MAX, Math.max(ELO_MIN, Math.round(n)))
        : 300;

    const fullStrength = targetElo >= ELO_MAX;
    const engineElo = Math.min(ENGINE_ELO_MAX, Math.max(ENGINE_ELO_MIN, targetElo));

    // 0 = an der nativen Engine-Untergrenze, 1 = ganz unten (Elo 0).
    // Steuert, wie stark wir zusätzlich zu UCI_Elo künstlich "Patzer"
    // einstreuen (die Engine selbst spielt unterhalb ihrer eigenen
    // UCI_Elo-Untergrenze i.d.R. nicht mehr spürbar schwächer).
    const belowFloorRatio =
        targetElo >= ENGINE_ELO_MIN
            ? 0
            : (ENGINE_ELO_MIN - targetElo) / ENGINE_ELO_MIN;

    return {
        targetElo,
        fullStrength,
        engineElo,
        belowFloorRatio,
        weakMode: belowFloorRatio > 0,
    };
}

// Wählt aus den (bereits nach cp absteigend sortierten) Kandidatenzügen
// gewichtet einen aus. Je höher belowFloorRatio, desto "flacher" die
// Gewichtung (mehr Ungenauigkeiten) und desto größer die Chance auf einen
// echten Patzer (schwächster der Kandidaten wird gespielt - z.B. eine
// Figur, die dabei hängen bleibt).
function chooseWeightedMove(candidates, belowFloorRatio) {
    if (candidates.length === 0) return null;
    if (candidates.length === 1) return candidates[0].uci;

    const best = candidates[0].cp;

    // Temperatur in "Centipawn": klein = fast immer bester Zug,
    // groß = auch deutlich schwächere Kandidaten werden regelmäßig gespielt.
    const temperature = 35 + belowFloorRatio * 220;

    const blunderChance = belowFloorRatio * 0.16; // bis zu ~16% bei Elo 0
    if (Math.random() < blunderChance) {
        return candidates[candidates.length - 1].uci;
    }

    const weights = candidates.map((c) => Math.exp(-(best - c.cp) / temperature));
    const total = weights.reduce((a, b) => a + b, 0);

    let r = Math.random() * total;
    for (let i = 0; i < candidates.length; i++) {
        r -= weights[i];
        if (r <= 0) return candidates[i].uci;
    }

    return candidates[candidates.length - 1].uci;
}

function createBotGame(rawElo = 300) {
    const profile = computeEloProfile(rawElo);

    return {
        game: new Chess(),
        elo: profile.targetElo,
        fullStrength: profile.fullStrength,
        engineElo: profile.engineElo,
        belowFloorRatio: profile.belowFloorRatio,
        weakMode: profile.weakMode,
        botColor: "b",
        thinking: false,
        pending: false,
        engine: null,
        engineReady: false,
        multipvInfo: new Map(), // multipv-Index -> { cp, uci } der aktuellen Suche
    };
}

// =============================
// MATCHMAKING RANGE
// =============================

function getMatchRange(player) {
    const waitedSeconds = (Date.now() - player.joinedAt) / 1000;

    if (waitedSeconds < 5) return 100;
    if (waitedSeconds < 10) return 150;
    if (waitedSeconds < 15) return 250;
    if (waitedSeconds < 20) return 400;

    return 600;
}

function findMatchForPlayer(player) {
    const playerRange = getMatchRange(player);

    for (let i = 0; i < matchmakingQueue.length; i++) {
        const opponent = matchmakingQueue[i];

        if (opponent.id === player.id) continue;

        const opponentSocket = io.sockets.sockets.get(opponent.id);

        if (!opponentSocket) {
            matchmakingQueue.splice(i, 1);
            i--;
            continue;
        }

        const eloDifference = Math.abs(player.rating - opponent.rating);
        const opponentRange = getMatchRange(opponent);
        const allowedRange = Math.min(playerRange, opponentRange);

        if (eloDifference <= allowedRange) {
            matchmakingQueue.splice(i, 1);
            return opponent;
        }
    }

    return null;
}

function removeFromQueue(socketId) {
    const idx = matchmakingQueue.findIndex((p) => p.id === socketId);
    if (idx !== -1) {
        matchmakingQueue.splice(idx, 1);
    }
}

setInterval(() => {
    for (let i = 0; i < matchmakingQueue.length; i++) {
        const player = matchmakingQueue[i];
        const opponentSocket = io.sockets.sockets.get(player.id);
        if (!opponentSocket) {
            matchmakingQueue.splice(i, 1);
            i--;
            continue;
        }

        const opponent = findMatchForPlayer(player);
        if (opponent) {
            matchmakingQueue.splice(matchmakingQueue.indexOf(player), 1);
            startPvPGame(player, opponent);
            break;
        }
    }
}, 3000);

// =============================
// TIMER (PvP)
// =============================

setInterval(() => {
    const now = Date.now();

    for (const [roomId, g] of games.entries()) {
        if (g.paused) {
            g.lastTick = now;
            continue;
        }

        const diff = Math.max(0, now - g.lastTick);
        g.lastTick = now;

        if (g.activeColor === "w") {
            g.whiteTime -= diff;
        } else {
            g.blackTime -= diff;
        }

        if (g.whiteTime <= 0 || g.blackTime <= 0) {
            finishPvPGame(roomId, "timeout", g.whiteTime <= 0 ? "b" : "w");
            continue;
        }

        io.to(roomId).emit("timer_update", {
            whiteTime: g.whiteTime,
            blackTime: g.blackTime,
            activeColor: g.activeColor,
        });
    }
}, 1000);

// Regelmäßiger Broadcast der Online-Zahl, damit sie auch ohne Verbindungs-
// wechsel (z.B. Reconnects, die clientsCount nicht sofort ändern) aktuell
// bleibt. Alle 10s ist unauffällig genug, um keine Last zu erzeugen.
setInterval(() => {
    broadcastOnlineCount();
}, 10_000);

// NEU: alte Revanche-Snapshots wieder aufräumen, falls niemand mehr reagiert.
setInterval(() => {
    const now = Date.now();
    for (const [roomId, info] of finishedGames.entries()) {
        if (now - info.endedAt > REMATCH_WINDOW_MS) {
            finishedGames.delete(roomId);
        }
    }
}, 60_000);



// =============================
// GAME END (PvP) - RATINGS ARE DECIDED HERE, NOT IN THE CLIENT
// =============================

async function persistGameResult(authId, { rating, won }) {
    if (!supabaseAdmin || !authId) return;

    try {
        const { data: profile, error: readError } = await supabaseAdmin
            .from("profiles")
            .select("games_played, wins")
            .eq("id", authId)
            .maybeSingle();

        if (readError) throw readError;

        const { error } = await supabaseAdmin
            .from("profiles")
            .update({
                rating,
                games_played: (profile?.games_played ?? 0) + 1,
                wins: (profile?.wins ?? 0) + (won ? 1 : 0),
                updated_at: new Date().toISOString(),
            })
            .eq("id", authId);

        if (error) throw error;
    } catch (error) {
        console.error("PERSIST GAME RESULT ERROR:", { authId, message: error?.message });
    }
}

// type: "checkmate" | "timeout" | "resign" | "disconnect" | "draw"
// winnerColor: "w" | "b" | null (draw)
function finishPvPGame(roomId, type, winnerColor) {
    const g = games.get(roomId);
    if (!g || g.finished) return;

    g.finished = true;

    // A game only counts for the rating when both players are logged in.
    // Guests send their own rating, so it cannot be trusted.
    const rated = Boolean(g.authIds.w && g.authIds.b);

    const before = { w: g.ratings.w, b: g.ratings.b };
    const computed = calculateGameRatings(before, winnerColor);

    const after = {
        // Logged-in player in an unrated game: rating stays as it is.
        // Guest: the new value is only ever stored on the guest's own device.
        w: g.authIds.w && !rated ? before.w : computed.w,
        b: g.authIds.b && !rated ? before.b : computed.b,
    };

    const payload = { type, rated };

    if (winnerColor) {
        payload.winner = g.players[winnerColor];
        payload.winnerColor = winnerColor;
    }

    io.to(roomId).emit("game_over", payload);

    for (const color of ["w", "b"]) {
        const socketId = g.players[color];
        if (!socketId) continue;

        io.to(socketId).emit("rating_update", {
            roomId,
            rated,
            rating: after[color],
            previousRating: before[color],
        });
    }

    // New ratings are kept for a possible rematch.
    g.ratings = after;

    const authIds = { ...g.authIds };

    cleanupRoom(roomId);

    if (rated) {
        persistGameResult(authIds.w, { rating: after.w, won: winnerColor === "w" });
        persistGameResult(authIds.b, { rating: after.b, won: winnerColor === "b" });
    }
}

function cleanupBotRoom(roomId) {
    const bot = botGames.get(roomId);
    if (!bot) return;

    if (bot.engine) {
        try {
            bot.engine.stdin.write("quit\n");
            bot.engine.kill();
        } catch (error) {
            console.log("ENGINE KILL ERROR:", error);
        }
    }

    botGames.delete(roomId);
}

// =============================
// ROOM CLEANUP
// =============================

function cleanupRoom(roomId) {
    const g = games.get(roomId);

    if (g) {
        // NEU: Snapshot für eine mögliche Revanche aufheben - Namen/Ratings/
        // authIds gehen sonst verloren, weil sie nur im Game-Objekt lagen.
        finishedGames.set(roomId, {
            players: { ...g.players },
            authIds: { ...g.authIds },
            ratings: { ...g.ratings },
            names: { ...g.names },
            avatars: { ...g.avatars },
            endedAt: Date.now(),
        });
    }

    games.delete(roomId);

    cleanupBotRoom(roomId);

    const timer = disconnectTimers.get(roomId);
    if (timer) {
        clearTimeout(timer.timeout);
        disconnectTimers.delete(roomId);
    }

    for (const [socketId, r] of socketToRoom.entries()) {
        if (r === roomId) socketToRoom.delete(socketId);
    }

    for (const [authId, r] of authIdToRoom.entries()) {
        if (r === roomId) authIdToRoom.delete(authId);
    }
}

// =============================
// STOCKFISH
// =============================

function getEngine(botState, roomId) {
    if (botState.engine) {
        return botState.engine;
    }

    const engine = spawn("/usr/games/stockfish");
    let buffer = "";

    botState.engineReady = false;

    engine.on("error", (err) => {
        console.error("ENGINE SPAWN ERROR:", err);
    });

    engine.on("exit", (code, signal) => {
        console.log("ENGINE EXITED:", { roomId, code, signal });

        const stillHere = botGames.get(roomId);
        if (stillHere && stillHere.engine === engine) {
            stillHere.engine = null;
            stillHere.engineReady = false;
            stillHere.thinking = false;
            stillHere.pending = false;
        }
    });

    engine.stdout.on("data", (data) => {
        buffer += data.toString();

        const lines = buffer.split("\n");
        buffer = lines.pop();

        for (let line of lines) {
            line = line.trim();

            // Nur zur Kontrolle beim Start: zeigt dir, welchen Elo-Bereich
            // deine konkrete Stockfish-Version für UCI_Elo tatsächlich
            // unterstützt - ENGINE_ELO_MIN/MAX oben ggf. daran anpassen.
            if (
                line.startsWith("option name UCI_Elo") ||
                line.startsWith("option name UCI_LimitStrength") ||
                line.startsWith("option name MultiPV")
            ) {
                console.log("ENGINE OPTION:", line);
            }

            if (line === "uciok") {
                if (botState.fullStrength) {
                    engine.stdin.write("setoption name UCI_LimitStrength value false\n");
                    engine.stdin.write("setoption name Skill Level value 20\n");
                    engine.stdin.write("setoption name MultiPV value 1\n");
                } else {
                    engine.stdin.write("setoption name UCI_LimitStrength value true\n");
                    engine.stdin.write(`setoption name UCI_Elo value ${botState.engineElo}\n`);
                    engine.stdin.write(
                        `setoption name MultiPV value ${botState.weakMode ? WEAK_MODE_MULTIPV : 1}\n`
                    );
                }
                engine.stdin.write("isready\n");
            }

            if (line === "readyok") {
                botState.engineReady = true;

                if (botState.game.turn() === botState.botColor) {
                    startBotMove(roomId);
                }
            }

            // Kandidatenzüge während der Suche sammeln (nur relevant im
            // weak mode, wo MultiPV > 1 gesetzt ist).
            if (botState.weakMode && line.startsWith("info") && line.includes(" pv ")) {
                const mpvMatch = line.match(/multipv (\d+)/);
                const scoreMatch = line.match(/score (cp|mate) (-?\d+)/);
                const pvMatch = line.match(/ pv (.+)$/);

                if (mpvMatch && scoreMatch && pvMatch) {
                    const idx = parseInt(mpvMatch[1], 10);
                    let cp = parseInt(scoreMatch[2], 10);

                    if (scoreMatch[1] === "mate") {
                        cp = cp > 0 ? 100000 - cp : -100000 - cp;
                    }

                    const firstMove = pvMatch[1].trim().split(" ")[0];

                    if (firstMove) {
                        botState.multipvInfo.set(idx, { cp, uci: firstMove });
                    }
                }
            }

            if (line.startsWith("bestmove")) {
                const engineUci = line.split(" ")[1];

                botState.thinking = false;
                botState.pending = false;

                let chosenUci = engineUci;

                // Im weak mode NICHT immer den Top-Zug der Engine spielen,
                // sondern gewichtet einen der gesammelten Kandidaten wählen -
                // das simuliert menschliche Ungenauigkeiten/Patzer.
                if (botState.weakMode && botState.multipvInfo.size > 0) {
                    const candidates = Array.from(botState.multipvInfo.values())
                        .filter((c) => c.uci && c.uci !== "(none)")
                        .sort((a, b) => b.cp - a.cp);

                    const picked = chooseWeightedMove(candidates, botState.belowFloorRatio);
                    if (picked) chosenUci = picked;
                }

                if (!chosenUci || chosenUci === "(none)") {
                    return;
                }

                const from = chosenUci.slice(0, 2);
                const to = chosenUci.slice(2, 4);
                const promotion = chosenUci[4];

                let result;
                try {
                    result = botState.game.move({ from, to, promotion });
                } catch (error) {
                    console.log("BOT MOVE REJECTED:", chosenUci, error?.message);

                    // Falls unser künstlich gewählter "Patzer-Zug" doch mal
                    // ungültig sein sollte, auf den echten Engine-Zug
                    // zurückfallen, statt dass der Bot stumm bleibt.
                    if (chosenUci !== engineUci && engineUci && engineUci !== "(none)") {
                        try {
                            result = botState.game.move({
                                from: engineUci.slice(0, 2),
                                to: engineUci.slice(2, 4),
                                promotion: engineUci[4],
                            });
                        } catch (fallbackError) {
                            console.log("BOT FALLBACK MOVE REJECTED:", engineUci, fallbackError?.message);
                            return;
                        }
                    } else {
                        return;
                    }
                }

                if (!result) return;

                io.to(roomId).emit("opponent_move", {
                    from: result.from,
                    to: result.to,
                    promotion: result.promotion,
                });

                emitGameOverIfBotGameEnded(roomId, botState);
            }
        }
    });

    engine.stdin.write("uci\n");
    botState.engine = engine;

    return engine;
}
function startPvPGame(playerA, playerB) {
    const roomId = `${crypto.randomUUID()}`;

    io.sockets.sockets.get(playerA.id)?.join(roomId);
    io.sockets.sockets.get(playerB.id)?.join(roomId);

    const game = createPvPGame();

    const white = playerA.joinedAt <= playerB.joinedAt ? playerA : playerB;
    const black = white === playerA ? playerB : playerA;

    game.players.w = white.id;
    game.players.b = black.id;
    game.authIds.w = white.authId;
    game.authIds.b = black.authId;
    game.ratings.w = white.rating;
    game.ratings.b = black.rating;
    game.names.w = white.name;
    game.names.b = black.name;
    game.avatars.w = white.avatar;
    game.avatars.b = black.avatar;

    games.set(roomId, game);

    socketToRoom.set(white.id, roomId);
    socketToRoom.set(black.id, roomId);

    if (white.authId) authIdToRoom.set(white.authId, roomId);
    if (black.authId) authIdToRoom.set(black.authId, roomId);

    io.to(roomId).emit("game_start", {
        roomId,
        white: white.id,
        black: black.id,
        fen: game.game.fen(), // FIX: fehlte bisher - new Chess("startpos") im Client crasht sonst
        whiteName: white.name,
        blackName: black.name,
        whiteAvatar: white.avatar,
        blackAvatar: black.avatar,
        whiteRating: white.rating,
        blackRating: black.rating,
        whiteAuthId: white.authId,
        blackAuthId: black.authId,
        whiteTime: game.whiteTime,
        blackTime: game.blackTime,
        increment: game.increment,
    });

    console.log("MATCH FOUND:", {
        roomId,
        white: white.name,
        whiteRating: white.rating,
        black: black.name,
        blackRating: black.rating,
        difference: Math.abs(white.rating - black.rating),
    });
}

// Simulierte Bedenkzeit: kurz & gleichmäßig in der Eröffnung, danach
// variabler im Mittel-/Endspiel. "go movetime X" lässt die Engine
// tatsächlich diese Zeit lang rechnen, statt nur einen Timer davor zu hängen.
function getBotThinkTimeMs(pliesPlayed, fullStrength) {
    if (fullStrength) {
        // Volle Stärke darf ruhig etwas länger "nachdenken".
        return 1200 + Math.round(Math.random() * 1300); // 1.2s - 2.5s
    }

    const OPENING_PLY_THRESHOLD = 6; // ~3 Züge pro Seite

    if (pliesPlayed < OPENING_PLY_THRESHOLD) {
        return 800 + Math.round(Math.random() * 200); // ~0.8s - 1.0s
    }

    return 700 + Math.round(Math.random() * 1300); // 0.7s - 2.0s
}

function startBotMove(roomId) {
    const botState = botGames.get(roomId);
    if (!botState) return;
    if (botState.thinking || botState.pending) return;
    if (botState.game.isGameOver()) return;

    const engine = getEngine(botState, roomId);
    if (!botState.engineReady) return;

    botState.pending = true;
    botState.thinking = true;

    const pliesPlayed = botState.game.history().length;
    const thinkTimeMs = getBotThinkTimeMs(pliesPlayed, botState.fullStrength);

    setTimeout(() => {
        if (!botGames.has(roomId)) return; // Raum wurde inzwischen aufgeräumt

        botState.multipvInfo = new Map(); // Kandidaten der vorigen Suche verwerfen

        engine.stdin.write(`position fen ${botState.game.fen()}\n`);
        engine.stdin.write(`go movetime ${thinkTimeMs}\n`);
    }, 50);
}

function emitGameOverIfBotGameEnded(roomId, botState) {
    if (!botState.game.isGameOver()) return;

    const humanColor = botState.botColor === "w" ? "b" : "w";
    let payload;

    if (botState.game.isCheckmate()) {
        const winnerIsBot = botState.game.turn() === humanColor;
        payload = { type: "checkmate", winner: winnerIsBot ? "bot" : "human" };
    } else {
        payload = { type: "draw" };
    }

    io.to(roomId).emit("game_over", payload);
}

// =============================
// AVATAR UPLOAD
// =============================

app.post("/upload-avatar", upload.single("avatar"), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: "No avatar uploaded" });
        }

        // The user is identified by the access token, never by a value the
        // client puts in the form - otherwise anyone could overwrite anyone's
        // avatar.
        const authId = await getAuthIdFromRequest(req);

        if (!authId) {
            return res.status(401).json({ error: "Not signed in" });
        }

        const result = await new Promise((resolve, reject) => {
            const stream = cloudinary.uploader.upload_stream(
                {
                    folder: "checkfall/avatars",
                    public_id: authId,
                    overwrite: true,
                    resource_type: "image",
                },
                (error, result) => {
                    if (error) reject(error);
                    else resolve(result);
                }
            );

            stream.end(req.file.buffer);
        });

        console.log("AVATAR UPLOADED:", result.secure_url);

        const { error: profileError } = await supabaseAdmin
            .from("profiles")
            .update({ avatar: result.secure_url, updated_at: new Date().toISOString() })
            .eq("id", authId);

        if (profileError) {
            console.error("AVATAR PROFILE UPDATE ERROR:", profileError.message);
        }

        res.json({ success: true, url: result.secure_url });
    } catch (error) {
        console.error("AVATAR UPLOAD ERROR:", error);
        res.status(500).json({ error: "Avatar upload failed" });
    }
});

// =============================
// INITIAL RATING (skill-level screen after sign-up)
// =============================
// Only allowed while the player has not finished a rated game yet, and only
// with one of the fixed start values.

app.post("/set-initial-rating", async (req, res) => {
    try {
        const authId = await getAuthIdFromRequest(req);

        if (!authId) {
            return res.status(401).json({ error: "Not signed in" });
        }

        const rating = Number(req.body?.rating);

        if (!ALLOWED_INITIAL_RATINGS.includes(rating)) {
            return res.status(400).json({ error: "Invalid rating" });
        }

        const { data: profile, error: readError } = await supabaseAdmin
            .from("profiles")
            .select("games_played")
            .eq("id", authId)
            .maybeSingle();

        if (readError) throw readError;

        if (!profile) {
            return res.status(404).json({ error: "Profile not found" });
        }

        if ((profile.games_played ?? 0) > 0) {
            return res.status(409).json({ error: "Rating can no longer be changed" });
        }

        const { error } = await supabaseAdmin
            .from("profiles")
            .update({ rating, updated_at: new Date().toISOString() })
            .eq("id", authId);

        if (error) throw error;

        res.json({ success: true, rating });
    } catch (error) {
        console.error("SET INITIAL RATING ERROR:", error?.message);
        res.status(500).json({ error: "Rating could not be saved" });
    }
});

// =============================
// SOCKET
// =============================

io.on("connection", (socket) => {
    console.log("Connected:", socket.id);

    // NEU: allen Clients die aktualisierte Online-Zahl schicken, sobald
    // jemand Neues verbunden ist.
    broadcastOnlineCount();

    // NEU: erlaubt es dem Client, die aktuelle Zahl sofort beim Laden
    // der Startseite abzufragen, statt auf den nächsten periodischen
    // Broadcast zu warten.
    socket.on("get_online_count", () => {
        socket.emit("online_count", { count: io.engine.clientsCount });
    });

    // The user id comes from the verified token (see io.use above). Runs
    // once per connection: single-session kick + resume of a running game.
    if (socket.data.authId) {
        const authId = socket.data.authId;

        const oldSocketId = authenticatedUsers.get(authId);

        if (oldSocketId && oldSocketId !== socket.id) {
            const oldSocket = io.sockets.sockets.get(oldSocketId);

            if (oldSocket) {
                console.log("KICKING OLD DEVICE:", {
                    authId,
                    oldSocket: oldSocketId,
                    newSocket: socket.id,
                });

                oldSocket.emit("session_kicked", {
                    message: "You are now signed in on another device.",
                });

                oldSocket.disconnect(true);
            }
        }

        authenticatedUsers.set(authId, socket.id);

        socket.emit("socket_authenticated");

        const roomId = authIdToRoom.get(authId);
        const g = roomId ? games.get(roomId) : null;
        const color = g
            ? g.authIds.w === authId
                ? "w"
                : g.authIds.b === authId
                    ? "b"
                    : null
            : null;

        if (g && color) {
            g.players[color] = socket.id;
            socketToRoom.set(socket.id, roomId);
            socket.join(roomId);

            const timer = disconnectTimers.get(roomId);
            if (timer) {
                clearTimeout(timer.timeout);
                disconnectTimers.delete(roomId);
            }

            g.paused = false;
            g.lastTick = Date.now();

            socket.emit("game_start", {
                roomId,
                white: g.players.w,
                black: g.players.b,
                fen: g.game.fen(),
                whiteTime: g.whiteTime,
                blackTime: g.blackTime,
                activeColor: g.activeColor,
                increment: g.increment,
                whiteRating: g.ratings.w,
                blackRating: g.ratings.b,
                whiteAuthId: g.authIds.w,
                blackAuthId: g.authIds.b,
                resumed: true,
            });

            io.to(roomId).emit("opponent_reconnected", { color });

            console.log("PLAYER RECONNECTED:", { authId, roomId, color });
        }
    }

    // Kept so older app versions that still send this event get an answer.
    // The payload is ignored on purpose.
    socket.on("authenticate_socket", () => {
        if (socket.data.authId) {
            socket.emit("socket_authenticated");
        }
    });

    socket.on("check_friends_online", (data) => {
        const authIds = Array.isArray(data?.authIds)
            ? data.authIds.filter((id) => isNonEmptyString(id, 128))
            : [];

        const online = authIds.filter((id) => authenticatedUsers.has(id));

        socket.emit("friends_online_status", { online });
    });

    socket.on("find_match", async (data) => {
        if (socket.data.findingMatch) return;

        if (matchmakingQueue.some((p) => p.id === socket.id)) {
            console.log("Already waiting:", socket.id);
            return;
        }

        if (socketToRoom.has(socket.id) && games.has(socketToRoom.get(socket.id))) {
            socket.emit("matchmaking_error", { message: "You are already in a game" });
            return;
        }

        const authId = socket.data.authId || null;

        let name;
        let avatar;
        let rating;

        if (authId) {
            // Logged-in players: name, avatar and rating come from the
            // database, not from the client.
            socket.data.findingMatch = true;

            let profile = null;

            try {
                const result = await supabaseAdmin
                    .from("profiles")
                    .select("username, avatar, rating")
                    .eq("id", authId)
                    .maybeSingle();

                profile = result.data;
            } catch (error) {
                console.log("FIND MATCH PROFILE ERROR:", error?.message);
            } finally {
                socket.data.findingMatch = false;
            }

            if (!profile?.username) {
                socket.emit("matchmaking_error", { message: "Profile not found" });
                return;
            }

            // The socket may have gone away or queued itself while we waited.
            if (!socket.connected) return;
            if (matchmakingQueue.some((p) => p.id === socket.id)) return;

            name = profile.username;
            avatar = profile.avatar || "";
            rating = Number.isFinite(profile.rating) ? profile.rating : DEFAULT_RATING;
        } else {
            rating = Number(data?.rating);

            if (!Number.isFinite(rating) || rating < 0) {
                socket.emit("matchmaking_error", { message: "Invalid rating" });
                return;
            }

            rating = Math.min(MAX_GUEST_RATING, Math.round(rating));

            if (!isNonEmptyString(data?.name, 60)) {
                socket.emit("matchmaking_error", { message: "Invalid name" });
                return;
            }

            name = data.name;
            avatar = isNonEmptyString(data?.avatar, 500) ? data.avatar : "";
        }

        const player = {
            id: socket.id,
            authId,
            name,
            avatar,
            rating,
            joinedAt: Date.now(),
        };

        const opponent = findMatchForPlayer(player);

        if (!opponent) {
            matchmakingQueue.push(player);
            socket.emit("waiting");

            console.log("PLAYER WAITING:", {
                id: player.id,
                name: player.name,
                rating: player.rating,
                queueSize: matchmakingQueue.length,
            });

            return;
        }

        startPvPGame(player, opponent);
    });

    socket.on("cancel_matchmaking", () => {
        removeFromQueue(socket.id);
        socket.emit("matchmaking_cancelled");
    });

    socket.on("find_bot_match", (data) => {
        const roomId = `bot_${socket.id}`;

        // Restarting a bot game must not leave the old engine process running.
        cleanupBotRoom(roomId);

        socket.join(roomId);

        let botIsWhite;

        if (data?.playerColor === "w") {
            botIsWhite = false;
        } else if (data?.playerColor === "b") {
            botIsWhite = true;
        } else {
            botIsWhite = Math.random() < 0.5;
        }

        const playerIsWhite = !botIsWhite;

        let game;
        try {
            game =
                data?.startFEN && data.startFEN !== "startpos"
                    ? new Chess(data.startFEN)
                    : new Chess();
        } catch (error) {
            console.error("Invalid startFEN:", data?.startFEN);
            game = new Chess();
        }

        const botState = createBotGame(data?.level);
        botState.game = game;
        botState.botColor = botIsWhite ? "w" : "b";

        botGames.set(roomId, botState);
        socketToRoom.set(socket.id, roomId);

        io.to(roomId).emit("game_start", {
            roomId,
            white: botIsWhite ? "bot" : socket.id,
            black: botIsWhite ? socket.id : "bot",
            whiteName: botIsWhite ? "Stockfish" : (isNonEmptyString(data?.name, 60) ? data.name : "Player"),
            blackName: botIsWhite ? (isNonEmptyString(data?.name, 60) ? data.name : "Player") : "Stockfish",
            playerColor: playerIsWhite ? "w" : "b",
            botColor: botState.botColor,
            fen: game.fen(),
        });

        console.log("BOT GAME START:", {
            roomId,
            playerColor: playerIsWhite ? "w" : "b",
            botColor: botState.botColor,
            targetElo: botState.elo,
            fullStrength: botState.fullStrength,
            engineElo: botState.engineElo,
            weakMode: botState.weakMode,
        });

        getEngine(botState, roomId);

        if (game.turn() === botState.botColor) {
            setTimeout(() => startBotMove(roomId), 500);
        }
    });

    // The bot screen was closed - stop the engine for this socket.
    socket.on("leave_bot_game", () => {
        const roomId = `bot_${socket.id}`;

        cleanupBotRoom(roomId);
        socket.leave(roomId);

        if (socketToRoom.get(socket.id) === roomId) {
            socketToRoom.delete(socket.id);
        }
    });

    socket.on("player_move", ({ roomId, move: rawMove } = {}) => {
        if (!isNonEmptyString(roomId, 200)) {
            return;
        }

        const move = normalizeMovePayload(rawMove);
        if (!move) {
            console.log("MOVE REJECTED: invalid payload", { roomId, rawMove });
            return;
        }

        if (!allowAction(socket.id, "moves", MAX_MOVES_PER_2S, 2000)) {
            return;
        }

        const bot = botGames.get(roomId);

        if (bot) {
            if (roomId !== `bot_${socket.id}`) return;

            const humanColor = bot.botColor === "w" ? "b" : "w";

            if (bot.game.turn() !== humanColor) {
                return;
            }

            let result;
            try {
                result = bot.game.move(move);
            } catch (error) {
                return;
            }

            if (!result) return;

            socket.to(roomId).emit("opponent_move", {
                from: result.from,
                to: result.to,
                promotion: result.promotion,
            });

            emitGameOverIfBotGameEnded(roomId, bot);

            if (!bot.game.isGameOver()) {
                startBotMove(roomId);
            }

            return;
        }

        const g = games.get(roomId);
        if (!g) return;

        const expectedPlayer = g.activeColor === "w" ? g.players.w : g.players.b;

        if (socket.id !== expectedPlayer) {
            console.log("Move rejected:", {
                socket: socket.id,
                expectedPlayer,
                activeColor: g.activeColor,
            });
            return;
        }

        let result;
        try {
            result = g.game.move(move);
        } catch (error) {
            return;
        }

        if (!result) return;

        const now = Date.now();
        const diff = Math.max(0, now - g.lastTick);

        if (g.activeColor === "w") {
            g.whiteTime -= diff;
            g.whiteTime += g.increment;
        } else {
            g.blackTime -= diff;
            g.blackTime += g.increment;
        }

        g.lastTick = now;
        g.activeColor = g.activeColor === "w" ? "b" : "w";

        socket.to(roomId).emit("opponent_move", {
            from: result.from,
            to: result.to,
            promotion: result.promotion,
        });

        io.to(roomId).emit("timer_update", {
            whiteTime: g.whiteTime,
            blackTime: g.blackTime,
            activeColor: g.activeColor,
        });

        if (g.game.isGameOver()) {
            if (g.game.isCheckmate()) {
                // The side to move is the one that got mated.
                finishPvPGame(roomId, "checkmate", g.game.turn() === "w" ? "b" : "w");
            } else {
                finishPvPGame(roomId, "draw", null);
            }
        }
    });

    socket.on("offer_draw", ({ roomId } = {}) => {
        if (!isNonEmptyString(roomId, 200)) return;

        const g = games.get(roomId);
        if (!g) return;
        if (socket.id !== g.players.w && socket.id !== g.players.b) return;

        const opponent = socket.id === g.players.w ? g.players.b : g.players.w;

        // Remember who offered, so only the OTHER player can accept.
        g.drawOfferedBy = socket.id;

        io.to(opponent).emit("draw_offer");
    });

    socket.on("answer_draw", ({ roomId, accept } = {}) => {
        if (!isNonEmptyString(roomId, 200)) return;

        const g = games.get(roomId);
        if (!g) return;
        if (socket.id !== g.players.w && socket.id !== g.players.b) return;

        // Without this check a player could "accept" a draw nobody offered
        // (or their own offer) and escape a lost position.
        if (!g.drawOfferedBy || g.drawOfferedBy === socket.id) return;

        g.drawOfferedBy = null;

        if (accept) {
            finishPvPGame(roomId, "draw", null);
        } else {
            const opponent = socket.id === g.players.w ? g.players.b : g.players.w;
            io.to(opponent).emit("draw_declined");
        }
    });

    socket.on("resign_game", ({ roomId } = {}) => {
        if (!isNonEmptyString(roomId, 200)) return;

        const g = games.get(roomId);
        if (!g) return;
        if (socket.id !== g.players.w && socket.id !== g.players.b) return;

        finishPvPGame(roomId, "resign", socket.id === g.players.w ? "b" : "w");
    });

    socket.on("send_chat_message", ({ roomId, message } = {}) => {
        if (!isNonEmptyString(roomId, 200) || !isNonEmptyString(message, 300)) {
            return;
        }

        if (!allowAction(socket.id, "chat", MAX_CHAT_MESSAGES_PER_10S, 10_000)) {
            return;
        }

        const room = io.sockets.adapter.rooms.get(roomId);
        if (!room || !room.has(socket.id)) return;

        io.to(roomId).emit("chat_message", {
            id: crypto.randomUUID(),
            senderId: socket.id,
            message: message.slice(0, 300),
            timestamp: Date.now(),
        });
    });

    // GEÄNDERT: eine Revanche startet jetzt tatsächlich eine neue Partie
    // mit denselben beiden Spielern, Farben getauscht.
    socket.on("rematch_request", ({ roomId } = {}) => {
        if (!isNonEmptyString(roomId, 200)) return;
        if (!io.sockets.adapter.rooms.get(roomId)?.has(socket.id)) return;

        socket.to(roomId).emit("rematch_offer");
        socket.emit("rematch_requested");
    });

    socket.on("rematch_answer", ({ roomId, accept } = {}) => {
        if (!isNonEmptyString(roomId, 200)) return;
        if (!io.sockets.adapter.rooms.get(roomId)?.has(socket.id)) return;

        if (!accept) {
            socket.to(roomId).emit("rematch_declined");
            return;
        }

        const info = finishedGames.get(roomId);

        if (!info) {
            io.to(roomId).emit("rematch_error", {
                message: "A rematch is no longer possible.",
            });
            return;
        }

        const oldWhiteId = info.players.w;
        const oldBlackId = info.players.b;

        const oldWhiteSocket = oldWhiteId ? io.sockets.sockets.get(oldWhiteId) : null;
        const oldBlackSocket = oldBlackId ? io.sockets.sockets.get(oldBlackId) : null;

        if (!oldWhiteSocket || !oldBlackSocket) {
            io.to(roomId).emit("rematch_error", {
                message: "Your opponent is no longer online.",
            });
            return;
        }

        finishedGames.delete(roomId);

        // Farben tauschen: wer eben Schwarz war, spielt jetzt Weiß und
        // umgekehrt - deshalb w/b bewusst vertauscht befüllt.
        const newRoomId = `${crypto.randomUUID()}`;
        const newGame = createPvPGame();

        newGame.players.w = oldBlackId;
        newGame.players.b = oldWhiteId;
        newGame.authIds.w = info.authIds.b;
        newGame.authIds.b = info.authIds.w;
        newGame.ratings.w = info.ratings.b;
        newGame.ratings.b = info.ratings.w;
        newGame.names.w = info.names.b;
        newGame.names.b = info.names.w;
        newGame.avatars.w = info.avatars.b;
        newGame.avatars.b = info.avatars.w;

        oldWhiteSocket.join(newRoomId);
        oldBlackSocket.join(newRoomId);

        games.set(newRoomId, newGame);

        socketToRoom.set(oldWhiteId, newRoomId);
        socketToRoom.set(oldBlackId, newRoomId);

        if (newGame.authIds.w) authIdToRoom.set(newGame.authIds.w, newRoomId);
        if (newGame.authIds.b) authIdToRoom.set(newGame.authIds.b, newRoomId);

        io.to(newRoomId).emit("game_start", {
            roomId: newRoomId,
            white: newGame.players.w,
            black: newGame.players.b,
            fen: newGame.game.fen(), // FIX: ohne fen crasht new Chess("startpos") im Client
            whiteName: newGame.names.w,
            blackName: newGame.names.b,
            whiteAvatar: newGame.avatars.w,
            blackAvatar: newGame.avatars.b,
            whiteRating: newGame.ratings.w,
            blackRating: newGame.ratings.b,
            whiteAuthId: newGame.authIds.w,
            blackAuthId: newGame.authIds.b,
            whiteTime: newGame.whiteTime,
            blackTime: newGame.blackTime,
            increment: newGame.increment,
        });

        console.log("REMATCH STARTED:", {
            oldRoomId: roomId,
            newRoomId,
            white: newGame.names.w,
            black: newGame.names.b,
        });
    });

    socket.on("disconnect", () => {
        console.log("Disconnected:", socket.id);

        // NEU: allen verbliebenen Clients die aktualisierte Online-Zahl
        // schicken, sobald jemand die Verbindung trennt.
        broadcastOnlineCount();

        const authId = socket.data.authId;

        if (authId && authenticatedUsers.get(authId) === socket.id) {
            authenticatedUsers.delete(authId);
        }

        removeFromQueue(socket.id);
        rateBuckets.delete(socket.id);

        const roomId = socketToRoom.get(socket.id);
        if (!roomId) return;

        const g = games.get(roomId);

        if (g) {
            const color = g.players.w === socket.id ? "w" : g.players.b === socket.id ? "b" : null;

            if (color && authId) {
                g.paused = true;

                io.to(roomId).emit("opponent_disconnected", {
                    color,
                    graceMs: RECONNECT_GRACE_MS,
                });

                const timeout = setTimeout(() => {
                    const stillMissing = games.get(roomId);
                    if (!stillMissing) return;

                    finishPvPGame(roomId, "disconnect", color === "w" ? "b" : "w");
                }, RECONNECT_GRACE_MS);

                disconnectTimers.set(roomId, { timeout, color, authId });
                return;
            }

            finishPvPGame(roomId, "disconnect", g.players.w === socket.id ? "b" : "w");
            return;
        }

        cleanupRoom(roomId);
    });
});

// ===========================
// SERVER
// ===========================

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
    console.log("Server running on", PORT);
});