import { supabaseAdmin } from "./supabaseAdmin.js";

// =============================
// KONSTANTEN
// =============================

const MAX_MEMBERS = 50;
const MAX_CHAT_MESSAGES_PER_10S = 8;
const CHAT_MESSAGE_MAX_LEN = 300;

const RANK = {
    LEADER: "leader",
    ADMIN: "admin",
    MEMBER: "member",
};

// =============================
// HELPER
// =============================

function isNonEmptyString(value, maxLen = 200) {
    return typeof value === "string" && value.trim().length > 0 && value.length <= maxLen;
}

function clanRoom(clanId) {
    return `clan:${clanId}`;
}

function computeLeague(avgRating) {
    if (avgRating >= 1600) return "Diamant";
    if (avgRating >= 1400) return "Platin";
    if (avgRating >= 1200) return "Gold";
    if (avgRating >= 1000) return "Silber";
    return "Bronze";
}

async function getUsername(userId) {
    const { data } = await supabaseAdmin
        .from("profiles")
        .select("username")
        .eq("id", userId)
        .maybeSingle();

    return data?.username || "Unbekannt";
}

async function getMembership(clanId, userId) {
    const { data } = await supabaseAdmin
        .from("clan_members")
        .select("*")
        .eq("clan_id", clanId)
        .eq("user_id", userId)
        .maybeSingle();

    return data || null;
}

async function getAnyMembership(userId) {
    const { data } = await supabaseAdmin
        .from("clan_members")
        .select("*")
        .eq("user_id", userId)
        .maybeSingle();

    return data || null;
}

async function getMemberCount(clanId) {
    const { count } = await supabaseAdmin
        .from("clan_members")
        .select("*", { count: "exact", head: true })
        .eq("clan_id", clanId);

    return count || 0;
}

async function recomputeLeague(clanId) {
    const { data } = await supabaseAdmin
        .from("clan_members")
        .select("profiles(rating)")
        .eq("clan_id", clanId);

    const ratings = (data || []).map((row) => row.profiles?.rating ?? 1000);
    const avg = ratings.length
        ? ratings.reduce((a, b) => a + b, 0) / ratings.length
        : 1000;

    const league = computeLeague(avg);

    await supabaseAdmin.from("clans").update({ league }).eq("id", clanId);

    return league;
}

