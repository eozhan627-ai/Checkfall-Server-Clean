import http from "http";
import express from "express";
import { Server } from "socket.io";
import { Chess } from "chess.js";
import { spawn } from "child_process";
import multer from "multer";
import { v2 as cloudinary } from "cloudinary";
import crypto from "crypto";
import { setupClanHandlers } from "./clanSocket.js";

const app = express();

// =============================
// SECURITY / CONFIG
// =============================

// Setze ALLOWED_ORIGINS in der .env, z.B. "https://meineapp.com,https://admin.meineapp.com"
// Fällt im Dev-Fall auf "*" zurück, damit lokale Tests weiter funktionieren.
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(",").map((o) => o.trim())
    : "*";

const RECONNECT_GRACE_MS = 25_000; // Zeit, die ein Spieler nach Disconnect hat, um zurückzukommen
const MAX_CHAT_MESSAGES_PER_10S = 8;
const MAX_MOVES_PER_2S = 12;

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
// STATE
// =============================

const games = new Map(); // roomId -> pvp game state
const botGames = new Map(); // roomId -> bot game state

const socketToRoom = new Map(); // socket.id -> roomId
const authenticatedUsers = new Map(); // authId -> socket.id
const authIdToRoom = new Map(); // authId -> roomId (survives disconnect, used for reconnect)
const disconnectTimers = new Map(); // roomId -> { timeout, color, authId }

const matchmakingQueue = [];

// Simple per-socket rate limiting buckets
const rateBuckets = new Map(); // socket.id -> { chat: number[], moves: number[] }
// ============================= teest
setupClanHandlers(io, { authenticatedUsers });
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
// SMALL VALIDATION HELPERS
// =============================

function isNonEmptyString(value, maxLen = 200) {
    return typeof value === "string" && value.length > 0 && value.length <= maxLen;
}

function isValidSquare(value) {
    return typeof value === "string" && /^[a-h][1-8]$/.test(value);
}

// Der Client sollte {from, to, promotion?} als Objekt schicken. Aus Robustheit
// akzeptieren wir hier zusätzlich einen reinen UCI-String ("e2e4" / "e7e8q"),
// falls irgendein Client-Pfad noch dieses Format verwendet - vorher wurde ein
// String-Payload stillschweigend verworfen (typeof move !== "object"), wodurch
// Serverspiel und Client komplett auseinanderliefen und der Bot nie mehr am Zug war.
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
        paused: false, // true während einer Reconnect-Grace-Period
        players: { w: null, b: null },
        authIds: { w: null, b: null },
        ratings: { w: 1000, b: 1000 },
    };
}

// Level ist eine grobe Spielstärke 0-20 (UCI Skill Level).
// Falls dein Client größere Werte schickt (z.B. eine Elo-artige Zahl),
// wird hier heruntergerechnet - Mapping ggf. an deine Client-Skala anpassen.
function normalizeSkillLevel(rawLevel) {
    const n = Number(rawLevel);
    if (!Number.isFinite(n)) return 10;

    if (n <= 20) {
        return Math.min(20, Math.max(0, Math.round(n)));
    }

    // z.B. 300 -> ca. Skill 6
    return Math.min(20, Math.max(0, Math.round(n / 50)));
}

function createBotGame(level = 300) {
    const skill = normalizeSkillLevel(level);

    return {
        game: new Chess(),
        skill,
        depth: Math.max(2, Math.round(2 + skill * 0.65)), // grob 2-15
        botColor: "b",
        thinking: false,
        pending: false,
        engine: null,
        engineReady: false,
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
            startPvPGame(player, opponent); // deine bestehende Match-Logik extrahieren
            break; // Queue hat sich verändert, neuer Durchlauf beim nächsten Tick
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
            // Uhr läuft während einer Reconnect-Grace-Period nicht weiter.
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
            const winnerSocket = g.whiteTime <= 0 ? g.players.b : g.players.w;

            io.to(roomId).emit("game_over", {
                type: "timeout",
                winner: winnerSocket,
            });

            cleanupRoom(roomId);
            continue;
        }

        io.to(roomId).emit("timer_update", {
            whiteTime: g.whiteTime,
            blackTime: g.blackTime,
            activeColor: g.activeColor,
        });
    }
}, 1000);



