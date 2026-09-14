import { supabaseAdmin } from "./supabaseAdmin.js";

const DAILY_LIMIT = { silver: 5, gold: 20, diamond: 200 };
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = "claude-haiku-4-5-20251001";

const COACH_NAME = "Uhu"; // NEU: hier den Namen des Maskottchens aendern, falls gewuenscht

export function setupCoachHandlers(io) {
    io.on("connection", (socket) => {
        socket.on("coach_message", async ({ gameId, moveIndex, question }, ack) => {
            try {
                const authId = socket.data.authId;
                if (!authId) throw new Error("NOT_AUTHENTICATED");

                if (typeof question !== "string" || !question.trim() || question.length > 500) {
                    throw new Error("INVALID_QUESTION");
                }

                const { data: profile } = await supabaseAdmin
                    .from("profiles")
                    .select("vip_tier")
                    .eq("id", authId)
                    .maybeSingle();

                const tier = profile?.vip_tier || "none";
                const limit = DAILY_LIMIT[tier];
                if (!limit) throw new Error("NOT_VIP");

                const today = new Date().toISOString().slice(0, 10);

                const { data: usage } = await supabaseAdmin
                    .from("coach_usage")
                    .select("count")
                    .eq("user_id", authId)
                    .eq("usage_date", today)
                    .maybeSingle();

                const currentCount = usage?.count || 0;
                if (currentCount >= limit) throw new Error("LIMIT_REACHED");

                const { data: game } = await supabaseAdmin
                    .from("games")
                    .select("user_id, pgn, analysis")
                    .eq("id", gameId)
                    .maybeSingle();

                if (!game || game.user_id !== authId) throw new Error("GAME_NOT_FOUND");

                const moves = game.analysis?.moves || [];
                const move = typeof moveIndex === "number" && moveIndex > 0 ? moves[moveIndex - 1] : null;

                const contextText = move
                    ? `Zug ${move.moveNumber} (${move.san}), Klassifizierung "${move.classification}", Stellungsbewertung danach: ${move.evalCp} Centipawns (positiv = Vorteil Weiss).`
                    : `Allgemeine Frage zur Partie. PGN: ${game.pgn}`;

                const systemPrompt =
                    `Du bist ${COACH_NAME}, ein freundlicher, aufmunternder Schach-Coach in der App POV Check. ` +
                    "Erklaere Schachzuege verstaendlich fuer Hobbyspieler, konkret und kurz (max. 4 Saetze), " +
                    "ohne Fachjargon zu ueberladen. Sei ermutigend, auch bei Fehlern.";

                const response = await fetch("https://api.anthropic.com/v1/messages", {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        "x-api-key": ANTHROPIC_API_KEY,
                        "anthropic-version": "2023-06-01",
                    },
                    body: JSON.stringify({
                        model: MODEL,
                        max_tokens: 400,
                        system: systemPrompt,
                        messages: [{ role: "user", content: `${contextText}\n\nFrage: ${question.trim()}` }],
                    }),
                });

                const data = await response.json();
                const answer = data?.content?.[0]?.text || "Entschuldige, da ist etwas schiefgelaufen.";

                await supabaseAdmin
                    .from("coach_usage")
                    .upsert(
                        { user_id: authId, usage_date: today, count: currentCount + 1 },
                        { onConflict: "user_id,usage_date" }
                    );

                if (typeof ack === "function") {
                    ack({ ok: true, answer, remaining: limit - (currentCount + 1) });
                }
            } catch (error) {
                console.log("COACH ERROR:", error.message);
                if (typeof ack === "function") ack({ ok: false, error: error.message });
            }
        });
    });
}