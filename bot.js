const TelegramBot = require("node-telegram-bot-api");
const cron = require("node-cron");
const axios = require("axios");
const fs = require("fs");

const BOT_TOKEN = process.env.BOT_TOKEN;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const GROUP_CHAT_ID = process.env.GROUP_CHAT_ID;

const LOCATIONS = ["Цех", "Ботаника", "Рышкановка"];

const CHEFS_FILE = "/tmp/chefs.json";
const REPORTS_FILE = "/tmp/reports.json";

function loadJSON(file, def = {}) {
  try { if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) {}
  return def;
}
function saveJSON(file, data) { fs.writeFileSync(file, JSON.stringify(data, null, 2)); }
function getChefs() { return loadJSON(CHEFS_FILE); }
function saveChefs(d) { saveJSON(CHEFS_FILE, d); }
function getReports() { return loadJSON(REPORTS_FILE); }
function saveReports(d) { saveJSON(REPORTS_FILE, d); }

function todayKey() {
  return new Date().toLocaleDateString("ru-RU", { timeZone: "Europe/Chisinau" }).split(".").reverse().join("-");
}
function getSlot() {
  const h = parseInt(new Date().toLocaleTimeString("ru-RU", { hour: "2-digit", timeZone: "Europe/Chisinau" }));
  return h < 13 ? "morning" : "afternoon";
}
function markReport(point) {
  const reports = getReports();
  const day = todayKey();
  const slot = getSlot();
  if (!reports[day]) reports[day] = { morning: {}, afternoon: {} };
  reports[day][slot][point] = true;
  saveReports(reports);
}
function getMissingPoints(slot) {
  const reports = getReports();
  const day = todayKey();
  const done = reports[day]?.[slot] || {};
  return LOCATIONS.filter(l => !done[l]);
}
function getCurrentTime() {
  return new Date().toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Chisinau" });
}
function isFriday() { return new Date().getDay() === 5; }

const bot = new TelegramBot(BOT_TOKEN, { polling: true });
const sessions = {};

function groupMsg(text, opts = {}) {
  return bot.sendMessage(GROUP_CHAT_ID, text, { parse_mode: "Markdown", ...opts });
}

