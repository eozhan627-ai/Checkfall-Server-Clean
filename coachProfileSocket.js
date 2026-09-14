import { getTopWeaknesses } from "./weaknessRanking.js";
import { generateLesson } from "./lessonGenerator.js";
import { supabaseAdmin } from "./supabaseAdmin.js";

export function setupCoachProfileHandlers(io) {
    io.on("connection", (socket) => {
        socket.on("get_weaknesses", async (_payload, ack) => {
            try {
                const authId = socket.data.authId;
                if (!authId) throw new Error("NOT_AUTHENTICATED");
                const weaknesses = await getTopWeaknesses(authId);
                ack({ ok: true, weaknesses });
            } catch (error) {
                ack({ ok: false, error: error.message });
            }
        });

        socket.on("generate_lesson", async ({ mistakeType }, ack) => {
            try {
                const authId = socket.data.authId;
                if (!authId) throw new Error("NOT_AUTHENTICATED");
                const lesson = await generateLesson(authId, mistakeType);
                ack({ ok: true, lesson });
            } catch (error) {
                ack({ ok: false, error: error.message });
            }
        });

        socket.on("get_lessons", async (_payload, ack) => {
            try {
                const authId = socket.data.authId;
                if (!authId) throw new Error("NOT_AUTHENTICATED");
                const { data } = await supabaseAdmin
                    .from("personal_lessons")
                    .select("*")
                    .eq("user_id", authId)
                    .order("created_at", { ascending: false });
                ack({ ok: true, lessons: data });
            } catch (error) {
                ack({ ok: false, error: error.message });
            }
        });
    });
}