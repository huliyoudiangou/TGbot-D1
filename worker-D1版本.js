/**
 * Telegram Bot Worker v3.12 (One Card Edition)
 * 特性: 内存级防抖 | 自动清理旧卡 | 永远只保留一张通知 | 聚合收件箱
 */

// --- 静态配置与缓存 ---
// 内存缓存结构优化：user_locks 用于毫秒级并发防抖
const CACHE = { data: {}, ts: 0, ttl: 60000, user_locks: {} };
const DEFAULTS = {
    welcome_msg: "欢迎！使用前请先完成人机验证。",
    verif_q: "1+1=?\n提示：答案在简介中。", verif_a: "3",
    block_threshold: "5", enable_admin_receipt: "true",
    enable_image_forwarding: "true", enable_link_forwarding: "true", enable_text_forwarding: "true",
    enable_channel_forwarding: "true", enable_forward_forwarding: "true", enable_audio_forwarding: "true", enable_sticker_forwarding: "true",
    backup_group_id: "", unread_topic_id: ""
};

const MSG_TYPES = [
    { check: m => m.forward_from || m.forward_from_chat, key: 'enable_forward_forwarding', name: "转发消息", extra: m => m.forward_from_chat?.type === 'channel' ? 'enable_channel_forwarding' : null },
    { check: m => m.audio || m.voice, key: 'enable_audio_forwarding', name: "语音/音频" },
    { check: m => m.sticker || m.animation, key: 'enable_sticker_forwarding', name: "贴纸/GIF" },
    { check: m => m.photo || m.video || m.document, key: 'enable_image_forwarding', name: "媒体文件" },
    { check: m => (m.entities||[]).some(e => ['url','text_link'].includes(e.type)), key: 'enable_link_forwarding', name: "链接" },
    { check: m => m.text, key: 'enable_text_forwarding', name: "纯文本" }
];

// --- 核心入口 ---
export default {
    async fetch(req, env, ctx) {
        ctx.waitUntil(dbInit(env));
        const url = new URL(req.url);
        
        if (req.method === "GET") {
            if (url.pathname === "/verify") return handleVerifyPage(url, env);
            if (url.pathname === "/") return new Response("Bot Running v3.12", { status: 200 });
        }
        if (req.method === "POST") {
            if (url.pathname === "/submit_token") return handleTokenSubmit(req, env);
            try {
                const update = await req.json();
                ctx.waitUntil(handleUpdate(update, env, ctx));
                return new Response("OK");
            } catch (e) { return new Response("Err", { status: 500 }); }
        }
        return new Response("404", { status: 404 });
    }
};

// --- 数据库封装 (D1) ---
const sql = async (env, query, args = [], type = 'run') => {
    try {
        const stmt = env.TG_BOT_DB.prepare(query).bind(...(Array.isArray(args) ? args : [args]));
        return type === 'run' ? await stmt.run() : await stmt[type]();
    } catch (e) { console.error("DB Err:", e.message); return null; }
};

async function getCfg(key, env, fallback) {
    const now = Date.now();
    if (CACHE.ts && (now - CACHE.ts) < CACHE.ttl && CACHE.data[key] !== undefined) return CACHE.data[key];
    
    const rows = await sql(env, "SELECT * FROM config", [], 'all');
    if (rows && rows.results) {
        CACHE.data = {};
        rows.results.forEach(r => CACHE.data[r.key] = r.value);
        CACHE.ts = now;
    }
    const val = CACHE.data[key];
    if (val !== undefined) return val;
    const envKey = key.toUpperCase().replace(/_MSG|_Q|_A/, m => ({'_MSG':'_MESSAGE','_Q':'_QUESTION','_A':'_ANSWER'}[m]));
    return env[envKey] || (fallback !== undefined ? fallback : (DEFAULTS[key] || ""));
}

async function setCfg(key, val, env) {
    await sql(env, "INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)", [key, val]);
    CACHE.ts = 0;
}

async function getUser(id, env) {
    let u = await sql(env, "SELECT * FROM users WHERE user_id = ?", id, 'first');
    if (!u) {
        try { await sql(env, "INSERT INTO users (user_id, user_state) VALUES (?, 'new')", id); } catch {}
        u = await sql(env, "SELECT * FROM users WHERE user_id = ?", id, 'first') || { user_id: id, user_state: 'new', is_blocked: 0, block_count: 0, first_message_sent: 0, topic_id: null, user_info: {} };
    }
    u.is_blocked = !!u.is_blocked; u.first_message_sent = !!u.first_message_sent;
    u.user_info = u.user_info_json ? JSON.parse(u.user_info_json) : {};
    return u;
}