// =============================
// SETUP
// =============================
// authenticatedUsers: die Map<authId, socketId> aus dem Hauptserver,
// damit wir online befindliche Nutzer direkt benachrichtigen können
// (z.B. bei einer neuen Clan-Einladung oder einem Kick).
export function setupClanHandlers(io, { authenticatedUsers }) {
    if (!supabaseAdmin) {
        console.warn("Clan-Feature deaktiviert - Supabase-Keys fehlen.");
        return;
    }

    const chatBuckets = new Map(); // socket.id -> timestamps[]
    // ... Rest bleibt exakt gleich

    function allowChatMessage(socketId) {
        const now = Date.now();
        const arr = (chatBuckets.get(socketId) || []).filter(
            (t) => now - t < 10_000
        );

        if (arr.length >= MAX_CHAT_MESSAGES_PER_10S) {
            chatBuckets.set(socketId, arr);
            return false;
        }

        arr.push(now);
        chatBuckets.set(socketId, arr);
        return true;
    }

    async function postSystemMessage(clanId, message) {
        const { data } = await supabaseAdmin
            .from("clan_messages")
            .insert({
                clan_id: clanId,
                sender_id: null,
                sender_username: null,
                type: "system",
                message,
            })
            .select()
            .single();

        io.to(clanRoom(clanId)).emit("clan_message", data);
    }

    function notifyUser(authId, event, payload) {
        const socketId = authenticatedUsers.get(authId);
        if (!socketId) return;

        io.to(socketId).emit(event, payload);
    }

    io.on("connection", (socket) => {
        function requireAuth() {
            const authId = socket.data.authId;
            if (!authId) {
                throw new Error("NOT_AUTHENTICATED");
            }
            return authId;
        }

        function safeHandler(fn) {
            return async (data, ack) => {
                try {
                    const result = await fn(data || {});
                    if (typeof ack === "function") ack({ ok: true, ...result });
                } catch (error) {
                    console.log("CLAN ERROR:", error.message);
                    if (typeof ack === "function") {
                        ack({ ok: false, error: error.message });
                    }
                }
            };
        }

        // =============================
        // CLAN ERSTELLEN
        // =============================

        socket.on(
            "create_clan",
            safeHandler(async ({ name, tag, description }) => {
                const authId = requireAuth();

                if (!isNonEmptyString(name, 40)) {
                    throw new Error("INVALID_NAME");
                }

                const existing = await getAnyMembership(authId);
                if (existing) throw new Error("ALREADY_IN_CLAN");

                const { data: clan, error } = await supabaseAdmin
                    .from("clans")
                    .insert({
                        name: name.trim(),
                        tag: isNonEmptyString(tag, 8) ? tag.trim() : null,
                        description: isNonEmptyString(description, 300)
                            ? description.trim()
                            : null,
                        creator_id: authId,
                    })
                    .select()
                    .single();

                if (error) {
                    if (error.code === "23505") throw new Error("NAME_TAKEN");
                    throw new Error("CREATE_FAILED");
                }

                await supabaseAdmin.from("clan_members").insert({
                    clan_id: clan.id,
                    user_id: authId,
                    rank: RANK.LEADER,
                });

                await recomputeLeague(clan.id);

                socket.join(clanRoom(clan.id));

                console.log("CLAN CREATED:", { id: clan.id, name: clan.name, by: authId });

                return { clan };
            })
        );

        // =============================
        // CLAN BEITRETEN
        // =============================

        socket.on(
            "join_clan",
            safeHandler(async ({ clanId }) => {
                const authId = requireAuth();

                if (!isNonEmptyString(clanId, 100)) throw new Error("INVALID_CLAN");

                const existing = await getAnyMembership(authId);
                if (existing) throw new Error("ALREADY_IN_CLAN");

                const memberCount = await getMemberCount(clanId);
                if (memberCount >= MAX_MEMBERS) throw new Error("CLAN_FULL");

                const { error } = await supabaseAdmin.from("clan_members").insert({
                    clan_id: clanId,
                    user_id: authId,
                    rank: RANK.MEMBER,
                });

                if (error) {
                    if (error.message?.includes("CLAN_FULL")) throw new Error("CLAN_FULL");
                    throw new Error("JOIN_FAILED");
                }

                const username = await getUsername(authId);

                socket.join(clanRoom(clanId));

                io.to(clanRoom(clanId)).emit("clan_member_joined", {
                    userId: authId,
                    username,
                });

                await postSystemMessage(clanId, `${username} ist dem Clan beigetreten.`);
                await recomputeLeague(clanId);

                return {};
            })
        );

        // =============================
        // CLAN VERLASSEN
        // =============================

        socket.on(
            "leave_clan",
            safeHandler(async ({ clanId }) => {
                const authId = requireAuth();

                const membership = await getMembership(clanId, authId);
                if (!membership) throw new Error("NOT_A_MEMBER");

                const username = await getUsername(authId);

                await supabaseAdmin
                    .from("clan_members")
                    .delete()
                    .eq("clan_id", clanId)
                    .eq("user_id", authId);

                socket.leave(clanRoom(clanId));

                let successorMessage = null;

                if (membership.rank === RANK.LEADER) {
                    // Nachfolge: zuerst unter den Admins, sonst unter den Mitgliedern
                    // (jeweils wer am längsten dabei ist).
                    const { data: remaining } = await supabaseAdmin
                        .from("clan_members")
                        .select("*")
                        .eq("clan_id", clanId)
                        .order("joined_at", { ascending: true });

                    if (!remaining || remaining.length === 0) {
                        // Clan war komplett leer -> auflösen
                        await supabaseAdmin.from("clans").delete().eq("id", clanId);
                    } else {
                        const nextAdmin = remaining.find((m) => m.rank === RANK.ADMIN);
                        const successor = nextAdmin || remaining[0];

                        await supabaseAdmin
                            .from("clan_members")
                            .update({ rank: RANK.LEADER })
                            .eq("clan_id", clanId)
                            .eq("user_id", successor.user_id);

                        const successorName = await getUsername(successor.user_id);
                        successorMessage = `${successorName} ist der neue Anführer.`;
                    }
                }

                io.to(clanRoom(clanId)).emit("clan_member_left", {
                    userId: authId,
                    username,
                });

                await postSystemMessage(clanId, `${username} hat den Clan verlassen.`);
                if (successorMessage) await postSystemMessage(clanId, successorMessage);
                await recomputeLeague(clanId);

                return {};
            })
        );

        // =============================
        // MEINEN CLAN LADEN
        // =============================

        socket.on(
            "get_my_clan",
            safeHandler(async () => {
                const authId = requireAuth();

                const membership = await getAnyMembership(authId);
                if (!membership) return { clan: null };

                const { data: clan } = await supabaseAdmin
                    .from("clans")
                    .select("*")
                    .eq("id", membership.clan_id)
                    .single();

                return { clan, myRank: membership.rank };
            })
        );

        // =============================
        // CLAN-DATEN (Roster + letzte Nachrichten)
        // =============================

        socket.on(
            "get_clan_data",
            safeHandler(async ({ clanId }) => {
                requireAuth();

                if (!isNonEmptyString(clanId, 100)) throw new Error("INVALID_CLAN");

                const { data: clan } = await supabaseAdmin
                    .from("clans")
                    .select("*")
                    .eq("id", clanId)
                    .single();

                if (!clan) throw new Error("CLAN_NOT_FOUND");

                const { data: members } = await supabaseAdmin
                    .from("clan_members")
                    .select("user_id, rank, joined_at, profiles(username, avatar, rating)")
                    .eq("clan_id", clanId)
                    .order("joined_at", { ascending: true });

                const { data: messages } = await supabaseAdmin
                    .from("clan_messages")
                    .select("*")
                    .eq("clan_id", clanId)
                    .order("created_at", { ascending: false })
                    .limit(50);

                return {
                    clan,
                    members: members || [],
                    messages: (messages || []).reverse(),
                };
            })
        );

        // =============================
        // CHAT-RAUM BEITRETEN (z.B. nach App-Neustart)
        // =============================

        socket.on(
            "join_clan_room",
            safeHandler(async ({ clanId }) => {
                const authId = requireAuth();

                const membership = await getMembership(clanId, authId);
                if (!membership) throw new Error("NOT_A_MEMBER");

                socket.join(clanRoom(clanId));
                return {};
            })
        );

        // =============================
        // CHAT-NACHRICHT SENDEN
        // =============================

        socket.on(
            "send_clan_message",
            safeHandler(async ({ clanId, message }) => {
                const authId = requireAuth();

                if (
                    !isNonEmptyString(clanId, 100) ||
                    !isNonEmptyString(message, CHAT_MESSAGE_MAX_LEN)
                ) {
                    throw new Error("INVALID_MESSAGE");
                }

                if (!allowChatMessage(socket.id)) throw new Error("RATE_LIMITED");

                const membership = await getMembership(clanId, authId);
                if (!membership) throw new Error("NOT_A_MEMBER");

                const username = await getUsername(authId);

                const { data: saved } = await supabaseAdmin
                    .from("clan_messages")
                    .insert({
                        clan_id: clanId,
                        sender_id: authId,
                        sender_username: username,
                        type: "chat",
                        message: message.slice(0, CHAT_MESSAGE_MAX_LEN),
                    })
                    .select()
                    .single();

                io.to(clanRoom(clanId)).emit("clan_message", saved);

                return {};
            })
        );

        // =============================
        // EINLADUNGEN
        // =============================

        socket.on(
            "invite_to_clan",
            safeHandler(async ({ clanId, username }) => {
                const authId = requireAuth();

                if (!isNonEmptyString(username, 60)) throw new Error("INVALID_USERNAME");

                const requester = await getMembership(clanId, authId);
                if (!requester || requester.rank === RANK.MEMBER) {
                    throw new Error("NOT_ALLOWED");
                }

                const { data: target } = await supabaseAdmin
                    .from("profiles")
                    .select("id, username")
                    .ilike("username", username.trim())
                    .maybeSingle();

                if (!target) throw new Error("USER_NOT_FOUND");

                const targetMembership = await getAnyMembership(target.id);
                if (targetMembership) throw new Error("USER_ALREADY_IN_CLAN");

                const { data: invite, error } = await supabaseAdmin
                    .from("clan_invites")
                    .insert({
                        clan_id: clanId,
                        invited_user_id: target.id,
                        invited_by: authId,
                        status: "pending",
                    })
                    .select()
                    .single();

                if (error) {
                    if (error.code === "23505") throw new Error("ALREADY_INVITED");
                    throw new Error("INVITE_FAILED");
                }

                const { data: clan } = await supabaseAdmin
                    .from("clans")
                    .select("name")
                    .eq("id", clanId)
                    .single();

                notifyUser(target.id, "clan_invite_received", {
                    invite,
                    clanName: clan?.name,
                });

                return { invite };
            })
        );

        socket.on(
            "get_my_invites",
            safeHandler(async () => {
                const authId = requireAuth();

                const { data } = await supabaseAdmin
                    .from("clan_invites")
                    .select("*, clans(name, tag)")
                    .eq("invited_user_id", authId)
                    .eq("status", "pending")
                    .order("created_at", { ascending: false });

                return { invites: data || [] };
            })
        );

        socket.on(
            "respond_clan_invite",
            safeHandler(async ({ inviteId, accept }) => {
                const authId = requireAuth();

                if (!isNonEmptyString(inviteId, 100)) throw new Error("INVALID_INVITE");

                const { data: invite } = await supabaseAdmin
                    .from("clan_invites")
                    .select("*")
                    .eq("id", inviteId)
                    .maybeSingle();

                if (!invite || invite.invited_user_id !== authId || invite.status !== "pending") {
                    throw new Error("INVITE_NOT_FOUND");
                }

                if (!accept) {
                    await supabaseAdmin
                        .from("clan_invites")
                        .update({ status: "declined" })
                        .eq("id", inviteId);

                    return {};
                }

                const existing = await getAnyMembership(authId);
                if (existing) throw new Error("ALREADY_IN_CLAN");

                const memberCount = await getMemberCount(invite.clan_id);
                if (memberCount >= MAX_MEMBERS) throw new Error("CLAN_FULL");

                await supabaseAdmin.from("clan_members").insert({
                    clan_id: invite.clan_id,
                    user_id: authId,
                    rank: RANK.MEMBER,
                });

                await supabaseAdmin
                    .from("clan_invites")
                    .update({ status: "accepted" })
                    .eq("id", inviteId);

                const username = await getUsername(authId);

                socket.join(clanRoom(invite.clan_id));

                io.to(clanRoom(invite.clan_id)).emit("clan_member_joined", {
                    userId: authId,
                    username,
                });

                await postSystemMessage(invite.clan_id, `${username} ist dem Clan beigetreten.`);
                await recomputeLeague(invite.clan_id);

                return { clanId: invite.clan_id };
            })
        );

        // =============================
        // ADMIN-VERWALTUNG (nur Leader)
        // =============================

        socket.on(
            "promote_member",
            safeHandler(async ({ clanId, userId }) => {
                const authId = requireAuth();

                const requester = await getMembership(clanId, authId);
                if (!requester || requester.rank !== RANK.LEADER) {
                    throw new Error("NOT_ALLOWED");
                }

                const target = await getMembership(clanId, userId);
                if (!target || target.rank !== RANK.MEMBER) throw new Error("INVALID_TARGET");

                await supabaseAdmin
                    .from("clan_members")
                    .update({ rank: RANK.ADMIN })
                    .eq("clan_id", clanId)
                    .eq("user_id", userId);

                const username = await getUsername(userId);

                io.to(clanRoom(clanId)).emit("clan_member_promoted", { userId, username });
                await postSystemMessage(clanId, `${username} wurde zum Admin ernannt.`);

                return {};
            })
        );

        socket.on(
            "demote_admin",
            safeHandler(async ({ clanId, userId }) => {
                const authId = requireAuth();

                const requester = await getMembership(clanId, authId);
                if (!requester || requester.rank !== RANK.LEADER) {
                    throw new Error("NOT_ALLOWED");
                }

                const target = await getMembership(clanId, userId);
                if (!target || target.rank !== RANK.ADMIN) throw new Error("INVALID_TARGET");

                await supabaseAdmin
                    .from("clan_members")
                    .update({ rank: RANK.MEMBER })
                    .eq("clan_id", clanId)
                    .eq("user_id", userId);

                const username = await getUsername(userId);

                io.to(clanRoom(clanId)).emit("clan_member_demoted", { userId, username });
                await postSystemMessage(clanId, `${username} ist nun wieder normales Mitglied.`);

                return {};
            })
        );

        // =============================
        // MITGLIED ENTFERNEN
        // =============================

        socket.on(
            "kick_member",
            safeHandler(async ({ clanId, userId }) => {
                const authId = requireAuth();

                const requester = await getMembership(clanId, authId);
                if (!requester || requester.rank === RANK.MEMBER) throw new Error("NOT_ALLOWED");

                const target = await getMembership(clanId, userId);
                if (!target) throw new Error("INVALID_TARGET");

                if (target.rank === RANK.LEADER) throw new Error("CANNOT_KICK_LEADER");

                // Admins dürfen nur normale Mitglieder rauswerfen, nicht andere Admins.
                if (requester.rank === RANK.ADMIN && target.rank === RANK.ADMIN) {
                    throw new Error("NOT_ALLOWED");
                }

                await supabaseAdmin
                    .from("clan_members")
                    .delete()
                    .eq("clan_id", clanId)
                    .eq("user_id", userId);

                const username = await getUsername(userId);

                io.to(clanRoom(clanId)).emit("clan_member_left", { userId, username, kicked: true });
                await postSystemMessage(clanId, `${username} wurde aus dem Clan entfernt.`);
                await recomputeLeague(clanId);

                notifyUser(userId, "kicked_from_clan", { clanId });

                const targetSocketId = authenticatedUsers.get(userId);
                if (targetSocketId) {
                    io.sockets.sockets.get(targetSocketId)?.leave(clanRoom(clanId));
                }

                return {};
            })
        );

        socket.on("disconnect", () => {
            chatBuckets.delete(socket.id);
        });
    });
}