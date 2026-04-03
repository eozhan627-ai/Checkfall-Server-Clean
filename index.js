import http from "http";
import express from "express";
import path from "path";
import multer from "multer";
import { Server } from "socket.io";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());

// =============================
// AVATAR UPLOAD
// =============================
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, path.join(__dirname, "avatars")),
  filename: (req, file, cb) => {
    const userId = req.body.userId;
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `avatar_${userId}${ext}`);
  },
});

const upload = multer({ storage });
app.post("/upload-avatar", upload.single("avatar"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Keine Datei" });
  const url = `http://${req.hostname}:3000/avatars/${req.file.filename}`;
  res.json({ url });
});
app.use("/avatars", express.static(path.join(__dirname, "avatars")));

// =============================
// SOCKET SERVER
// =============================
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

let waitingPlayer = null;

io.on("connection", (socket) => {
  console.log("Spieler verbunden:", socket.id);

  // =============================
  // BOT-MATCH (Dummy)
  // =============================
  socket.on("find_bot_match", (data) => {
    const { name, avatar } = data;
    const roomId = `bot_${socket.id}`;
    socket.join(roomId);

    io.to(roomId).emit("game_start", {
      roomId,
      white: socket.id,
      black: "bot",
      whiteName: name,
      blackName: "Bot",
      whiteAvatar: avatar || "",
      blackAvatar: "",
    });
  });

  // =============================
  // SPIELERZUG (PvP)
  // =============================
  socket.on("player_move", ({ roomId, move }) => {
    // Broadcast an Gegner
    socket.to(roomId).emit("opponent_move", move);
  });

  // =============================
  // MATCHMAKING
  // =============================
  socket.on("find_match", (data) => {
    if (!data) return console.log("find_match ohne Daten");

    const { name, avatar } = data;
    const player = { id: socket.id, name, avatar };

    if (!waitingPlayer) {
      waitingPlayer = player;
      socket.emit("waiting");
      return;
    }

    const roomId = `${waitingPlayer.id}_${socket.id}`;
    socket.join(roomId);
    io.sockets.sockets.get(waitingPlayer.id)?.join(roomId);

    io.to(roomId).emit("game_start", {
      roomId,
      white: waitingPlayer.id,
      black: socket.id,
      whiteName: waitingPlayer.name,
      blackName: player.name,
      whiteAvatar: waitingPlayer.avatar || "",
      blackAvatar: player.avatar || "",
    });

    waitingPlayer = null;
  });

  // =============================
  // AUFGABE
  // =============================
  socket.on("resign_game", ({ roomId, name }) => {
    const room = io.sockets.adapter.rooms.get(roomId);
    if (!room) return;
    io.to(roomId).emit("game_over", {
      type: "resign",
      loser: name,
      message: `${name} hat aufgegeben. Dein Gegner gewinnt!`,
    });
  });

  // =============================
  // REMIS
  // =============================
  socket.on("offer_draw", ({ roomId }) => socket.to(roomId).emit("draw_offer"));
  socket.on("answer_draw", ({ roomId, accept }) => {
    if (accept) io.to(roomId).emit("game_over", { type: "draw", message: "Remis vereinbart!" });
    else socket.to(roomId).emit("draw_declined");
  });

  // =============================
  // DISCONNECT
  // =============================
  socket.on("disconnect", () => {
    if (waitingPlayer?.id === socket.id) waitingPlayer = null;
    console.log("Spieler getrennt:", socket.id);
  });
});

// =============================
// SERVER START
// =============================
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`✅ Server läuft auf Port ${PORT}`));