async function updUser(id, data, env) {
    if (data.user_info) { data.user_info_json = JSON.stringify(data.user_info); delete data.user_info; }
    const keys = Object.keys(data); if (!keys.length) return;
    await sql(env, `UPDATE users SET ${keys.map(k => `${k}=?`).join(',')} WHERE user_id=?`, [...keys.map(k => typeof data[k] === 'boolean' ? (data[k]?1:0) : data[k]), id]);
}

async function dbInit(env) {
    if (!env.TG_BOT_DB) return;
    try {
        await env.TG_BOT_DB.batch([
            env.TG_BOT_DB.prepare(`CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT)`),
            env.TG_BOT_DB.prepare(`CREATE TABLE IF NOT EXISTS users (user_id TEXT PRIMARY KEY, user_state TEXT DEFAULT 'new', is_blocked INTEGER DEFAULT 0, block_count INTEGER DEFAULT 0, first_message_sent INTEGER DEFAULT 0, topic_id TEXT, user_info_json TEXT)`),
            env.TG_BOT_DB.prepare(`CREATE TABLE IF NOT EXISTS messages (user_id TEXT, message_id TEXT, text TEXT, date INTEGER, PRIMARY KEY (user_id, message_id))`)
        ]);
    } catch(e) { console.error("DB Init Fail:", e); }
}

// --- Telegram API ---
async function api(token, method, body) {
    const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const d = await r.json(); if (!d.ok) throw new Error(d.description); return d.result;
}

async function registerCommands(env) {
    try {
        await api(env.BOT_TOKEN, "setMyCommands", { commands: [{ command: "start", description: "开始咨询 / Start" }], scope: { type: "default" } });
        const list = [...(env.ADMIN_IDS||"").split(/[,，]/), ...(await getJsonCfg('authorized_admins', env))];
        const admins = [...new Set(list.map(i=>i.trim()).filter(Boolean))];
        for (const id of admins) {
            await api(env.BOT_TOKEN, "setMyCommands", {
                commands: [{ command: "start", description: "⚙️ 管理面板" }, { command: "help", description: "📄 帮助说明" }],
                scope: { type: "chat", chat_id: id }
            });
        }
    } catch (e) { console.error("Cmd Reg Err:", e); }
}

// --- 主流程 ---
async function handleUpdate(update, env, ctx) {
    const msg = update.message || update.edited_message;
    if (!msg) return update.callback_query ? handleCallback(update.callback_query, env) : null;
    if (update.edited_message) return (msg.chat.type === "private") ? handleEdit(msg, env) : null;
    if (msg.chat.type === "private") await handlePrivate(msg, env, ctx);
    else if (msg.chat.id.toString() === env.ADMIN_GROUP_ID) await handleAdminReply(msg, env);
}

async function handlePrivate(msg, env, ctx) {
    const id = msg.chat.id.toString(), text = msg.text || "";
    const isAdm = (env.ADMIN_IDS || "").includes(id);
    
    if (text === "/start") {
        if (isAdm && ctx) ctx.waitUntil(registerCommands(env));
        return isAdm ? sendAdminMenu(id, env) : sendStart(id, env);
    }
    if (text === "/help" && isAdm) return api(env.BOT_TOKEN, "sendMessage", { chat_id: id, text: "ℹ️ <b>帮助说明</b>\n• 回复用户消息即可对话\n• /start 打开控制面板", parse_mode: "HTML" });

    const u = await getUser(id, env);
    if (u.is_blocked) return;

    if (await isAuthAdmin(id, env)) {
        if(u.user_state !== "verified") { await updUser(id, { user_state: "verified" }, env); u.user_state = "verified"; }
        if(text === "/start" && ctx) ctx.waitUntil(registerCommands(env));
    }

    if (isAdm) {
        const state = await getCfg(`admin_state:${id}`, env);
        if (state) return handleAdminInput(id, text, JSON.parse(state), env);
    }

    const state = u.user_state;
    if (state === "new" || state === "pending_turnstile") return sendStart(id, env);
    if (state === "pending_verification") return verifyAnswer(id, text, env);
    if (state === "verified") return handleVerifiedMsg(msg, u, env);
}

