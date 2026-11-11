import express from 'express';
import path from 'path';
import fs from 'fs';
import { exec } from 'child_process';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { GoogleGenAI } from '@google/genai';
import { INITIAL_BOT_STATE } from './src/mockData.ts';
import { BotState, TelegramMessage } from './src/types.ts';
import { handleBotInput } from './src/botEngine.ts';
import { fetchRucBranches, fetchRucYears, fetchRucGroups, fetchRucSchedule } from './src/rucParser.ts';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;

app.use(express.json());

// In-memory application state initialized with realistic student data
let botState: BotState = { ...INITIAL_BOT_STATE };

// Gemini AI Setup (Server-side only)
let ai: GoogleGenAI | null = null;
if (process.env.GEMINI_API_KEY) {
  ai = new GoogleGenAI({
    apiKey: process.env.GEMINI_API_KEY,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

// Telegram Polling Controller State
interface TelegramState {
  isActive: boolean;
  botInfo: { id: number; first_name: string; username?: string } | null;
  lastError: string | null;
  messageCount: number;
  lastActiveTime: string | null;
  pollingAbortController: AbortController | null;
}

const telegramState: TelegramState = {
  isActive: false,
  botInfo: null,
  lastError: null,
  messageCount: 0,
  lastActiveTime: null,
  pollingAbortController: null,
};

// ----------------- API ROUTES ----------------- //

// Get bot state
app.get('/api/bot/state', (_req, res) => {
  res.json(botState);
});

// Update bot state
app.put('/api/bot/state', (req, res) => {
  botState = { ...botState, ...req.body };
  res.json(botState);
});

// Execute Bot Command (for Web Simulator and tests)
app.post('/api/bot/command', (req, res) => {
  const { message, chatType, userName } = req.body;
  const reply = handleBotInput(
    message || '/start',
    botState,
    chatType || 'private',
    userName || 'Студент'
  );
  res.json(reply);
});

// ----------------- RUC SCHEDULE INTEGRATION (https://schedule.ruc.su/) ----------------- //

// Get RUC Branches
app.get('/api/ruc/branches', async (_req, res) => {
  try {
    const branches = await fetchRucBranches();
    res.json(branches);
  } catch (err: any) {
    console.error('Error fetching RUC branches:', err);
    res.status(500).json({ error: err.message || 'Ошибка загрузки филиалов РУК' });
  }
});

// Get RUC Years for selected branch
app.post('/api/ruc/years', async (req, res) => {
  const { branchId } = req.body;
  if (!branchId) return res.status(400).json({ error: 'Не указан филиал' });
  try {
    const years = await fetchRucYears(branchId);
    res.json(years);
  } catch (err: any) {
    console.error('Error fetching RUC years:', err);
    res.status(500).json({ error: err.message || 'Ошибка загрузки годов РУК' });
  }
});

// Get RUC Groups for selected branch + year
app.post('/api/ruc/groups', async (req, res) => {
  const { branchId, yearId } = req.body;
  if (!branchId || !yearId) return res.status(400).json({ error: 'Не указаны филиал и год' });
  try {
    const groups = await fetchRucGroups(branchId, yearId);
    res.json(groups);
  } catch (err: any) {
    console.error('Error fetching RUC groups:', err);
    res.status(500).json({ error: err.message || 'Ошибка загрузки групп РУК' });
  }
});

// Fetch and sync RUC Schedule
app.post('/api/ruc/schedule', async (req, res) => {
  const { branchId, yearId, groupId, groupName, syncNow } = req.body;
  if (!branchId || !yearId || !groupId) {
    return res.status(400).json({ error: 'Не указаны филиал, год или группа' });
  }
  try {
    const result = await fetchRucSchedule(branchId, yearId, groupId);
    
    if (syncNow && result.schedule.length > 0) {
      // Overwrite or merge schedule into botState
      botState.schedule = result.schedule;
      if (groupName) {
        botState.groupName = groupName;
      }
      botState.university = 'Российский университет кооперации (РУК)';
    }

    res.json({
      success: true,
      count: result.schedule.length,
      schedule: result.schedule,
      synced: Boolean(syncNow),
      groupName: botState.groupName,
    });
  } catch (err: any) {
    console.error('Error parsing RUC schedule:', err);
    res.status(500).json({ error: err.message || 'Ошибка парсинга расписания РУК' });
  }
});

// AI Roast endpoint (Gemini API 3.8 Flash)
app.post('/api/gemini/generate-roast', async (req, res) => {
  const { studentName, issue, customNotes } = req.body;
  try {
    if (!ai) {
      // Fallback if no API key yet
      return res.json({
        roast: `⚡ ${studentName || 'Студент'}! Деканат уже точит карандаш на твое отчисление из-за "${issue || 'прогулов'}". Бегом на пару, пока староста добрый!`,
      });
    }

    const prompt = `Ты — саркастичный, едкий, но заботливый староста студенческой группы в российском университете (бот "Сратоста").
Напиши короткий, остроумный студенческий роаст/отчитывание студенту по имени "${studentName || 'Студент'}".
Причина отчитывания: "${issue || 'прогулял первую пару и не сдал отчет'}".
Дополнительный контекст: "${customNotes || 'обещал вчера сдать, но спал до обеда'}".
Стиль: доброжелательная студенческая ирония, мемный сленг (деканат, пересдача, лабы, стипуха, автомат), 2-3 ярких предложения, используй эмодзи. Без мата и оскорблений.`;

    const response = await ai.models.generateContent({
      model: 'gemini-3.8-flash',
      contents: prompt,
      config: {
        systemInstruction: 'Ты — виртуальный староста университета, любящий качественный студенческий юмор и мемы.',
      },
    });

    res.json({ roast: response.text || 'Бегом на пару, долги сами себя не закроют!' });
  } catch (error: any) {
    console.error('Error generating AI roast:', error);
    res.status(500).json({ error: error.message || 'Ошибка генерации роаста' });
  }
});

// AI Excuse endpoint (Gemini API 3.8 Flash)
app.post('/api/gemini/generate-excuse', async (req, res) => {
  const { subject, teacher, situation } = req.body;
  try {
    if (!ai) {
      return res.json({
        excuse: `«Уважаемый ${teacher || 'преподаватель'}, из-за внезапного сбоя трамвайных путей и перегрузки сервера поликлиники я задержался. Готов защитить материал в двойном объеме!»`,
      });
    }

    const prompt = `Ты — генератор студенческих отмазок и объяснительных записок для бота старосты "Сратоста".
Придумай забавную, но вежливую и правдоподобно звучащую отмазку для преподавателя по предмету "${subject || 'Математика'}" (${teacher || 'преподаватель'}).
Ситуация: "${situation || 'проспал и не сделал домашку'}".
Стиль: 2 варианта: 1) официальный вежливый для преподавателя, 2) смешной мемный для чата группы.
Верни в формате JSON:
{
  "official": "...",
  "funny": "..."
}`;

    const response = await ai.models.generateContent({
      model: 'gemini-3.8-flash',
      contents: prompt,
      config: {
        responseMimeType: 'application/json',
      },
    });

    const parsed = JSON.parse(response.text || '{}');
    res.json(parsed);
  } catch (error: any) {
    console.error('Error generating excuse:', error);
    res.status(500).json({ error: error.message || 'Ошибка генерации отмазки' });
  }
});

// Telegram Bot Status
app.get('/api/telegram/status', (_req, res) => {
  res.json({
    isActive: telegramState.isActive,
    botInfo: telegramState.botInfo,
    lastError: telegramState.lastError,
    messageCount: telegramState.messageCount,
    lastActiveTime: telegramState.lastActiveTime,
  });
});

// Start Telegram Bot Polling with user's Bot Token
app.post('/api/telegram/start', async (req, res) => {
  const { token } = req.body;
  if (!token || typeof token !== 'string') {
    return res.status(400).json({ error: 'Требуется валидный токен бота от @BotFather' });
  }

  // Stop any previous polling
  if (telegramState.pollingAbortController) {
    telegramState.pollingAbortController.abort();
  }

  const cleanToken = token.trim();

  try {
    // 1. Verify token by calling getMe
    const getMeRes = await fetch(`https://api.telegram.org/bot${cleanToken}/getMe`);
    const getMeData = await getMeRes.json();

    if (!getMeData.ok) {
      telegramState.lastError = getMeData.description || 'Неверный токен Telegram Bot';
      return res.status(400).json({ error: telegramState.lastError });
    }

    telegramState.botInfo = getMeData.result;
    telegramState.isActive = true;
    telegramState.lastError = null;
    telegramState.lastActiveTime = new Date().toISOString();
    botState.telegramToken = cleanToken;
    botState.botUsername = getMeData.result.username;

    // Start background poller
    const controller = new AbortController();
    telegramState.pollingAbortController = controller;

    // Launch polling loop in background (non-blocking)
    startTelegramPolling(cleanToken, controller.signal);

    res.json({
      success: true,
      botInfo: telegramState.botInfo,
    });
  } catch (err: any) {
    telegramState.lastError = err.message;
    telegramState.isActive = false;
    res.status(500).json({ error: err.message });
  }
});

// Stop Telegram Bot Polling
app.post('/api/telegram/stop', (_req, res) => {
  if (telegramState.pollingAbortController) {
    telegramState.pollingAbortController.abort();
    telegramState.pollingAbortController = null;
  }
  telegramState.isActive = false;
  telegramState.lastActiveTime = new Date().toISOString();
  res.json({ success: true, message: 'Бот остановлен' });
});

// Send Test Message via Telegram Bot API
app.post('/api/telegram/send-test', async (req, res) => {
  const { chatId, text } = req.body;
  if (!botState.telegramToken) {
    return res.status(400).json({ error: 'Токен Telegram бота не настроен' });
  }
  if (!chatId) {
    return res.status(400).json({ error: 'Укажите Chat ID' });
  }

  try {
    const tgRes = await fetch(`https://api.telegram.org/bot${botState.telegramToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: text || '👋 Привет! Это тестовое сообщение от бота Сратоста.',
        parse_mode: 'Markdown',
      }),
    });
    const tgData = await tgRes.json();
    if (!tgData.ok) {
      return res.status(400).json({ error: tgData.description });
    }
    res.json({ success: true, result: tgData.result });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ----------------- GITHUB & EXPORT API ----------------- //

// Push to GitHub repository directly
app.post('/api/git/push', async (req, res) => {
  const { repoUrl, personalAccessToken } = req.body;
  if (!repoUrl) {
    return res.status(400).json({
      error: 'Укажите URL репозитория на GitHub (например, https://github.com/dimasikdunaev1/sratosta-bot.git)',
    });
  }

  let cleanUrl = repoUrl.trim();
  if (cleanUrl.endsWith('/')) cleanUrl = cleanUrl.slice(0, -1);
  if (!cleanUrl.endsWith('.git')) cleanUrl += '.git';

  let pushUrl = cleanUrl;
  if (personalAccessToken && cleanUrl.startsWith('https://')) {
    const withoutHttps = cleanUrl.replace('https://', '');
    pushUrl = `https://${personalAccessToken.trim()}@${withoutHttps}`;
  }

  // Ensure git changes are committed
  exec('git add . && git commit -m "update: latest changes for Sratosta bot" 2>/dev/null || true', () => {
    // Set remote origin
    exec('git remote remove origin 2>/dev/null || true', () => {
      exec(`git remote add origin "${cleanUrl}"`, (addErr) => {
        if (addErr) {
          console.error('[Git remote error]', addErr);
        }
        // Run git push
        exec(`git push -u "${pushUrl}" main --force`, (pushErr, stdout, stderr) => {
          if (pushErr) {
            let errorText = stderr || stdout || pushErr.message;
            if (personalAccessToken) {
              errorText = errorText.split(personalAccessToken.trim()).join('***');
            }
            return res.status(500).json({ error: errorText });
          }

          res.json({
            success: true,
            message: `🎉 Все файлы успешно загружены в ваш репозиторий GitHub: ${cleanUrl}! Теперь вы можете подключить его к Amvera.`,
          });
        });
      });
    });
  });
});

// Download full repository archive (tar.gz)
app.get('/api/export/archive', (_req, res) => {
  const archivePath = path.join(__dirname, 'sratosta-bot-full.tar.gz');
  exec(
    'tar -czf sratosta-bot-full.tar.gz --exclude="node_modules" --exclude="dist" .',
    (err) => {
      if (err) {
        return res.status(500).json({ error: 'Ошибка создания архива репозитория' });
      }
      res.download(archivePath, 'sratosta-bot-full.tar.gz', () => {
        try {
          fs.unlinkSync(archivePath);
        } catch {}
      });
    }
  );
});

// Telegram Polling Runner
async function startTelegramPolling(token: string, signal: AbortSignal) {
  let offset = 0;
  console.log(`[Telegram] Starting polling for bot @${telegramState.botInfo?.username}`);

  while (!signal.aborted && telegramState.isActive) {
    try {
      const response = await fetch(
        `https://api.telegram.org/bot${token}/getUpdates?offset=${offset}&timeout=15`,
        { signal }
      );
      const data = await response.json();

      if (data.ok && Array.isArray(data.result)) {
        for (const update of data.result) {
          offset = update.update_id + 1;
          telegramState.messageCount++;
          telegramState.lastActiveTime = new Date().toISOString();

          // Handle incoming message or callback_query
          if (update.message && update.message.text) {
            const chatId = update.message.chat.id;
            const text = update.message.text;
            const senderName =
              update.message.from?.first_name || update.message.from?.username || 'Студент';
            const chatType = update.message.chat.type === 'private' ? 'private' : 'group';

            const reply = handleBotInput(text, botState, chatType, senderName);

            // Send reply back to Telegram
            await sendTelegramMessage(token, chatId, reply);
          } else if (update.callback_query) {
            const queryId = update.callback_query.id;
            const chatId = update.callback_query.message?.chat?.id;
            const callbackData = update.callback_query.data;
            const senderName = update.callback_query.from?.first_name || 'Студент';

            // Answer callback query to remove spinner in Telegram
            await fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ callback_query_id: queryId }),
            });

            if (chatId && callbackData) {
              const commandFromCallback = callbackData.replace('cmd_', '/');
              const reply = handleBotInput(commandFromCallback, botState, 'private', senderName);
              await sendTelegramMessage(token, chatId, reply);
            }
          }
        }
      }
    } catch (err: any) {
      if (signal.aborted) break;
      console.error('[Telegram Polling error]', err.message);
      telegramState.lastError = err.message;
      // Sleep 3 seconds before reconnecting
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}

// Helper to send message with Telegram formatting
async function sendTelegramMessage(
  token: string,
  chatId: number | string,
  reply: Omit<TelegramMessage, 'id' | 'timestamp'>
) {
  try {
    const payload: any = {
      chat_id: chatId,
      text: reply.text,
      parse_mode: 'Markdown',
    };

    if (reply.replyMarkup) {
      payload.reply_markup = reply.replyMarkup;
    }

    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    console.error('[Error sending Telegram message]:', err);
  }
}

// ----------------- VITE / STATIC SERVING ----------------- //

async function startServer() {
  const isProd = process.env.NODE_ENV === 'production';

  if (!isProd) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.resolve(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Sratosta Bot server running on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
});
