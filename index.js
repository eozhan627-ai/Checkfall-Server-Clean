import http from "http";
import express from "express";
import { Server } from "socket.io";
import { Chess } from "chess.js";
import { spawn } from "child_process";
import multer from "multer";
import { v2 as cloudinary } from "cloudinary";

const app = express();
app.use(express.json());

const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: 5 * 1024 * 1024,
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
        origin: "*",
    },
});

// =============================
// STATE
// =============================

const games = new Map();
const botGames = new Map();

const socketToRoom = new Map();

// authId -> socket.id
// Dadurch können wir denselben
// Benutzer auf mehreren Geräten erkennen.
const authenticatedUsers = new Map();

let waitingPlayer = null;

// =============================
// GAME FACTORY
// =============================

function createPvPGame() {
    return {
        game: new Chess(),

        whiteTime: 300000,
        blackTime: 300000,

        increment: 2000,

        activeColor: "w",

        lastTick: Date.now(),

        players: {
            w: null,
            b: null,
        },
    };
}

// =============================
// BOT GAME FACTORY
// =============================

function createBotGame(level = 300) {
    return {
        game: new Chess(),

        level,

        botColor: "b",

        thinking: false,

        pending: false,

        engine: null,

        engineReady: false,
    };
}

// =============================
// TIMER
// =============================