async function sendStart(id, env) {
    const u = await getUser(id, env);
    const url = (env.WORKER_URL || "").replace(/\/$/, '');
    if (!url || !env.TURNSTILE_SITE_KEY) return api(env.BOT_TOKEN, "sendMessage", { chat_id: id, text: "⚠️ 配置缺失: WORKER_URL 或 TURNSTILE_KEY" });

    if (['new', 'pending_turnstile'].includes(u.user_state)) {
        await updUser(id, { user_state: "pending_turnstile" }, env);
        await api(env.BOT_TOKEN, "sendMessage", { 
            chat_id: id, text: (await getCfg('welcome_msg', env)) + "\n\n请点击验证：", 
            reply_markup: { inline_keyboard: [[{ text: "🛡️ 安全验证", web_app: { url: `${url}/verify?user_id=${id}` } }]] } 
        });
    } else if (u.user_state === 'pending_verification') {
        api(env.BOT_TOKEN, "sendMessage", { chat_id: id, text: "请回答验证问题：\n" + await getCfg('verif_q', env) });
    } else {
        api(env.BOT_TOKEN, "sendMessage", { chat_id: id, text: "已验证，可直接发送消息。" });
    }
}

async function handleVerifiedMsg(msg, u, env) {
    const id = u.user_id, text = msg.text || "";
    
    if (!u.first_message_sent && (!text || msg.photo || msg.video)) 
        return api(env.BOT_TOKEN, "sendMessage", { chat_id: id, text: "⚠️ 首次消息必须是纯文本。" });

    if (text) {
        const kws = await getJsonCfg('block_keywords', env);
        if (kws.some(k => new RegExp(k, 'gi').test(text))) {
            const count = u.block_count + 1;
            const max = parseInt(await getCfg('block_threshold', env)) || 5;
            await updUser(id, { block_count: count, is_blocked: count >= max }, env);
            return api(env.BOT_TOKEN, "sendMessage", { chat_id: id, text: count >= max ? "❌ 触发多次屏蔽词，已封禁。" : `⚠️ 含屏蔽词 (${count}/${max})，已拦截。` });
        }
    }

    for (const t of MSG_TYPES) {
        if (t.check(msg)) {
            const k = t.extra ? t.extra(msg) : t.key;
            if (k && !(await getBool(k, env))) 
                return api(env.BOT_TOKEN, "sendMessage", { chat_id: id, text: `⚠️ 此类消息 (${t.name}) 已被设置为不接收。` });
            break;
        }
    }

    if (text) {
        const rules = await getJsonCfg('keyword_responses', env);
        const match = rules.find(r => new RegExp(r.keywords, 'gi').test(text));
        if (match) return api(env.BOT_TOKEN, "sendMessage", { chat_id: id, text: "自动回复：\n" + match.response });
    }

    await relayToTopic(msg, u, env);
}

async function relayToTopic(msg, u, env) {
    const uid = u.user_id, uMeta = getUMeta(msg.from, msg.date);
    let tid = u.topic_id;

    if (!tid) {
        try {
            const t = await api(env.BOT_TOKEN, "createForumTopic", { chat_id: env.ADMIN_GROUP_ID, name: uMeta.topicName });
            tid = t.message_thread_id.toString();
            await updUser(uid, { topic_id: tid, user_info: { ...u.user_info, name: uMeta.name, username: uMeta.username } }, env);
            await api(env.BOT_TOKEN, "sendMessage", { chat_id: env.ADMIN_GROUP_ID, message_thread_id: tid, text: uMeta.card, parse_mode: "HTML", reply_markup: getBtns(uid, u.is_blocked) });
        } catch (e) { return api(env.BOT_TOKEN, "sendMessage", { chat_id: uid, text: "系统繁忙，请稍后重试" }); }
    }

    try {
        await api(env.BOT_TOKEN, "copyMessage", { chat_id: env.ADMIN_GROUP_ID, from_chat_id: uid, message_id: msg.message_id, message_thread_id: tid });
        api(env.BOT_TOKEN, "sendMessage", { chat_id: uid, text: "✅ 已送达", reply_to_message_id: msg.message_id, disable_notification: true }).catch(()=>{});
        
        if (!u.first_message_sent) await updUser(uid, { first_message_sent: 1 }, env);
        if (msg.text) await sql(env, "INSERT OR REPLACE INTO messages (user_id, message_id, text, date) VALUES (?,?,?,?)", [uid, msg.message_id, msg.text, msg.date]);
        
        await handleBackup(msg, uMeta, env);
        await handleInbox(env, msg, u, tid, uMeta); 
    } catch (e) {
        if (e.message.includes("thread")) { 
            await updUser(uid, { topic_id: null }, env);
            await api(env.BOT_TOKEN, "sendMessage", { chat_id: uid, text: "会话过期，请重发。" });
        }
    }
}