// ─── CLAUDE — только для диалога о точках ─────────────────────────────────
async function claudeAsk(chefName, knownPoint, detectedPoint, context) {
  const prompt = context === "new_chef"
    ? `Ты бот контроля масла в ресторане MOMO. Шеф "${chefName}" первый раз скинул фото. Задай короткий дружелюбный вопрос на русском — с какой точки фото (Цех, Ботаника или Рышкановка)? Одно предложение.`
    : `Ты бот контроля масла в ресторане MOMO. Шеф "${chefName}" обычно на "${knownPoint}", но подпись говорит "${detectedPoint}". Спроси коротко и по-дружески — он сменил точку или просто помог коллеге? Одно предложение.`;

  const response = await axios.post(
    "https://api.anthropic.com/v1/messages",
    { model: "claude-haiku-4-5-20251001", max_tokens: 100, messages: [{ role: "user", content: prompt }] },
    { headers: { "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "Content-Type": "application/json" } }
  );
  return response.data.content[0].text.trim();
}

async function claudeParseAnswer(chefName, answer, knownPoint, detectedPoint) {
  const prompt = `Шеф "${chefName}" ответил на вопрос о смене точки (был "${knownPoint}", фото с "${detectedPoint}"): "${answer}". Ответь ТОЛЬКО одним словом: changed (сменил точку), temp (временно помогал), unknown (непонятно).`;
  const response = await axios.post(
    "https://api.anthropic.com/v1/messages",
    { model: "claude-haiku-4-5-20251001", max_tokens: 10, messages: [{ role: "user", content: prompt }] },
    { headers: { "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "Content-Type": "application/json" } }
  );
  return response.data.content[0].text.trim().toLowerCase();
}

async function claudeParsePoint(answer) {
  const prompt = `Шеф написал: "${answer}". Определи о какой точке: Цех, Ботаника, Рышкановка. Ответь ТОЛЬКО одним словом из списка или "unknown".`;
  const response = await axios.post(
    "https://api.anthropic.com/v1/messages",
    { model: "claude-haiku-4-5-20251001", max_tokens: 20, messages: [{ role: "user", content: prompt }] },
    { headers: { "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "Content-Type": "application/json" } }
  );
  return response.data.content[0].text.trim();
}

// ─── ОБРАБОТКА ФОТО — без анализа, просто фиксация ────────────────────────
async function processPhoto(chatId, msgId, point, senderName) {
  markReport(point);

  await bot.sendMessage(chatId,
    `✅ *${point}* — фото получено\n👤 ${senderName} | 🕐 ${getCurrentTime()}`,
    { parse_mode: "Markdown", reply_to_message_id: msgId }
  );

  const missing = getMissingPoints(getSlot());
  if (missing.length === 0) {
    await bot.sendMessage(chatId, `✅ *Все три точки отчитались!* 👍`, { parse_mode: "Markdown" });
  }
}

// ─── PHOTO HANDLER ─────────────────────────────────────────────────────────
bot.on("photo", async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id.toString();
  const caption = (msg.caption || "").trim();
  const senderName = msg.from.first_name || "Шеф";
  const username = msg.from.username || null;

  const chefs = getChefs();
  const isNew = !chefs[userId];
  if (!chefs[userId]) chefs[userId] = { name: senderName, username, point: null };
  chefs[userId].name = senderName;
  chefs[userId].username = username;
  saveChefs(chefs);

  // Определяем точку из подписи
  let captionPoint = null;
  const captionLower = caption.toLowerCase();
  for (const loc of LOCATIONS) {
    if (captionLower.includes(loc.toLowerCase())) { captionPoint = loc; break; }
  }

  const knownPoint = chefs[userId].point;

  // СЦЕНАРИЙ 1: Новый шеф
  if (isNew || !knownPoint) {
    sessions[userId] = { chatId, msgId: msg.message_id, senderName, step: "ask_point", detectedPoint: captionPoint };
    try {
      const question = await claudeAsk(senderName, null, captionPoint, "new_chef");
      await bot.sendMessage(chatId, question, { reply_to_message_id: msg.message_id });
    } catch (e) {
      const keyboard = { inline_keyboard: [LOCATIONS.map(l => ({ text: l, callback_data: `setpoint_${userId}_${l}` }))] };
      await bot.sendMessage(chatId, `${senderName}, с какой точки фото?`, { reply_markup: keyboard, reply_to_message_id: msg.message_id });
    }
    return;
  }

  // СЦЕНАРИЙ 2: Шеф известен, подпись указывает другую точку
  if (captionPoint && captionPoint !== knownPoint) {
    sessions[userId] = { chatId, msgId: msg.message_id, senderName, step: "confirm_change", detectedPoint: captionPoint, knownPoint };
    try {
      const question = await claudeAsk(senderName, knownPoint, captionPoint, "point_change");
      await bot.sendMessage(chatId, question, { reply_to_message_id: msg.message_id });
    } catch (e) {
      await bot.sendMessage(chatId, `${senderName}, ты сменил точку с ${knownPoint} на ${captionPoint}?`, { reply_to_message_id: msg.message_id });
    }
    return;
  }

  // СЦЕНАРИЙ 3: Всё понятно
  const point = captionPoint || knownPoint;
  if (captionPoint) { chefs[userId].point = captionPoint; saveChefs(chefs); }
  await processPhoto(chatId, msg.message_id, point, senderName);
});

// ─── TEXT HANDLER — диалог о точке ────────────────────────────────────────
bot.on("message", async (msg) => {
  if (msg.photo || msg.sticker || msg.document) return;
  if (!msg.text || msg.text.startsWith("/")) return;

  const userId = msg.from.id.toString();
  const session = sessions[userId];
  if (!session) return;

  const text = msg.text.trim();
  const { chatId, msgId, senderName, step, detectedPoint, knownPoint } = session;

  if (step === "ask_point") {
    let point = null;
    const lower = text.toLowerCase();
    for (const loc of LOCATIONS) {
      if (lower.includes(loc.toLowerCase())) { point = loc; break; }
    }
    if (!point) {
      try {
        const parsed = await claudeParsePoint(text);
        if (parsed !== "unknown" && LOCATIONS.includes(parsed)) point = parsed;
      } catch (e) {}
    }
    if (!point) {
      const keyboard = { inline_keyboard: [LOCATIONS.map(l => ({ text: l, callback_data: `setpoint_${userId}_${l}` }))] };
      await bot.sendMessage(chatId, `Не понял 😅 Выбери точку:`, { reply_markup: keyboard });
      return;
    }
    const chefs = getChefs();
    chefs[userId].point = point;
    saveChefs(chefs);
    delete sessions[userId];
    await bot.sendMessage(chatId, `✅ Запомнил — ты на *${point}* 👌`, { parse_mode: "Markdown" });
    await processPhoto(chatId, msgId, point, senderName);

  } else if (step === "confirm_change") {
    let decision = "unknown";
    try {
      decision = await claudeParseAnswer(senderName, text, knownPoint, detectedPoint);
    } catch (e) {
      const lower = text.toLowerCase();
      if (lower.includes("да") || lower.includes("перешёл") || lower.includes("переехал")) decision = "changed";
      else if (lower.includes("нет") || lower.includes("помог") || lower.includes("временно")) decision = "temp";
    }

    const chefs = getChefs();

    if (decision === "changed") {
      chefs[userId].point = detectedPoint;
      saveChefs(chefs);
      delete sessions[userId];
      await bot.sendMessage(chatId, `✅ Обновил — теперь ты на *${detectedPoint}* 👌`, { parse_mode: "Markdown" });
      groupMsg(`🔄 *${senderName}* перешёл с *${knownPoint}* на *${detectedPoint}*`);
      await processPhoto(chatId, msgId, detectedPoint, senderName);

    } else if (decision === "temp") {
      delete sessions[userId];
      await bot.sendMessage(chatId, `Понял, помогаешь коллегам 💪`, { parse_mode: "Markdown" });
      await processPhoto(chatId, msgId, detectedPoint, senderName);

    } else {
      const keyboard = { inline_keyboard: [[
        { text: `Да, я на ${detectedPoint}`, callback_data: `confirm_${userId}_changed_${detectedPoint}` },
        { text: `Нет, просто помог`, callback_data: `confirm_${userId}_temp_${detectedPoint}` }
      ]] };
      await bot.sendMessage(chatId, `Уточни:`, { reply_markup: keyboard });
    }
  }
});

// ─── CALLBACKS ─────────────────────────────────────────────────────────────
bot.on("callback_query", async (query) => {
  const data = query.data;
  await bot.answerCallbackQuery(query.id);
  const userId = query.from.id.toString();
  const chefs = getChefs();

  if (data.startsWith("setpoint_")) {
    const parts = data.split("_");
    const targetUserId = parts[1];
    const point = parts.slice(2).join("_");
    if (userId !== targetUserId) return;
    const oldPoint = chefs[userId]?.point || null;
    if (chefs[userId]) { chefs[userId].point = point; saveChefs(chefs); }
    await bot.editMessageText(`✅ Точка: *${point}*`, { chat_id: query.message.chat.id, message_id: query.message.message_id, parse_mode: "Markdown" });
    if (oldPoint && oldPoint !== point) groupMsg(`🔄 *${chefs[userId]?.name}* перешёл с *${oldPoint}* на *${point}*`);
    const session = sessions[userId];
    if (session) { delete sessions[userId]; await processPhoto(session.chatId, session.msgId, point, session.senderName); }
  }

  if (data.startsWith("confirm_")) {
    const parts = data.split("_");
    const targetUserId = parts[1];
    const decision = parts[2];
    const point = parts.slice(3).join("_");
    if (userId !== targetUserId) return;
    const session = sessions[userId];
    if (!session) return;
    delete sessions[userId];
    if (decision === "changed") {
      const oldPoint = chefs[userId]?.point;
      if (chefs[userId]) { chefs[userId].point = point; saveChefs(chefs); }
      await bot.editMessageText(`✅ Теперь ты на *${point}*`, { chat_id: query.message.chat.id, message_id: query.message.message_id, parse_mode: "Markdown" });
      groupMsg(`🔄 *${chefs[userId]?.name}* перешёл с *${oldPoint}* на *${point}*`);
    } else {
      await bot.editMessageText(`👍 Понял, временная помощь`, { chat_id: query.message.chat.id, message_id: query.message.message_id });
    }
    await processPhoto(session.chatId, session.msgId, point, session.senderName);
  }
});

// ─── COMMANDS ──────────────────────────────────────────────────────────────
bot.onText(/\/start/, (msg) => {
  bot.sendMessage(msg.chat.id, `👨‍🍳 *Бот контроля масла MOMO*\n\n📸 Скидывай фото фритюра\n🔔 Напоминания: 09:00 и 16:00\n🔴 Пятница: полная замена\n\n/team — кто на какой точке\n/status — отчёты за сегодня`, { parse_mode: "Markdown" });
});

bot.onText(/\/team/, (msg) => {
  const chefs = getChefs();
  const byPoint = {};
  LOCATIONS.forEach(l => byPoint[l] = []);
  const unassigned = [];
  Object.values(chefs).forEach(c => { if (c.point && byPoint[c.point]) byPoint[c.point].push(c.name); else unassigned.push(c.name); });
  const lines = LOCATIONS.map(l => `• *${l}*: ${byPoint[l].length ? byPoint[l].join(", ") : "❓ не назначен"}`).join("\n");
  const extra = unassigned.length ? `\n\n❓ *Без точки:* ${unassigned.join(", ")}` : "";
  bot.sendMessage(msg.chat.id, `👥 *Команда по точкам:*\n\n${lines}${extra}`, { parse_mode: "Markdown" });
});

bot.onText(/\/status/, (msg) => {
  const fmt = (arr) => arr.length === 0 ? "✅ все" : `❌ нет: ${arr.join(", ")}`;
  bot.sendMessage(msg.chat.id, `📊 *Отчёты сегодня:*\n\n🌅 Утро: ${fmt(getMissingPoints("morning"))}\n🌇 День: ${fmt(getMissingPoints("afternoon"))}`, { parse_mode: "Markdown" });
});

bot.onText(/\/testmorning/, () => sendMorningReminder());
bot.onText(/\/testafternoon/, () => sendAfternoonReminder());

// ─── REMINDERS ─────────────────────────────────────────────────────────────
function sendMorningReminder() {
  const chefs = getChefs();
  const byPoint = {};
  LOCATIONS.forEach(l => byPoint[l] = []);
  Object.values(chefs).forEach(c => { if (c.point && byPoint[c.point]) byPoint[c.point].push(c.name); });
  const pointLines = LOCATIONS.map(l => `• ${l}: ${byPoint[l].length ? byPoint[l].join(", ") : "❓ не назначен"}`).join("\n");
  if (isFriday()) {
    groupMsg(`🔴 *ПЯТНИЦА — ПОЛНАЯ ЗАМЕНА МАСЛА* 🔴\n\n1️⃣ Выключить, остудить до 60°C\n2️⃣ Слить старое масло\n3️⃣ Очистить ёмкость\n4️⃣ Залить свежее\n5️⃣ Прогреть и сфотографировать\n\n📍 *Дежурные:*\n${pointLines}\n\n📸 Фото свежего масла!`);
  } else {
    groupMsg(`🛢 *Утренняя проверка масла* — ${getCurrentTime()}\n\n✅ Отфильтруйте масло\n✅ Проверьте цвет и запах\n✅ Долейте если нужно\n\n📍 *Дежурные:*\n${pointLines}\n\n📸 Скидывайте фото!`);
  }
}
function sendAfternoonReminder() {
  const missing = getMissingPoints("morning");
  const missingText = missing.length > 0 ? `\n\n⚠️ *Утреннее фото не пришло с:* ${missing.map(l => `*${l}*`).join(", ")}` : "";
  groupMsg(`🕓 *Проверка масла 16:00*\n\n✅ Профильтруйте масло\n✅ Цвет: золотое ✅, тёмное ❌\n✅ Долейте если нужно${missingText}\n\n📸 Фото со всех точек!`);
}
function checkMorningCoverage() {
  const missing = getMissingPoints("morning");
  if (missing.length === 0) return;
  groupMsg(`⚠️ *10:00 — нет утреннего фото с:*\n${missing.map(l => `• *${l}*`).join("\n")}\n\nПожалуйста, скиньте фото!`);
}
function checkAfternoonCoverage() {
  const missing = getMissingPoints("afternoon");
  if (missing.length === 0) return;
  groupMsg(`⚠️ *17:00 — нет дневного фото с:*\n${missing.map(l => `• *${l}*`).join("\n")}\n\nСкиньте фото!`);
}

cron.schedule("0 9 * * *",  sendMorningReminder,   { timezone: "Europe/Chisinau" });
cron.schedule("0 10 * * *", checkMorningCoverage,  { timezone: "Europe/Chisinau" });
cron.schedule("0 16 * * *", sendAfternoonReminder, { timezone: "Europe/Chisinau" });
cron.schedule("0 17 * * *", checkAfternoonCoverage,{ timezone: "Europe/Chisinau" });

console.log("🛢 MOMO Fryer Oil Bot v4 запущен!");
console.log("📅 09:00 / 10:00 / 16:00 / 17:00 по Кишинёву");
console.log("📸 Фиксация фото без анализа — главный шеф проверяет сам");
