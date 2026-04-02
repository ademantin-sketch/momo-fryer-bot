const TelegramBot = require("node-telegram-bot-api");
const cron = require("node-cron");
const axios = require("axios");
const fs = require("fs");

// ─── CONFIG ────────────────────────────────────────────────────────────────
const BOT_TOKEN = process.env.BOT_TOKEN;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const GROUP_CHAT_ID = process.env.GROUP_CHAT_ID; // ID вашей Telegram-группы

const LOCATIONS = ["🏭 Цех", "🌿 Ботаника", "🚗 Рышкановка"];

// ─── BOT INIT ──────────────────────────────────────────────────────────────
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// ─── HELPERS ───────────────────────────────────────────────────────────────
function isFriday() {
  return new Date().getDay() === 5;
}

function getCurrentTime() {
  return new Date().toLocaleTimeString("ru-RU", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Europe/Chisinau",
  });
}

// ─── REMINDER MESSAGES ─────────────────────────────────────────────────────
function sendMorningReminder() {
  const today = new Date().toLocaleDateString("ru-RU", {
    weekday: "long",
    day: "numeric",
    month: "long",
    timeZone: "Europe/Chisinau",
  });

  if (isFriday()) {
    // Пятничное особое сообщение — полная замена масла
    const msg =
      `🔴 *ПЯТНИЦА — ПОЛНАЯ ЗАМЕНА МАСЛА* 🔴\n` +
      `📅 ${today}\n\n` +
      `Сегодня *обязательная полная замена масла* во всех фритюрах!\n\n` +
      `*Порядок действий:*\n` +
      `1️⃣ Выключить фритюр, дать маслу остыть до 60°C\n` +
      `2️⃣ Слить старое масло полностью\n` +
      `3️⃣ Очистить ёмкость от осадка\n` +
      `4️⃣ Залить свежее масло до отметки MIN-MAX\n` +
      `5️⃣ Прогреть до рабочей температуры\n` +
      `6️⃣ Сфотографировать *свежее масло* в каждом фритюре\n\n` +
      `📸 *Нужны фото со всех точек:*\n` +
      LOCATIONS.map((l) => `• ${l}`).join("\n") +
      `\n\nПодпишите фото: название точки 👇`;

    bot.sendMessage(GROUP_CHAT_ID, msg, { parse_mode: "Markdown" });
  } else {
    // Обычное утреннее напоминание
    const msg =
      `🛢 *Утренняя проверка масла* — ${today}\n\n` +
      `Доброе утро! Перед началом работы:\n\n` +
      `✅ *Отфильтруйте масло* от остатков еды\n` +
      `✅ Проверьте цвет и запах масла\n` +
      `✅ При необходимости долейте свежее\n\n` +
      `📸 *Скиньте фото фритюра из каждой точки:*\n` +
      LOCATIONS.map((l) => `• ${l}`).join("\n") +
      `\n\nПодпишите фото: название точки 👇`;

    bot.sendMessage(GROUP_CHAT_ID, msg, { parse_mode: "Markdown" });
  }

  console.log(`[${getCurrentTime()}] Утреннее напоминание отправлено`);
}

function sendAfternoonReminder() {
  const msg =
    `🕓 *Послеобеденная проверка масла* (16:00)\n\n` +
    `Середина рабочего дня — время проверить масло!\n\n` +
    `✅ Профильтруйте масло от крошек и осадка\n` +
    `✅ Оцените цвет: светло-золотое = ✅, тёмно-коричневое = ❌\n` +
    `✅ Долейте масло если уровень упал\n\n` +
    `📸 *Фото фритюров со всех точек:*\n` +
    LOCATIONS.map((l) => `• ${l}`).join("\n") +
    `\n\nПодпишите фото: название точки 👇`;

  bot.sendMessage(GROUP_CHAT_ID, msg, { parse_mode: "Markdown" });
  console.log(`[${getCurrentTime()}] Послеобеденное напоминание отправлено`);
}

// ─── CLAUDE OIL ANALYSIS ───────────────────────────────────────────────────
async function analyzeOilPhoto(photoBuffer, caption) {
  const base64Image = photoBuffer.toString("base64");
  const isFri = isFriday();

  const systemPrompt = `Ты — эксперт по контролю качества масла во фритюрах в ресторане. 
Анализируй фотографии масла и давай чёткие, практичные оценки.
Отвечай ТОЛЬКО на русском языке. Будь конкретным и кратким.
${isFri ? "Сегодня пятница — масло должно быть СВЕЖИМ (только что заменённым). Проверь это особенно тщательно." : ""}`;

  const userPrompt = `Проанализируй фото масла во фритюре.${caption ? ` Точка: ${caption}.` : ""}

Оцени по 4 критериям:
1. 🎨 **Цвет** — светло-золотое (отлично), янтарное (норма), тёмно-коричневое (замени), чёрное (срочно замени)
2. 🔍 **Прозрачность** — прозрачное (отлично), слегка мутное (норма), мутное с осадком (плохо)
3. 🧹 **Чистота** — нет остатков еды (отлично), есть крошки (нужна фильтрация), много осадка (плохо)
4. 📊 **Общая оценка** — ОТЛИЧНО / ХОРОШО / НУЖНА ФИЛЬТРАЦИЯ / ЗАМЕНИТЕ МАСЛО / СРОЧНАЯ ЗАМЕНА

Дай итоговый вердикт и короткую рекомендацию (1-2 предложения).
Формат ответа — чёткий, с эмодзи, без лишних слов.`;

  try {
    const response = await axios.post(
      "https://api.anthropic.com/v1/messages",
      {
        model: "claude-haiku-4-5-20251001",
        max_tokens: 500,
        system: systemPrompt,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type: "image/jpeg",
                  data: base64Image,
                },
              },
              { type: "text", text: userPrompt },
            ],
          },
        ],
      },
      {
        headers: {
          "x-api-key": ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
          "Content-Type": "application/json",
        },
      }
    );

    return response.data.content[0].text;
  } catch (error) {
    console.error("Claude API error:", error.response?.data || error.message);
    return "⚠️ Ошибка анализа. Проверьте фото вручную.";
  }
}