// --- 收件箱聚合 (One Card 逻辑核心) ---
async function handleInbox(env, msg, u, tid, uMeta) {
    let inboxId = await getCfg('unread_topic_id', env);
    if (!inboxId) {
        try {
            const t = await api(env.BOT_TOKEN, "createForumTopic", { chat_id: env.ADMIN_GROUP_ID, name: "🔔 未读消息" });
            inboxId = t.message_thread_id.toString();
            await setCfg('unread_topic_id', inboxId, env);
        } catch { return; }
    }

    // 1. 内存级防抖 (毫秒级并发控制)
    const now = Date.now();
    if (CACHE.user_locks[u.user_id] && now - CACHE.user_locks[u.user_id] < 5000) return;
    
    // 2. 数据库级防抖 (5分钟)
    const lastNotify = u.user_info.last_notify || 0;
    if (now - lastNotify < 300000) return; 

    // 锁定内存
    CACHE.user_locks[u.user_id] = now;

    // 3. 核心逻辑：尝试删除上一张卡片
    if (u.user_info.inbox_msg_id) {
        await api(env.BOT_TOKEN, "deleteMessage", { 
            chat_id: env.ADMIN_GROUP_ID, 
            message_id: u.user_info.inbox_msg_id 
        }).catch(() => {}); // 忽略删除失败（比如已经被手动删了）
    }

    const gid = env.ADMIN_GROUP_ID.toString().replace(/^-100/, '');
    const preview = msg.text ? (msg.text.length > 20 ? msg.text.substring(0, 20)+"..." : msg.text) : "[媒体]";
    const card = `<b>🔔 新消息</b>\n${uMeta.card}\n📝 <b>预览:</b> ${escape(preview)}`;

    try {
        const newMsg = await api(env.BOT_TOKEN, "sendMessage", { 
            chat_id: env.ADMIN_GROUP_ID, message_thread_id: inboxId, text: card, parse_mode: "HTML", 
            reply_markup: { inline_keyboard: [[{ text: "🚀 直达回复", url: `https://t.me/c/${gid}/${tid}` }, { text: "✅ 已阅/删除", callback_data: `inbox:del:${u.user_id}` }]] }
        });
        
        // 4. 保存新的消息 ID
        await updUser(u.user_id, { 
            user_info: { ...u.user_info, last_notify: now, inbox_msg_id: newMsg.message_id } 
        }, env);

    } catch (e) {
        if (e.message.includes("thread")) await setCfg('unread_topic_id', "", env);
    }
}

async function handleBackup(msg, meta, env) {
    const bid = await getCfg('backup_group_id', env);
    if (!bid) return;
    const head = `<b>📨 备份</b> ${meta.name} (${meta.userId})\n`;
    try {
        if (msg.text) await api(env.BOT_TOKEN, "sendMessage", { chat_id: bid, text: head + msg.text, parse_mode: "HTML" });
        else { await api(env.BOT_TOKEN, "sendMessage", { chat_id: bid, text: head, parse_mode: "HTML" }); await api(env.BOT_TOKEN, "copyMessage", { chat_id: bid, from_chat_id: msg.chat.id, message_id: msg.message_id }); }
    } catch {}
}

async function handleAdminReply(msg, env) {
    if (!msg.message_thread_id || msg.from.is_bot || !(await isAuthAdmin(msg.from.id, env))) return;
    const uid = (await sql(env, "SELECT user_id FROM users WHERE topic_id = ?", msg.message_thread_id.toString(), 'first'))?.user_id;
    if (!uid) return;
    try {
        await api(env.BOT_TOKEN, "copyMessage", { chat_id: uid, from_chat_id: msg.chat.id, message_id: msg.message_id });
        if (await getBool('enable_admin_receipt', env)) api(env.BOT_TOKEN, "sendMessage", { chat_id: msg.chat.id, message_thread_id: msg.message_thread_id, text: "✅ 已回复", reply_to_message_id: msg.message_id, disable_notification: true }).catch(()=>{});
    } catch (e) { api(env.BOT_TOKEN, "sendMessage", { chat_id: msg.chat.id, message_thread_id: msg.message_thread_id, text: "❌ 发送失败: " + e.message }); }
}