// =============================
// ROOM CLEANUP
// =============================

function cleanupRoom(roomId) {
    games.delete(roomId);

    const bot = botGames.get(roomId);
    if (bot?.engine) {
        try {
            bot.engine.stdin.write("quit\n");
            bot.engine.kill();
        } catch (error) {
            console.log("ENGINE KILL ERROR:", error);
        }
    }
    botGames.delete(roomId);

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

        // Falls die Engine unerwartet stirbt, während der Raum noch existiert,
        // Referenz zurücksetzen, damit getEngine() beim nächsten Zug neu spawnt,
        // statt dass der Bot für immer stumm bleibt.
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

            if (line === "uciok") {
                engine.stdin.write(
                    `setoption name Skill Level value ${botState.skill}\n`
                );
                engine.stdin.write("isready\n");
            }

            if (line === "readyok") {
                botState.engineReady = true;

                if (botState.game.turn() === botState.botColor) {
                    startBotMove(roomId);
                }
            }

            if (line.startsWith("bestmove")) {
                const uci = line.split(" ")[1];

                botState.thinking = false;
                botState.pending = false;

                if (!uci || uci === "(none)") {
                    return;
                }

                const from = uci.slice(0, 2);
                const to = uci.slice(2, 4);
                const promotion = uci[4];

                let result;
                try {
                    result = botState.game.move({ from, to, promotion });
                } catch (error) {
                    console.log("BOT MOVE REJECTED:", uci, error?.message);
                    return;
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

    // Wer länger gewartet hat, bekommt Weiß.
    const white = playerA.joinedAt <= playerB.joinedAt ? playerA : playerB;
    const black = white === playerA ? playerB : playerA;

    game.players.w = white.id;
    game.players.b = black.id;
    game.authIds.w = white.authId;
    game.authIds.b = black.authId;
    game.ratings.w = white.rating;
    game.ratings.b = black.rating;

    games.set(roomId, game);

    socketToRoom.set(white.id, roomId);
    socketToRoom.set(black.id, roomId);

    if (white.authId) authIdToRoom.set(white.authId, roomId);
    if (black.authId) authIdToRoom.set(black.authId, roomId);

    io.to(roomId).emit("game_start", {
        roomId,
        white: white.id,
        black: black.id,
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
function startBotMove(roomId) {
    const botState = botGames.get(roomId);
    if (!botState) return;
    if (botState.thinking || botState.pending) return;
    if (botState.game.isGameOver()) return;

    const engine = getEngine(botState, roomId);
    if (!botState.engineReady) return;

    botState.pending = true;
    botState.thinking = true;

    setTimeout(() => {
        if (!botGames.has(roomId)) return; // Raum wurde inzwischen aufgeräumt

        engine.stdin.write(`position fen ${botState.game.fen()}\n`);
        engine.stdin.write(`go depth ${botState.depth}\n`);
    }, 300);
}

function emitGameOverIfBotGameEnded(roomId, botState) {
    if (!botState.game.isGameOver()) return;

    const humanColor = botState.botColor === "w" ? "b" : "w";
    let payload;

    if (botState.game.isCheckmate()) {
        const winnerIsBot = botState.game.turn() === humanColor; // der Spieler, der dran ist, wurde matt gesetzt
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

        if (!isNonEmptyString(req.body.userId, 128)) {
            return res.status(400).json({ error: "Missing or invalid userId" });
        }

        const result = await new Promise((resolve, reject) => {
            const stream = cloudinary.uploader.upload_stream(
                {
                    folder: "checkfall/avatars",
                    public_id: req.body.userId,
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

        res.json({ success: true, url: result.secure_url });
    } catch (error) {
        console.error("AVATAR UPLOAD ERROR:", error);
        res.status(500).json({ error: "Avatar upload failed" });
    }
});

// =============================
// SOCKET
// =============================

io.on("connection", (socket) => {
    console.log("Connected:", socket.id);

    // =============================
    // AUTHENTICATED USER + RECONNECT
    // =============================

    socket.on("authenticate_socket", (data) => {
        const authId = data?.authId;

        if (!isNonEmptyString(authId, 128)) {
            console.log("SOCKET AUTH: missing/invalid authId", socket.id);
            return;
        }

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
        socket.data.authId = authId;

        socket.emit("socket_authenticated");

        // ==== RECONNECT: gibt es ein laufendes Spiel für diesen authId? ====
        const roomId = authIdToRoom.get(authId);
        const g = roomId ? games.get(roomId) : null;

        if (!g) return;

        const color = g.authIds.w === authId ? "w" : g.authIds.b === authId ? "b" : null;
        if (!color) return;

        // Alten (toten) Socket-Eintrag durch den neuen ersetzen
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
            whiteAuthId: g.authIds.w, // NEU: für dauerhaftes "Freund hinzufügen"
            blackAuthId: g.authIds.b, // NEU
            resumed: true,
        });

        io.to(roomId).emit("opponent_reconnected", { color });

        console.log("PLAYER RECONNECTED:", { authId, roomId, color });
    });

    // =============================
    // FRIENDS: ONLINE STATUS
    // =============================

    socket.on("check_friends_online", (data) => {
        const authIds = Array.isArray(data?.authIds)
            ? data.authIds.filter((id) => isNonEmptyString(id, 128))
            : [];

        const online = authIds.filter((id) => authenticatedUsers.has(id));

        socket.emit("friends_online_status", { online });
    });

    // =============================
    // PvP MATCHMAKING
    // =============================

    socket.on("find_match", (data) => {
        if (matchmakingQueue.some((p) => p.id === socket.id)) {
            console.log("Already waiting:", socket.id);
            return;
        }

        const rating = Number(data?.rating);

        if (!Number.isFinite(rating) || rating < 0) {
            socket.emit("matchmaking_error", { message: "Invalid rating" });
            return;
        }

        if (!isNonEmptyString(data?.name, 60)) {
            socket.emit("matchmaking_error", { message: "Invalid name" });
            return;
        }

        const player = {
            id: socket.id,
            authId: socket.data.authId || null,
            name: data.name,
            avatar: isNonEmptyString(data?.avatar, 500) ? data.avatar : "",
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

    // =============================
    // BOT MATCH
    // =============================

    socket.on("find_bot_match", (data) => {
        const roomId = `bot_${socket.id}`;

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
            skill: botState.skill,
            depth: botState.depth,
        });

        getEngine(botState, roomId);

        // Falls der Bot bereits am Zug ist (egal welche Farbe - z.B. auch beim
        // Fortsetzen eines gespeicherten Spiels, bei dem Schwarz am Zug ist und
        // der Bot Schwarz spielt), Zug anstoßen. Vorher wurde hier nur der
        // Sonderfall "Bot ist Weiß und Zug 1" abgedeckt; alle anderen Fälle
        // hingen komplett vom "readyok"-Callback der Engine ab, was bei einer
        // bereits laufenden/wiederverwendeten Engine nie erneut feuert.
        if (game.turn() === botState.botColor) {
            setTimeout(() => startBotMove(roomId), 500);
        }
    });

    // =============================
    // PLAYER MOVE
    // =============================

    socket.on("player_move", ({ roomId, move: rawMove }) => {
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

        // =========================
        // BOT
        // =========================

        const bot = botGames.get(roomId);

        if (bot) {
            const humanColor = bot.botColor === "w" ? "b" : "w";

            if (bot.game.turn() !== humanColor) {
                return; // nicht der Zug des Spielers
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

        // =========================
        // PvP
        // =========================

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
                const winner = g.game.turn() === "w" ? g.players.b : g.players.w;

                io.to(roomId).emit("game_over", {
                    type: "checkmate",
                    winner,
                });
            } else {
                io.to(roomId).emit("game_over", { type: "draw" });
            }

            cleanupRoom(roomId);
        }
    });

    // =============================
    // DRAW OFFER / ANSWER
    // =============================

    socket.on("offer_draw", ({ roomId }) => {
        if (!isNonEmptyString(roomId, 200)) return;

        const g = games.get(roomId);
        if (!g) return;
        if (socket.id !== g.players.w && socket.id !== g.players.b) return;

        const opponent = socket.id === g.players.w ? g.players.b : g.players.w;
        io.to(opponent).emit("draw_offer");
    });

    socket.on("answer_draw", ({ roomId, accept }) => {
        if (!isNonEmptyString(roomId, 200)) return;

        const g = games.get(roomId);
        if (!g) return;
        if (socket.id !== g.players.w && socket.id !== g.players.b) return;

        if (accept) {
            io.to(roomId).emit("game_over", { type: "draw" });
            cleanupRoom(roomId);
        } else {
            const opponent = socket.id === g.players.w ? g.players.b : g.players.w;
            io.to(opponent).emit("draw_declined");
        }
    });

    // =============================
    // RESIGN
    // =============================

    socket.on("resign_game", ({ roomId }) => {
        if (!isNonEmptyString(roomId, 200)) return;

        const g = games.get(roomId);
        if (!g) return;
        if (socket.id !== g.players.w && socket.id !== g.players.b) return;

        const winner = socket.id === g.players.w ? g.players.b : g.players.w;

        io.to(roomId).emit("game_over", { type: "resign", winner });
        cleanupRoom(roomId);
    });

    // =============================
    // CHAT
    // =============================

    socket.on("send_chat_message", ({ roomId, message }) => {
        if (!isNonEmptyString(roomId, 200) || !isNonEmptyString(message, 300)) {
            return;
        }

        if (!allowAction(socket.id, "chat", MAX_CHAT_MESSAGES_PER_10S, 10_000)) {
            return;
        }

        const room = io.sockets.adapter.rooms.get(roomId);
        if (!room || !room.has(socket.id)) return; // Socket ist gar nicht in dem Raum

        io.to(roomId).emit("chat_message", {
            id: crypto.randomUUID(),
            senderId: socket.id,
            message: message.slice(0, 300),
            timestamp: Date.now(),
        });
    });

    // =============================
    // REMATCH
    // =============================

    socket.on("rematch_request", ({ roomId }) => {
        if (!isNonEmptyString(roomId, 200)) return;

        socket.to(roomId).emit("rematch_offer");
        socket.emit("rematch_requested");
    });

    socket.on("rematch_answer", ({ roomId, accept }) => {
        if (!isNonEmptyString(roomId, 200)) return;

        if (accept) {
            socket.to(roomId).emit("rematch_accepted");
        } else {
            socket.to(roomId).emit("rematch_declined");
        }
    });

    // =============================
    // DISCONNECT (mit Reconnect-Grace-Period)
    // =============================

    socket.on("disconnect", () => {
        console.log("Disconnected:", socket.id);

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
                // Grace-Period: Gegner wird informiert, Spiel pausiert kurz
                g.paused = true;

                io.to(roomId).emit("opponent_disconnected", {
                    color,
                    graceMs: RECONNECT_GRACE_MS,
                });

                const timeout = setTimeout(() => {
                    const stillMissing = games.get(roomId);
                    if (!stillMissing) return;

                    const winner = color === "w" ? stillMissing.players.b : stillMissing.players.w;

                    io.to(roomId).emit("game_over", {
                        type: "disconnect",
                        winner,
                    });

                    cleanupRoom(roomId);
                }, RECONNECT_GRACE_MS);

                disconnectTimers.set(roomId, { timeout, color, authId });
                return; // Raum NICHT sofort aufräumen - wartet auf Reconnect
            }

            // Kein authId vorhanden -> kein Reconnect möglich, sofort werten
            const winner = g.players.w === socket.id ? g.players.b : g.players.w;

            io.to(roomId).emit("game_over", {
                type: "disconnect",
                winner,
            });

            cleanupRoom(roomId);
            return;
        }

        // Bot-Spiel oder unbekannter Raum -> direkt aufräumen
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