// ─── PHOTO HANDLER ─────────────────────────────────────────────────────────
bot.on("photo", async (msg) => {
  // Принимаем фото только из нашей группы
  if (msg.chat.id.toString() !== GROUP_CHAT_ID.toString()) return;

  const chatId = msg.chat.id;
  const caption = msg.caption || "";
  const senderName = msg.from.first_name || "Шеф";

  // Берём фото наилучшего качества
  const photoArray = msg.photo;
  const bestPhoto = photoArray[photoArray.length - 1];
  const fileId = bestPhoto.file_id;

  // Сообщение "анализирую..."
  const loadingMsg = await bot.sendMessage(
    chatId,
    `🔍 Анализирую масло${caption ? ` (${caption})` : ""}...`,
    { reply_to_message_id: msg.message_id }
  );

  try {
    // Скачиваем фото
    const fileLink = await bot.getFileLink(fileId);
    const photoResponse = await axios.get(fileLink, {
      responseType: "arraybuffer",
    });
    const photoBuffer = Buffer.from(photoResponse.data);

    // Анализируем через Claude
    const analysis = await analyzeOilPhoto(photoBuffer, caption);

    // Удаляем "анализирую..." и отправляем результат
    await bot.deleteMessage(chatId, loadingMsg.message_id);

    const resultMsg =
      `📊 *Анализ масла*${caption ? ` — ${caption}` : ""}\n` +
      `👤 Фото от: ${senderName}\n` +
      `🕐 ${getCurrentTime()}\n\n` +
      `${analysis}`;

    await bot.sendMessage(chatId, resultMsg, {
      parse_mode: "Markdown",
      reply_to_message_id: msg.message_id,
    });
  } catch (error) {
    console.error("Photo processing error:", error);
    await bot.editMessageText("⚠️ Ошибка при обработке фото. Попробуйте ещё раз.", {
      chat_id: chatId,
      message_id: loadingMsg.message_id,
    });
  }
});

// ─── COMMANDS ──────────────────────────────────────────────────────────────
bot.onText(/\/start/, (msg) => {
  if (msg.chat.id.toString() !== GROUP_CHAT_ID.toString()) return;
  bot.sendMessage(
    msg.chat.id,
    `🛢 *Бот контроля масла MOMO активен!*\n\n` +
      `Я буду:\n` +
      `• Напоминать утром и в 16:00 о фильтрации масла\n` +
      `• Каждую пятницу — напоминать о полной замене\n` +
      `• Анализировать фото масла через ИИ\n\n` +
      `📸 Просто скидывайте фото с подписью (название точки) — я всё проверю!`,
    { parse_mode: "Markdown" }
  );
});

bot.onText(/\/status/, (msg) => {
  if (msg.chat.id.toString() !== GROUP_CHAT_ID.toString()) return;
  const now = new Date().toLocaleString("ru-RU", { timeZone: "Europe/Chisinau" });
  bot.sendMessage(
    msg.chat.id,
    `✅ Бот работает\n🕐 Сейчас: ${now}\n📍 Контролирую: ${LOCATIONS.join(", ")}`,
    { parse_mode: "Markdown" }
  );
});

// /test — для проверки напоминаний вручную (удали после настройки)
bot.onText(/\/testmorning/, (msg) => {
  if (msg.chat.id.toString() !== GROUP_CHAT_ID.toString()) return;
  sendMorningReminder();
});

bot.onText(/\/testafternoon/, (msg) => {
  if (msg.chat.id.toString() !== GROUP_CHAT_ID.toString()) return;
  sendAfternoonReminder();
});

// ─── CRON SCHEDULES (Europe/Chisinau = UTC+2/UTC+3) ───────────────────────
// Утро 09:00 по Кишинёву (UTC+2 зима = 07:00 UTC, UTC+3 лето = 06:00 UTC)
// Railway использует UTC, поэтому используем локальное время через TZ env
cron.schedule(
  "0 9 * * *",
  () => {
    sendMorningReminder();
  },
  { timezone: "Europe/Chisinau" }
);

// 16:00 по Кишинёву
cron.schedule(
  "0 16 * * *",
  () => {
    sendAfternoonReminder();
  },
  { timezone: "Europe/Chisinau" }
);

console.log("🛢 MOMO Fryer Oil Bot запущен!");
console.log("📅 Расписание: 09:00 и 16:00 по Кишинёву");
console.log("📸 Ожидаю фото для анализа...");