async function handleEdit(msg, env) {
    const u = await getUser(msg.from.id.toString(), env);
    if (!u.topic_id) return;
    const old = await sql(env, "SELECT text, date FROM messages WHERE user_id=? AND message_id=?", [u.user_id, msg.message_id], 'first');
    const newTxt = msg.text || msg.caption || "[非文本]";
    await api(env.BOT_TOKEN, "sendMessage", { chat_id: env.ADMIN_GROUP_ID, message_thread_id: u.topic_id, text: `✏️ <b>消息修改</b>\n前: ${escape(old?.text||"?")}\n后: ${escape(newTxt)}`, parse_mode: "HTML" });
    if (old) await sql(env, "INSERT OR REPLACE INTO messages (user_id,message_id,text,date) VALUES (?,?,?,?)", [u.user_id, msg.message_id, newTxt, old.date]);
}

// --- Turnstile ---
async function handleVerifyPage(url, env) {
    const uid = url.searchParams.get('user_id');
    if (!uid || !env.TURNSTILE_SITE_KEY) return new Response("Miss Config", { status: 400 });
    return new Response(`<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><script src="https://telegram.org/js/telegram-web-app.js"></script><script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script><style>body{display:flex;justify-content:center;align-items:center;height:100vh;background:#fff;font-family:sans-serif}#c{text-align:center;padding:20px;background:#f0f0f0;border-radius:10px}</style></head><body><div id="c"><h3>🛡️ 安全验证</h3><div class="cf-turnstile" data-sitekey="${env.TURNSTILE_SITE_KEY}" data-callback="S"></div><div id="m"></div></div><script>const tg=window.Telegram.WebApp;tg.ready();function S(t){document.getElementById('m').innerText='验证中...';fetch('/submit_token',{method:'POST',body:JSON.stringify({token:t,userId:'${uid}'})}).then(r=>r.json()).then(d=>{if(d.success){document.getElementById('m').innerText='✅';setTimeout(()=>tg.close(),1000)}else{document.getElementById('m').innerText='❌'}})}</script></body></html>`, { headers: { "Content-Type": "text/html" } });
}

async function handleTokenSubmit(req, env) {
    try {
        const { token, userId } = await req.json();
        const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ secret: env.TURNSTILE_SECRET_KEY, response: token }) });
        if (!(await r.json()).success) throw new Error("Invalid Token");
        await updUser(userId, { user_state: "pending_verification" }, env);
        api(env.BOT_TOKEN, "sendMessage", { chat_id: userId, text: "✅ 验证通过！" });
        api(env.BOT_TOKEN, "sendMessage", { chat_id: userId, text: "第二步：\n" + await getCfg('verif_q', env) });
        return new Response(JSON.stringify({ success: true }));
    } catch (e) { return new Response(JSON.stringify({ success: false }), { status: 400 }); }
}

async function verifyAnswer(id, ans, env) {
    if (ans.trim() === (await getCfg('verif_a', env)).trim()) {
        await updUser(id, { user_state: "verified" }, env);
        api(env.BOT_TOKEN, "sendMessage", { chat_id: id, text: "✅ 验证完成！请发送第一条消息 (纯文本)。" });
    } else api(env.BOT_TOKEN, "sendMessage", { chat_id: id, text: "❌ 答案错误" });
}