setInterval(() => {
    const now = Date.now();

    for (const [roomId, g] of games.entries()) {
        const diff = now - g.lastTick;

        g.lastTick = now;

        if (g.activeColor === "w") {
            g.whiteTime -= diff;
        } else {
            g.blackTime -= diff;
        }

        if (
            g.whiteTime <= 0 ||
            g.blackTime <= 0
        ) {
            const winnerSocket =
                g.whiteTime <= 0
                    ? g.players.b
                    : g.players.w;

            io.to(roomId).emit("game_over", {
                type: "timeout",
                winner: winnerSocket,
            });

            games.delete(roomId);

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
// STOCKFISH
// =============================

function getEngine(botState, roomId) {
    if (botState.engine) {
        return botState.engine;
    }

    const engine = spawn(
        "/usr/games/stockfish"
    );

    let buffer = "";

    botState.engineReady = false;

    engine.stdout.on("data", (data) => {
        buffer += data.toString();

        const lines = buffer.split("\n");

        buffer = lines.pop();

        for (let line of lines) {
            line = line.trim();

            if (line === "uciok") {
                engine.stdin.write(
                    "isready\n"
                );
            }

            if (line === "readyok") {
                botState.engineReady = true;

                if (
                    botState.game.turn() ===
                    botState.botColor
                ) {
                    startBotMove(roomId);
                }
            }

            if (line.startsWith("bestmove")) {
                const uci = line.split(" ")[1];

                if (
                    !uci ||
                    uci === "(none)"
                ) {
                    return;
                }

                const from = uci.slice(0, 2);
                const to = uci.slice(2, 4);
                const promotion = uci[4];

                const result =
                    botState.game.move({
                        from,
                        to,
                        promotion,
                    });

                if (!result) {
                    return;
                }

                io.to(roomId).emit(
                    "opponent_move",
                    {
                        from: result.from,
                        to: result.to,
                        promotion:
                            result.promotion,
                    }
                );

                botState.thinking = false;
                botState.pending = false;
            }
        }
    });

    engine.stdin.write("uci\n");

    botState.engine = engine;

    return engine;
}

function startBotMove(roomId) {
    const botState = botGames.get(roomId);

    if (!botState) {
        return;
    }

    if (botState.thinking) {
        return;
    }

    if (botState.pending) {
        return;
    }

    const engine =
        getEngine(botState, roomId);

    if (!botState.engineReady) {
        return;
    }

    botState.pending = true;
    botState.thinking = true;

    setTimeout(() => {
        engine.stdin.write(
            `position fen ${botState.game.fen()}\n`
        );

        engine.stdin.write(
            "go depth 5\n"
        );
    }, 300);
}

// =============================
// AVATAR UPLOAD
// =============================

app.post(
    "/upload-avatar",
    upload.single("avatar"),
    async (req, res) => {
        try {
            if (!req.file) {
                return res.status(400).json({
                    error: "No avatar uploaded",
                });
            }

            if (!req.body.userId) {
                return res.status(400).json({
                    error: "Missing userId",
                });
            }

            const result =
                await new Promise(
                    (resolve, reject) => {
                        const stream =
                            cloudinary.uploader.upload_stream(
                                {
                                    folder:
                                        "checkfall/avatars",

                                    public_id:
                                        req.body.userId,

                                    overwrite: true,

                                    resource_type:
                                        "image",
                                },
                                (
                                    error,
                                    result
                                ) => {
                                    if (error) {
                                        reject(error);
                                    } else {
                                        resolve(
                                            result
                                        );
                                    }
                                }
                            );

                        stream.end(
                            req.file.buffer
                        );
                    }
                );

            console.log(
                "AVATAR UPLOADED:",
                result.secure_url
            );

            res.json({
                success: true,
                url: result.secure_url,
            });
        } catch (error) {
            console.error(
                "AVATAR UPLOAD ERROR:",
                error
            );

            res.status(500).json({
                error: "Avatar upload failed",
            });
        }
    }
);

// =============================
// SOCKET
// =============================

io.on("connection", (socket) => {
    console.log(
        "Connected:",
        socket.id
    );

    // =============================
    // AUTHENTICATED USER
    // =============================

    socket.on("authenticate_socket", (data) => {
        const authId = data?.authId;

        if (!authId) {
            console.log(
                "SOCKET AUTH: missing authId",
                socket.id
            );

            return;
        }

        console.log(
            "SOCKET AUTH:",
            authId,
            socket.id
        );

        const oldSocketId =
            authenticatedUsers.get(authId);

        // =============================
        // SAME ACCOUNT ALREADY ONLINE
        // =============================

        if (
            oldSocketId &&
            oldSocketId !== socket.id
        ) {
            const oldSocket =
                io.sockets.sockets.get(
                    oldSocketId
                );

            if (oldSocket) {
                console.log(
                    "KICKING OLD DEVICE:",
                    {
                        authId,
                        oldSocket:
                            oldSocketId,
                        newSocket:
                            socket.id,
                    }
                );

                oldSocket.emit(
                    "session_kicked",
                    {
                        message:
                            "You are now signed in on another device.",
                    }
                );

                // Alte Verbindung trennen.
                oldSocket.disconnect(
                    true
                );
            }
        }

        // Neues Gerät wird jetzt
        // das aktive Gerät.
        authenticatedUsers.set(
            authId,
            socket.id
        );

        socket.data.authId = authId;

        console.log(
            "ACTIVE DEVICE:",
            {
                authId,
                socket:
                    socket.id,
            }
        );

        socket.emit(
            "socket_authenticated"
        );
    });

    // =============================
    // PvP MATCHMAKING
    // =============================

    socket.on("find_match", (data) => {
        if (
            waitingPlayer?.id ===
            socket.id
        ) {
            console.log(
                "Already waiting:",
                socket.id
            );

            return;
        }

        if (!waitingPlayer) {
            waitingPlayer = {
                id: socket.id,
                ...data,
            };

            socket.emit("waiting");

            return;
        }

        const roomId =
            `${waitingPlayer.id}_${socket.id}`;

        socket.join(roomId);

        io.sockets.sockets
            .get(waitingPlayer.id)
            ?.join(roomId);

        const game =
            createPvPGame();

        game.players.w =
            waitingPlayer.id;

        game.players.b =
            socket.id;

        games.set(
            roomId,
            game
        );

        socketToRoom.set(
            waitingPlayer.id,
            roomId
        );

        socketToRoom.set(
            socket.id,
            roomId
        );

        io.to(roomId).emit(
            "game_start",
            {
                roomId,

                white:
                    waitingPlayer.id,

                black:
                    socket.id,

                whiteName:
                    waitingPlayer.name,

                blackName:
                    data.name,

                whiteAvatar:
                    waitingPlayer.avatar ||
                    "",

                blackAvatar:
                    data.avatar ||
                    "",

                whiteTime:
                    game.whiteTime,

                blackTime:
                    game.blackTime,

                increment:
                    game.increment,
            }
        );

        waitingPlayer = null;
    });

    // =============================
    // BOT MATCH
    // =============================

    socket.on(
        "find_bot_match",
        (data) => {
            const roomId =
                `bot_${socket.id}`;

            socket.join(roomId);

            let botIsWhite;

            if (
                data.playerColor === "w"
            ) {
                botIsWhite = false;
            } else if (
                data.playerColor === "b"
            ) {
                botIsWhite = true;
            } else {
                botIsWhite =
                    Math.random() < 0.5;
            }

            const playerIsWhite =
                !botIsWhite;

            let game;

            try {
                if (
                    data.startFEN &&
                    data.startFEN !==
                    "startpos"
                ) {
                    game = new Chess(
                        data.startFEN
                    );
                } else {
                    game =
                        new Chess();
                }
            } catch (error) {
                console.error(
                    "Invalid startFEN:",
                    data.startFEN
                );

                game =
                    new Chess();
            }

            const botState =
                createBotGame(
                    data.level
                );

            botState.game = game;

            botState.botColor =
                botIsWhite
                    ? "w"
                    : "b";

            botGames.set(
                roomId,
                botState
            );

            socketToRoom.set(
                socket.id,
                roomId
            );

            io.to(roomId).emit(
                "game_start",
                {
                    roomId,

                    white: botIsWhite
                        ? "bot"
                        : socket.id,

                    black: botIsWhite
                        ? socket.id
                        : "bot",

                    whiteName:
                        botIsWhite
                            ? "Stockfish"
                            : data.name,

                    blackName:
                        botIsWhite
                            ? data.name
                            : "Stockfish",

                    playerColor:
                        playerIsWhite
                            ? "w"
                            : "b",

                    botColor:
                        botState.botColor,

                    fen:
                        game.fen(),
                }
            );

            console.log(
                "BOT GAME START:",
                {
                    roomId,

                    playerColor:
                        playerIsWhite
                            ? "w"
                            : "b",

                    botColor:
                        botState.botColor,

                    fen:
                        game.fen(),

                    level:
                        data.level,
                }
            );

            getEngine(
                botState,
                roomId
            );

            if (
                botIsWhite &&
                game.turn() === "w"
            ) {
                setTimeout(
                    () =>
                        startBotMove(
                            roomId
                        ),
                    500
                );
            }
        }
    );

    // =============================
    // PLAYER MOVE
    // =============================

    socket.on(
        "player_move",
        ({ roomId, move }) => {
            // =========================
            // BOT
            // =========================

            const bot =
                botGames.get(roomId);

            if (bot) {
                const result =
                    bot.game.move(
                        move
                    );

                if (!result) {
                    return;
                }

                socket
                    .to(roomId)
                    .emit(
                        "opponent_move",
                        {
                            from:
                                result.from,

                            to:
                                result.to,

                            promotion:
                                result.promotion,
                        }
                    );

                if (
                    !bot.game.isGameOver()
                ) {
                    startBotMove(
                        roomId
                    );
                }

                return;
            }

            // =========================
            // PvP
            // =========================

            const g =
                games.get(roomId);

            if (!g) {
                return;
            }

            const expectedPlayer =
                g.activeColor === "w"
                    ? g.players.w
                    : g.players.b;

            if (
                socket.id !==
                expectedPlayer
            ) {
                console.log(
                    "Move rejected:",
                    {
                        socket:
                            socket.id,

                        expectedPlayer,

                        activeColor:
                            g.activeColor,
                    }
                );

                return;
            }

            const result =
                g.game.move(move);

            if (!result) {
                return;
            }

            const now =
                Date.now();

            const diff =
                now -
                g.lastTick;

            if (
                g.activeColor === "w"
            ) {
                g.whiteTime -= diff;
                g.whiteTime +=
                    g.increment;
            } else {
                g.blackTime -= diff;
                g.blackTime +=
                    g.increment;
            }

            g.lastTick = now;

            g.activeColor =
                g.activeColor === "w"
                    ? "b"
                    : "w";

            socket
                .to(roomId)
                .emit(
                    "opponent_move",
                    {
                        from:
                            result.from,

                        to:
                            result.to,

                        promotion:
                            result.promotion,
                    }
                );

            io.to(roomId).emit(
                "timer_update",
                {
                    whiteTime:
                        g.whiteTime,

                    blackTime:
                        g.blackTime,

                    activeColor:
                        g.activeColor,
                }
            );

            if (
                g.game.isGameOver()
            ) {
                if (
                    g.game.isCheckmate()
                ) {
                    const winner =
                        g.game.turn() === "w"
                            ? g.players.b
                            : g.players.w;

                    io.to(roomId).emit(
                        "game_over",
                        {
                            type:
                                "checkmate",

                            winner,
                        }
                    );
                } else {
                    io.to(roomId).emit(
                        "game_over",
                        {
                            type: "draw",
                        }
                    );
                }

                games.delete(roomId);
            }
        }
    );

    // =============================
    // DRAW OFFER
    // =============================

    socket.on(
        "offer_draw",
        ({ roomId }) => {
            const g =
                games.get(roomId);

            if (!g) {
                return;
            }

            if (
                socket.id !==
                g.players.w &&
                socket.id !==
                g.players.b
            ) {
                return;
            }

            const opponent =
                socket.id ===
                    g.players.w
                    ? g.players.b
                    : g.players.w;

            io.to(opponent).emit(
                "draw_offer"
            );
        }
    );

    // =============================
    // DRAW ANSWER
    // =============================

    socket.on(
        "answer_draw",
        ({ roomId, accept }) => {
            const g =
                games.get(roomId);

            if (!g) {
                return;
            }

            if (
                socket.id !==
                g.players.w &&
                socket.id !==
                g.players.b
            ) {
                return;
            }

            if (accept) {
                io.to(roomId).emit(
                    "game_over",
                    {
                        type: "draw",
                    }
                );

                games.delete(roomId);
            } else {
                const opponent =
                    socket.id ===
                        g.players.w
                        ? g.players.b
                        : g.players.w;

                io.to(opponent).emit(
                    "draw_declined"
                );
            }
        }
    );

    // =============================
    // RESIGN
    // =============================

    socket.on(
        "resign_game",
        ({ roomId }) => {
            const g =
                games.get(roomId);

            if (!g) {
                return;
            }

            if (
                socket.id !==
                g.players.w &&
                socket.id !==
                g.players.b
            ) {
                return;
            }

            const winner =
                socket.id ===
                    g.players.w
                    ? g.players.b
                    : g.players.w;

            io.to(roomId).emit(
                "game_over",
                {
                    type: "resign",
                    winner,
                }
            );

            games.delete(roomId);
        }
    );

    // =============================
    // DISCONNECT
    // =============================

    socket.on("disconnect", () => {
        console.log(
            "Disconnected:",
            socket.id
        );

        // =========================
        // AUTH USER CLEANUP
        // =========================

        const authId =
            socket.data.authId;

        if (
            authId &&
            authenticatedUsers.get(
                authId
            ) === socket.id
        ) {
            authenticatedUsers.delete(
                authId
            );

            console.log(
                "AUTH SESSION REMOVED:",
                authId
            );
        }

        // =========================
        // WAITING PLAYER
        // =========================

        if (
            waitingPlayer?.id ===
            socket.id
        ) {
            waitingPlayer = null;

            console.log(
                "Removed disconnected player from waiting queue"
            );
        }

        // =========================
        // GAME
        // =========================

        const roomId =
            socketToRoom.get(
                socket.id
            );

        if (!roomId) {
            return;
        }

        const g =
            games.get(roomId);

        if (g) {
            const winner =
                socket.id ===
                    g.players.w
                    ? g.players.b
                    : g.players.w;

            io.to(roomId).emit(
                "game_over",
                {
                    type:
                        "disconnect",

                    winner,
                }
            );

            games.delete(roomId);
        }

        // =========================
        // BOT
        // =========================

        const bot =
            botGames.get(roomId);

        if (bot?.engine) {
            try {
                bot.engine.kill();
            } catch (error) {
                console.log(
                    "ENGINE KILL ERROR:",
                    error
                );
            }
        }

        botGames.delete(roomId);

        socketToRoom.delete(
            socket.id
        );
    });
});

// =============================
// SERVER
// =============================

const PORT =
    process.env.PORT || 3000;

server.listen(
    PORT,
    () => {
        console.log(
            "Server running on",
            PORT
        );
    }
);