// --- 菜单与管理 ---
async function handleCallback(cb, env) {
    const { data, message: msg, from } = cb;
    const [act, p1, p2, p3] = data.split(':');
    
    if (act === 'inbox' && p1 === 'del') {
        const targetUid = p2;
        await api(env.BOT_TOKEN, "deleteMessage", { chat_id: msg.chat.id, message_id: msg.message_id }).catch(()=>{});
        // 重置防抖，允许立即推送新消息
        if (targetUid) {
            const u = await getUser(targetUid, env);
            await updUser(targetUid, { user_info: { ...u.user_info, last_notify: 0 } }, env);
        }
        return api(env.BOT_TOKEN, "answerCallbackQuery", { callback_query_id: cb.id, text: "已处理" });
    }

    if (act === 'config') {
        if (!(env.ADMIN_IDS||"").includes(from.id.toString())) return api(env.BOT_TOKEN, "answerCallbackQuery", { callback_query_id: cb.id, text: "无权操作", show_alert: true });
        await api(env.BOT_TOKEN, "answerCallbackQuery", { callback_query_id: cb.id });
        return handleAdminConfig(msg.chat.id, msg.message_id, p1, p2, p3, env);
    }
    
    if (msg.chat.id.toString() === env.ADMIN_GROUP_ID) { 
        await api(env.BOT_TOKEN, "answerCallbackQuery", { callback_query_id: cb.id });
        if (act === 'pin_card') api(env.BOT_TOKEN, "pinChatMessage", { chat_id: msg.chat.id, message_id: msg.message_id });
        else if (['block','unblock'].includes(act)) {
            const isB = act === 'block';
            await updUser(p1, { is_blocked: isB, block_count: 0 }, env);
            api(env.BOT_TOKEN, "editMessageReplyMarkup", { chat_id: msg.chat.id, message_id: msg.message_id, reply_markup: getBtns(p1, isB) });
            api(env.BOT_TOKEN, "sendMessage", { chat_id: msg.chat.id, message_thread_id: msg.message_thread_id, text: isB ? "❌ 已屏蔽" : "✅ 已解封" });
        }
    }
}

async function handleAdminConfig(cid, mid, type, key, val, env) {
    const edit = (txt, k) => api(env.BOT_TOKEN, mid?"editMessageText":"sendMessage", { chat_id: cid, message_id: mid, text: txt, parse_mode: "HTML", reply_markup: k });
    const back = { text: "🔙 返回", callback_data: "config:menu" };
    
    if (!type || type === 'menu') { 
        if (!key) return edit("⚙️ <b>控制面板</b>", { inline_keyboard: [[{text:"📝 基础",callback_data:"config:menu:base"},{text:"🤖 自动回复",callback_data:"config:menu:ar"}], [{text:"🚫 屏蔽词",callback_data:"config:menu:kw"},{text:"🛠 过滤",callback_data:"config:menu:fl"}], [{text:"👮 协管",callback_data:"config:menu:auth"},{text:"💾 备份/通知",callback_data:"config:menu:bak"}]] });
        if (key === 'base') return edit(`基础配置`, { inline_keyboard: [[{text:"欢迎语",callback_data:"config:edit:welcome_msg"},{text:"问题",callback_data:"config:edit:verif_q"},{text:"答案",callback_data:"config:edit:verif_a"}], [back]] });
        if (key === 'fl') return handleFilterMenu(cid, mid, env);
        if (key === 'bak') {
            const bid = await getCfg('backup_group_id', env), uid = await getCfg('unread_topic_id', env);
            return edit(`💾 <b>备份与通知</b>\n备份群: ${bid||"无"}\n聚合话题: ${uid?`✅ (ID:${uid})`:"⏳ 等待触发"}`, { inline_keyboard: [[{text:"设备份群",callback_data:"config:edit:backup_group_id"},{text:"清备份",callback_data:"config:cl:backup_group_id"}],[{text:"重置聚合话题",callback_data:"config:cl:unread_topic_id"}],[back]] });
        }
        if (['ar','kw','auth'].includes(key)) return handleListMenu(cid, mid, key, env);
    }

    if (type === 'toggle') { await setCfg(key, val, env); return handleFilterMenu(cid, mid, env); }
    if (type === 'cl') { await setCfg(key, key==='authorized_admins'?'[]':'', env); return handleAdminConfig(cid, mid, 'menu', key==='unread_topic_id'?'bak':(key==='authorized_admins'?'auth':'bak'), null, env); }
    if (type === 'del') { 
        let l = await getJsonCfg(key === 'kw' ? 'block_keywords' : 'keyword_responses', env);
        l = l.filter(i => (i.id||i).toString() !== val);
        await setCfg(key === 'kw' ? 'block_keywords' : 'keyword_responses', JSON.stringify(l), env);
        return handleListMenu(cid, mid, key, env);
    }
    if (type === 'edit' || type === 'add') { 
        await setCfg(`admin_state:${cid}`, JSON.stringify({ action: 'input', key: key + (type==='add'?'_add':'') }), env);
        return api(env.BOT_TOKEN, "editMessageText", { chat_id: cid, message_id: mid, text: `请输入 ${key} 的值 (/cancel 取消):` });
    }
}

async function handleFilterMenu(cid, mid, env) {
    const s = async k => (await getBool(k, env)) ? "✅" : "❌";
    const b = (t, k, v) => ({ text: `${t} ${v}`, callback_data: `config:toggle:${k}:${v==="❌"}` });
    const vals = await Promise.all(['enable_admin_receipt','enable_forward_forwarding','enable_channel_forwarding','enable_image_forwarding'].map(k=>s(k)));
    const list = [[b("回执", 'enable_admin_receipt', vals[0]), b("转发", 'enable_forward_forwarding', vals[1])], [b("频道", 'enable_channel_forwarding', vals[2]), b("媒体", 'enable_image_forwarding', vals[3])], [{ text: "🔙 返回", callback_data: "config:menu" }]];
    api(env.BOT_TOKEN, mid?"editMessageText":"sendMessage", { chat_id: cid, message_id: mid, text: "🛠 <b>过滤设置</b> (点击切换)", parse_mode: "HTML", reply_markup: { inline_keyboard: list } });
}

async function handleListMenu(cid, mid, type, env) {
    const k = type==='ar'?'keyword_responses':(type==='kw'?'block_keywords':'authorized_admins');
    const l = await getJsonCfg(k, env);
    const btns = l.map((i, idx) => [{ text: `🗑 删除 ${idx+1}`, callback_data: `config:del:${type}:${i.id||i}` }]);
    btns.push([{ text: "➕ 添加", callback_data: `config:add:${type}` }], [{ text: "🔙 返回", callback_data: "config:menu" }]);
    api(env.BOT_TOKEN, mid?"editMessageText":"sendMessage", { chat_id: cid, message_id: mid, text: `列表: ${type} (${l.length})`, reply_markup: { inline_keyboard: btns } });
}

async function handleAdminInput(id, txt, state, env) {
    if (txt === '/cancel') { await sql(env, "DELETE FROM config WHERE key=?", `admin_state:${id}`); return sendAdminMenu(id, env); }
    let k = state.key, val = txt;
    if (k.endsWith('_add')) {
        k = k.replace('_add', ''); const realK = k==='ar'?'keyword_responses':(k==='kw'?'block_keywords':'authorized_admins');
        const list = await getJsonCfg(realK, env);
        if (k === 'ar') { const [kk, rr] = txt.split('==='); if(kk&&rr) list.push({keywords:kk, response:rr, id:Date.now()}); }
        else list.push(txt);
        val = JSON.stringify(list); k = realK;
    } else if (k === 'authorized_admins') val = JSON.stringify(txt.split(/[,，]/));
    
    await setCfg(k, val, env);
    await sql(env, "DELETE FROM config WHERE key=?", `admin_state:${id}`);
    await api(env.BOT_TOKEN, "sendMessage", { chat_id: id, text: "✅ 保存成功" });
    sendAdminMenu(id, env);
}

async function sendAdminMenu(id, env) { handleAdminConfig(id, null, 'menu', null, null, env); }

// --- 工具函数 ---
const getBool = async (k, e) => (await getCfg(k, e)) === 'true';
const getJsonCfg = async (k, e) => { try { return JSON.parse(await getCfg(k, e, '[]'))||[]; } catch { return []; } };
const escape = t => (t||"").toString().replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
const getBtns = (id, blk) => ({ inline_keyboard: [[{ text: blk?"✅ 解封":"🚫 屏蔽", callback_data: `${blk?'unblock':'block'}:${id}` }], [{ text: "📌 置顶", callback_data: `pin_card:${id}` }]] });
const isAuthAdmin = async (id, e) => (e.ADMIN_IDS||"").includes(id) || (await getJsonCfg('authorized_admins', e)).includes(id.toString());
const getUMeta = (u, d) => {
    const id = u.id.toString(), name = (u.first_name||"")+(u.last_name?" "+u.last_name:"");
    const userLink = u.username ? `<a href="tg://user?id=${id}">@${u.username}</a>` : `<code>无</code>`;
    return { userId: id, name, username: u.username, topicName: `${name} | ${id}`.substr(0, 128), card: `<b>👤 用户资料</b>\n---\n👤: <code>${escape(name)}</code>\n🔗: ${userLink}\n🆔: <code>${id}</code>\n🕒: <code>${new Date(d*1000).toLocaleString('zh-CN')}</code>` };
};
