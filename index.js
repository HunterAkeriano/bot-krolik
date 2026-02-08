const TelegramBot = require('node-telegram-bot-api');
const schedule = require('node-schedule');
const { Pool } = require('pg');
const Groq = require('groq-sdk');

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const DATABASE_URL = process.env.DATABASE_URL;
const GROQ_API_KEY = process.env.GROQ_API_KEY;

const groq = new Groq({ apiKey: GROQ_API_KEY });

const pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

const bot = new TelegramBot(TOKEN, { polling: true });

let subscribers = new Set();
let derbyStartTime = null;
let scheduledJobs = [];
let participants = new Map();
let players = [];

let duelChallenges = new Map();
let activeDuels = new Map();

function getDuelKey(chatId) {
    return String(chatId);
}

function getUserName(user) {
    return user.username ? `@${user.username}` : user.first_name;
}

function getUserMention(user) {
    if (user.username) return `@${user.username}`;
    return `<a href="tg://user?id=${user.id}">${user.first_name}</a>`;
}

function normalizeUsername(username) {
    return username.replace(/^@/, '').toLowerCase();
}

async function findUserIdByUsername(chatId, username) {
    const normalized = normalizeUsername(username);
    const chatParticipants = participants.get(String(chatId)) || [];
    const localMatch = chatParticipants.find(p => p.username && p.username.toLowerCase() === normalized);
    if (localMatch) return localMatch.id;

    const client = await pool.connect();
    try {
        let result = await client.query(
            'SELECT user_id FROM participants WHERE chat_id = $1 AND LOWER(username) = $2 LIMIT 1',
            [chatId, normalized]
        );
        if (result.rows.length > 0) return result.rows[0].user_id;

        result = await client.query(
            'SELECT user_id FROM message_stats WHERE chat_id = $1 AND LOWER(username) = $2 LIMIT 1',
            [chatId, normalized]
        );
        if (result.rows.length > 0) return result.rows[0].user_id;
    } finally {
        client.release();
    }

    return null;
}

const DEFAULT_PLAYERS = [
    { game: 'Монблан', telegram: '@Matricariay', name: 'Лана', birthday: '14.07' },
    { game: 'PRINCE', telegram: '@DimaSedokov', name: 'Дмитрий', birthday: '29.07' },
    { game: 'Мари', telegram: '@Marim333', name: 'Мари', birthday: null },
    { game: 'Лика', telegram: '-', name: 'Анжелика', birthday: '25.11' },
    { game: 'Амили', telegram: '@the_beesttt', name: 'Амили', birthday: '31.12' },
    { game: 'Бантан', telegram: '@tamisj', name: 'Тамила', birthday: '07.03' },
    { game: 'Оракул', telegram: '@dimag97', name: 'Дмитрий', birthday: '10.12' },
    { game: 'Татьяна', telegram: '@tanja_008_t', name: 'Татьяна', birthday: '30.08' },
    { game: 'Дикий', telegram: '@dik707', name: 'Руслан', birthday: null },
    { game: 'Иришка', telegram: '@Iri280', name: 'Ирина', birthday: '30.08' },
    { game: '@vixxke', telegram: '@vixxke', name: 'Настя', birthday: '19.03' },
    { game: 'Ягода малинка', telegram: '@dima_gulak', name: 'Дмитрий', birthday: '10.11' },
    { game: 'Марина', telegram: '@marina123', name: 'Марина', birthday: '20.02' }
];

async function initDB() {
    const client = await pool.connect();
    try {
        await client.query(`
            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT
            )
        `);
        await client.query(`
            CREATE TABLE IF NOT EXISTS subscribers (
                chat_id BIGINT PRIMARY KEY
            )
        `);
        await client.query(`
            CREATE TABLE IF NOT EXISTS participants (
                chat_id BIGINT,
                user_id BIGINT,
                username TEXT,
                name TEXT,
                PRIMARY KEY (chat_id, user_id)
            )
        `);
        await client.query(`
            CREATE TABLE IF NOT EXISTS players (
                id SERIAL PRIMARY KEY,
                game TEXT,
                telegram TEXT,
                name TEXT,
                birthday TEXT
            )
        `);

        await client.query(`
            CREATE TABLE IF NOT EXISTS message_stats (
                chat_id BIGINT,
                user_id BIGINT,
                username TEXT,
                name TEXT,
                message_count INT DEFAULT 0,
                PRIMARY KEY (chat_id, user_id)
            )
        `);

        await client.query(`
            CREATE TABLE IF NOT EXISTS game_stats (
                chat_id BIGINT,
                user_id BIGINT,
                username TEXT,
                name TEXT,
                duel_wins INT DEFAULT 0,
                duel_losses INT DEFAULT 0,
                coin_wins INT DEFAULT 0,
                coin_losses INT DEFAULT 0,
                PRIMARY KEY (chat_id, user_id)
            )
        `);

        const playersCount = await client.query('SELECT COUNT(*) FROM players');
        if (parseInt(playersCount.rows[0].count) === 0) {
            for (const p of DEFAULT_PLAYERS) {
                await client.query(
                    'INSERT INTO players (game, telegram, name, birthday) VALUES ($1, $2, $3, $4)',
                    [p.game, p.telegram, p.name, p.birthday]
                );
            }
        }
    } finally {
        client.release();
    }
}

async function loadData() {
    const client = await pool.connect();
    try {
        const subsResult = await client.query('SELECT chat_id FROM subscribers');
        subscribers = new Set(subsResult.rows.map(r => r.chat_id.toString()));

        const settingsResult = await client.query("SELECT value FROM settings WHERE key = 'derby_start_time'");
        if (settingsResult.rows.length > 0 && settingsResult.rows[0].value) {
            derbyStartTime = new Date(settingsResult.rows[0].value);
        }

        const participantsResult = await client.query('SELECT chat_id, user_id, username, name FROM participants');
        participants = new Map();
        participantsResult.rows.forEach(r => {
            const chatId = r.chat_id.toString();
            if (!participants.has(chatId)) {
                participants.set(chatId, []);
            }
            participants.get(chatId).push({
                id: r.user_id,
                username: r.username,
                name: r.name
            });
        });

        const playersResult = await client.query('SELECT id, game, telegram, name, birthday FROM players ORDER BY id');
        players = playersResult.rows;
    } finally {
        client.release();
    }
}

async function saveSubscriber(chatId, add = true) {
    const client = await pool.connect();
    try {
        if (add) {
            await client.query('INSERT INTO subscribers (chat_id) VALUES ($1) ON CONFLICT DO NOTHING', [chatId]);
            subscribers.add(chatId.toString());
        } else {
            await client.query('DELETE FROM subscribers WHERE chat_id = $1', [chatId]);
            subscribers.delete(chatId.toString());
        }
    } finally {
        client.release();
    }
}

async function saveDerbyTime(time) {
    const client = await pool.connect();
    try {
        await client.query(
            "INSERT INTO settings (key, value) VALUES ('derby_start_time', $1) ON CONFLICT (key) DO UPDATE SET value = $1",
            [time ? time.toISOString() : null]
        );
        derbyStartTime = time;
    } finally {
        client.release();
    }
}

async function saveParticipant(chatId, user, add = true) {
    const client = await pool.connect();
    try {
        if (add) {
            await client.query(
                'INSERT INTO participants (chat_id, user_id, username, name) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING',
                [chatId, user.id, user.username, user.name]
            );
        } else {
            await client.query('DELETE FROM participants WHERE chat_id = $1 AND user_id = $2', [chatId, user.id]);
        }
    } finally {
        client.release();
    }
}

async function clearParticipants(chatId) {
    const client = await pool.connect();
    try {
        await client.query('DELETE FROM participants WHERE chat_id = $1', [chatId]);
        participants.set(chatId.toString(), []);
    } finally {
        client.release();
    }
}

async function addPlayer(game, telegram, name, birthday) {
    const client = await pool.connect();
    try {
        const result = await client.query(
            'INSERT INTO players (game, telegram, name, birthday) VALUES ($1, $2, $3, $4) RETURNING *',
            [game, telegram, name, birthday]
        );
        players.push(result.rows[0]);
        return result.rows[0];
    } finally {
        client.release();
    }
}

async function removePlayer(index) {
    const client = await pool.connect();
    try {
        const player = players[index];
        await client.query('DELETE FROM players WHERE id = $1', [player.id]);
        return players.splice(index, 1)[0];
    } finally {
        client.release();
    }
}

async function updatePlayerBirthday(playerId, birthday) {
    const client = await pool.connect();
    try {
        await client.query('UPDATE players SET birthday = $1 WHERE id = $2', [birthday, playerId]);
        const player = players.find(p => p.id === playerId);
        if (player) player.birthday = birthday;
    } finally {
        client.release();
    }
}

async function updatePlayer(playerId, data) {
    const client = await pool.connect();
    try {
        await client.query(
            'UPDATE players SET game = $1, telegram = $2, name = $3, birthday = $4 WHERE id = $5',
            [data.game, data.telegram, data.name, data.birthday, playerId]
        );
        const player = players.find(p => p.id === playerId);
        if (player) {
            player.game = data.game;
            player.telegram = data.telegram;
            player.name = data.name;
            player.birthday = data.birthday;
        }
    } finally {
        client.release();
    }
}

async function updateMessageStats(chatId, user) {
    const client = await pool.connect();
    try {
        const name = user.first_name + (user.last_name ? ' ' + user.last_name : '');
        await client.query(`
            INSERT INTO message_stats (chat_id, user_id, username, name, message_count)
            VALUES ($1, $2, $3, $4, 1)
            ON CONFLICT (chat_id, user_id) DO UPDATE SET
                message_count = message_stats.message_count + 1,
                username = $3,
                name = $4
        `, [chatId, user.id, user.username || null, name]);
    } finally {
        client.release();
    }
}

async function updateGameStats(chatId, user, game, isWin) {
    const client = await pool.connect();
    try {
        const name = user.first_name + (user.last_name ? ' ' + user.last_name : '');
        const winField = game === 'duel' ? 'duel_wins' : 'coin_wins';
        const lossField = game === 'duel' ? 'duel_losses' : 'coin_losses';
        const field = isWin ? winField : lossField;

        await client.query(`
            INSERT INTO game_stats (chat_id, user_id, username, name, ${field})
            VALUES ($1, $2, $3, $4, 1)
            ON CONFLICT (chat_id, user_id) DO UPDATE SET
                ${field} = game_stats.${field} + 1,
                username = $3,
                name = $4
        `, [chatId, user.id, user.username || null, name]);
    } finally {
        client.release();
    }
}

async function getTopMessages(chatId, limit = 10) {
    const client = await pool.connect();
    try {
        const result = await client.query(`
            SELECT username, name, message_count
            FROM message_stats
            WHERE chat_id = $1
            ORDER BY message_count DESC
            LIMIT $2
        `, [chatId, limit]);
        return result.rows;
    } finally {
        client.release();
    }
}

async function getTopDuel(chatId, limit = 10) {
    const client = await pool.connect();
    try {
        const result = await client.query(`
            SELECT username, name, duel_wins, duel_losses
            FROM game_stats
            WHERE chat_id = $1 AND (duel_wins > 0 OR duel_losses > 0)
            ORDER BY duel_wins DESC, duel_losses ASC
            LIMIT $2
        `, [chatId, limit]);
        return result.rows;
    } finally {
        client.release();
    }
}

async function getTopCoin(chatId, limit = 10) {
    const client = await pool.connect();
    try {
        const result = await client.query(`
            SELECT username, name, coin_wins, coin_losses
            FROM game_stats
            WHERE chat_id = $1 AND (coin_wins > 0 OR coin_losses > 0)
            ORDER BY coin_wins DESC, coin_losses ASC
            LIMIT $2
        `, [chatId, limit]);
        return result.rows;
    } finally {
        client.release();
    }
}

function getParticipantMentions(chatId) {
    const chatParticipants = participants.get(String(chatId)) || [];
    if (chatParticipants.length === 0) return '';
    return chatParticipants.map(p => {
        if (p.username) return `@${p.username}`;
        return `<a href="tg://user?id=${p.id}">${p.name}</a>`;
    }).join(' ');
}

function getParticipantsList(chatId) {
    return participants.get(String(chatId)) || [];
}

function broadcast(message, withMentions = false) {
    subscribers.forEach(chatId => {
        let finalMessage = message;
        if (withMentions) {
            const mentions = getParticipantMentions(chatId);
            if (mentions) {
                finalMessage = `${mentions}\n\n${message}`;
            }
        }
        bot.sendMessage(chatId, finalMessage, { parse_mode: 'HTML' }).catch(() => {});
    });
}

const RABBIT_TIMES_KYIV = [
    { day: 2, hour: 14, minute: 35, label: 'Вторник' },
    { day: 3, hour: 20, minute: 50, label: 'Среда' },
    { day: 5, hour: 19, minute: 50, label: 'Пятница' }
];

function scheduleBirthdayNotifications() {
    const rule = new schedule.RecurrenceRule();
    rule.hour = 0;
    rule.minute = 0;
    rule.tz = 'Europe/Kyiv';

    schedule.scheduleJob(rule, () => {
        const today = new Date().toLocaleDateString('ru-RU', { timeZone: 'Europe/Kyiv', day: '2-digit', month: '2-digit' }).replace(/\//g, '.');
        const [day, month] = today.split('.');
        const todayFormatted = `${day}.${month}`;

        const birthdayPeople = players.filter(p => p.birthday === todayFormatted);

        if (birthdayPeople.length > 0) {
            birthdayPeople.forEach(person => {
                const mention = person.telegram && person.telegram !== '-'
                    ? person.telegram
                    : person.name;

                const message = `🎂🎉 <b>С Днём Рождения!</b> 🎉🎂\n\n${mention}, поздравляем тебя с Днём Рождения!\n\nЖелаем счастья, здоровья и отличных скачек! 🐰🏇`;
                broadcast(message, false);
            });
        }
    });
}

function scheduleRabbitNotifications() {
    RABBIT_TIMES_KYIV.forEach(rabbit => {
        const rule = new schedule.RecurrenceRule();
        rule.dayOfWeek = rabbit.day;
        rule.hour = rabbit.hour;
        rule.minute = rabbit.minute;
        rule.tz = 'Europe/Kyiv';

        schedule.scheduleJob(rule, () => {
            broadcast(`🐰 <b>КРОЛИК ПРИСКАКАЛ!</b>\n\n${rabbit.label} ${rabbit.hour}:${String(rabbit.minute).padStart(2, '0')} по Киеву\n\nВремя делать задания с бонусом!`, true);
        });

        const preRule = new schedule.RecurrenceRule();
        preRule.dayOfWeek = rabbit.day;
        preRule.hour = rabbit.hour;
        preRule.minute = rabbit.minute - 10;
        preRule.tz = 'Europe/Kyiv';

        schedule.scheduleJob(preRule, () => {
            broadcast(`⏰ <b>Через 10 минут прискачет кролик!</b>\n\nГотовьте задания!`, true);
        });
    });
}

function scheduleDerbyResets() {
    scheduledJobs.forEach(job => job.cancel());
    scheduledJobs = [];

    if (!derbyStartTime) return;

    const resetOffsets = [
        { hours: 0, label: 'Старт дерби! Доступно 5 заданий' },
        { hours: 11, label: 'Первый сброс! +5 заданий (всего 10)' },
        { hours: 30, label: 'Второй сброс! +5 заданий (всего 15)' },
        { hours: 54, label: 'Третий сброс! +5 заданий (всего 20)' },
        { hours: 78, label: 'Четвёртый сброс! +5 заданий (всего 25)' },
        { hours: 102, label: 'Пятый сброс! +5 заданий (всего 30)' },
        { hours: 126, label: 'Шестой сброс! +5 заданий (всего 35)' }
    ];

    resetOffsets.forEach((reset, index) => {
        const resetTime = new Date(derbyStartTime.getTime() + reset.hours * 60 * 60 * 1000);

        if (resetTime > new Date()) {
            const job = schedule.scheduleJob(resetTime, () => {
                broadcast(`🏇 <b>${reset.label}</b>\n\nСброс #${index + 1} из 7`, true);
            });
            if (job) scheduledJobs.push(job);

            const preNotifyTime = new Date(resetTime.getTime() - 30 * 60 * 1000);
            if (preNotifyTime > new Date()) {
                const preJob = schedule.scheduleJob(preNotifyTime, () => {
                    broadcast(`⏰ <b>Через 30 минут сброс заданий!</b>\n\n${reset.label}`, true);
                });
                if (preJob) scheduledJobs.push(preJob);
            }
        }
    });
}

function getNextRabbit() {
    const now = new Date();
    const kyivNow = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/Kyiv' }));
    const currentDay = kyivNow.getDay();
    const currentMinutes = kyivNow.getHours() * 60 + kyivNow.getMinutes();

    for (const rabbit of RABBIT_TIMES_KYIV) {
        const rabbitMinutes = rabbit.hour * 60 + rabbit.minute;
        if (rabbit.day > currentDay || (rabbit.day === currentDay && rabbitMinutes > currentMinutes)) {
            return rabbit;
        }
    }
    return RABBIT_TIMES_KYIV[0];
}

function getNextResets() {
    if (!derbyStartTime) return null;

    const now = new Date();
    const resetOffsets = [0, 11, 30, 54, 78, 102, 126];
    const upcoming = [];

    resetOffsets.forEach((hours, index) => {
        const resetTime = new Date(derbyStartTime.getTime() + hours * 60 * 60 * 1000);
        if (resetTime > now) {
            upcoming.push({
                index: index + 1,
                time: resetTime,
                tasks: (index + 1) * 5
            });
        }
    });

    return upcoming.slice(0, 3);
}

bot.onText(/\/start$/, async (msg) => {
    await saveSubscriber(msg.chat.id, true);

    bot.sendMessage(msg.chat.id,
`🐰 <b>Hay Day Derby Bot</b>

Добро пожаловать! Я буду уведомлять вас о:
• Появлении кролика
• Сбросах лимитов заданий

<b>Основные команды:</b>
/status - Текущий статус
/rabbit - Время следующего кролика
/resets - Расписание сбросов

<b>Участники скачек:</b>
/join - Присоединиться к скачкам
/leave - Покинуть скачки
/participants - Список участников
/ping - Пингануть участников скачек
/pingall - Пингануть всех игроков

<b>Игроки:</b>
/players - Список всех игроков
/player [ник] - Найти игрока
/addplayer - Добавить игрока
/editplayer - Редактировать игрока
/removeplayer [ник] - Удалить игрока
/birthdays - Дни рождения
/setbirthday - Установить день рождения

<b>Игры:</b>
• кто дуэль - найти соперника для дуэли
• монетка - игра орёл/решка

<b>Статистика:</b>
/topchat - топ болтунов
/topduel - топ дуэлянтов
/topcoin - топ монетки

<b>Настройки:</b>
/setderby - Установить время старта дерби
/subscribe - Подписаться на уведомления
/unsubscribe - Отписаться`, { parse_mode: 'HTML' });
});

bot.onText(/\/subscribe$/, async (msg) => {
    await saveSubscriber(msg.chat.id, true);
    bot.sendMessage(msg.chat.id, '✅ Вы подписаны на уведомления!');
});

bot.onText(/\/unsubscribe$/, async (msg) => {
    await saveSubscriber(msg.chat.id, false);
    bot.sendMessage(msg.chat.id, '❌ Вы отписаны от уведомлений.');
});

bot.onText(/\/status$/, (msg) => {
    const nextRabbit = getNextRabbit();
    const nextResets = getNextResets();

    let status = `📊 <b>Статус</b>\n\n`;
    status += `🐰 Следующий кролик: ${nextRabbit.label} ${nextRabbit.hour}:${String(nextRabbit.minute).padStart(2, '0')} (Киев)\n\n`;

    if (derbyStartTime) {
        status += `🏇 Дерби стартовало: ${derbyStartTime.toLocaleString('ru-RU', { timeZone: 'Europe/Kyiv' })}\n`;
        if (nextResets && nextResets.length > 0) {
            status += `\nБлижайшие сбросы:\n`;
            nextResets.forEach(r => {
                status += `• Сброс #${r.index} (${r.tasks} заданий): ${r.time.toLocaleString('ru-RU', { timeZone: 'Europe/Kyiv' })}\n`;
            });
        }
    } else {
        status += `🏇 Дерби не установлено. Используйте /setderby`;
    }

    bot.sendMessage(msg.chat.id, status, { parse_mode: 'HTML' });
});

bot.onText(/\/setderby(?:\s+(.+))?$/, async (msg, match) => {
    const input = match[1];

    if (!input) {
        bot.sendMessage(msg.chat.id,
`⚙️ <b>Установка времени старта дерби</b>

Формат: /setderby ДД.ММ.ГГГГ ЧЧ:ММ

Пример: /setderby 10.02.2026 10:00

Время указывайте по Киеву!`, { parse_mode: 'HTML' });
        return;
    }

    const parts = input.match(/(\d{1,2})\.(\d{1,2})\.(\d{4})\s+(\d{1,2}):(\d{2})/);
    if (!parts) {
        bot.sendMessage(msg.chat.id, '❌ Неверный формат. Пример: /setderby 10.02.2026 10:00');
        return;
    }

    const [, day, month, year, hour, minute] = parts;
    const dateStr = `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}T${hour.padStart(2, '0')}:${minute}:00`;

    const kyivDate = new Date(dateStr + '+02:00');

    if (isNaN(kyivDate.getTime())) {
        bot.sendMessage(msg.chat.id, '❌ Неверная дата.');
        return;
    }

    await saveDerbyTime(kyivDate);
    scheduleDerbyResets();

    bot.sendMessage(msg.chat.id,
`✅ <b>Дерби установлено!</b>

Старт: ${derbyStartTime.toLocaleString('ru-RU', { timeZone: 'Europe/Kyiv' })} (Киев)

Я буду уведомлять о всех сбросах заданий.`, { parse_mode: 'HTML' });
});

bot.onText(/\/rabbit$/, (msg) => {
    const next = getNextRabbit();
    bot.sendMessage(msg.chat.id,
`🐰 <b>Расписание кроликов (по Киеву)</b>

• Вторник - 14:35
• Среда - 20:50
• Пятница - 19:50

Следующий: <b>${next.label} ${next.hour}:${String(next.minute).padStart(2, '0')}</b>`, { parse_mode: 'HTML' });
});

bot.onText(/\/resets$/, (msg) => {
    if (!derbyStartTime) {
        bot.sendMessage(msg.chat.id, '❌ Дерби не установлено. Используйте /setderby');
        return;
    }

    const resetOffsets = [
        { hours: 0, label: 'Старт (5 заданий)' },
        { hours: 11, label: '+11ч (10 заданий)' },
        { hours: 30, label: '+19ч (15 заданий)' },
        { hours: 54, label: '+24ч (20 заданий)' },
        { hours: 78, label: '+24ч (25 заданий)' },
        { hours: 102, label: '+24ч (30 заданий)' },
        { hours: 126, label: '+24ч (35 заданий)' }
    ];

    let message = `🏇 <b>Расписание сбросов дерби</b>\n\n`;
    const now = new Date();

    resetOffsets.forEach((reset, index) => {
        const resetTime = new Date(derbyStartTime.getTime() + reset.hours * 60 * 60 * 1000);
        const isPast = resetTime <= now;
        const marker = isPast ? '✅' : '⏳';
        message += `${marker} ${index + 1}. ${reset.label}\n   ${resetTime.toLocaleString('ru-RU', { timeZone: 'Europe/Kyiv' })}\n\n`;
    });

    bot.sendMessage(msg.chat.id, message, { parse_mode: 'HTML' });
});

bot.onText(/\/clearderby$/, async (msg) => {
    await saveDerbyTime(null);
    scheduledJobs.forEach(job => job.cancel());
    scheduledJobs = [];
    bot.sendMessage(msg.chat.id, '✅ Дерби сброшено.');
});

bot.onText(/^\/?говори(?:@[\w_]+)?(?:\s+(.+))?$/i, async (msg, match) => {
    const chatId = msg.chat.id;
    const input = match[1];
    let targetUserId = null;
    let targetLabel = null;

    if (!input) {
        if (msg.reply_to_message) {
            targetUserId = msg.reply_to_message.from.id;
            targetLabel = getUserMention(msg.reply_to_message.from);
        } else {
            bot.sendMessage(chatId, '❌ Укажи ник: говори @username');
            return;
        }
    } else {
        const username = input.trim().split(/\s+/)[0];
        if (!username.startsWith('@')) {
            bot.sendMessage(chatId, '❌ Укажи ник в формате @username');
            return;
        }
        targetUserId = await findUserIdByUsername(chatId, username);
        if (!targetUserId) {
            bot.sendMessage(chatId, `❌ Не могу найти ${username}. Пусть он напишет что-то в чат.`);
            return;
        }
        targetLabel = username;
    }

    await bot.restrictChatMember(chatId, targetUserId, {
        until_date: 0,
        permissions: {
            can_send_messages: true,
            can_send_audios: true,
            can_send_documents: true,
            can_send_photos: true,
            can_send_videos: true,
            can_send_video_notes: true,
            can_send_voice_notes: true,
            can_send_polls: true,
            can_send_other_messages: true,
            can_add_web_page_previews: true
        }
    }).catch(() => {});

    bot.sendMessage(chatId, `✅ ${targetLabel} размучен.`, { parse_mode: 'HTML' });
});

bot.onText(/\/join$/, async (msg) => {
    const chatId = String(msg.chat.id);
    const user = msg.from;

    let chatParticipants = participants.get(chatId) || [];

    if (chatParticipants.some(p => p.id === user.id)) {
        bot.sendMessage(msg.chat.id, '⚠️ Вы уже в списке участников!');
        return;
    }

    const newParticipant = {
        id: user.id,
        username: user.username || null,
        name: user.first_name + (user.last_name ? ' ' + user.last_name : '')
    };

    await saveParticipant(msg.chat.id, newParticipant, true);
    chatParticipants.push(newParticipant);
    participants.set(chatId, chatParticipants);

    const name = user.username ? `@${user.username}` : user.first_name;
    bot.sendMessage(msg.chat.id, `✅ ${name} присоединился к скачкам!\n\nУчастников: ${chatParticipants.length}`);
});

bot.onText(/\/leave$/, async (msg) => {
    const chatId = String(msg.chat.id);
    const user = msg.from;

    let chatParticipants = participants.get(chatId) || [];
    const initialLength = chatParticipants.length;

    chatParticipants = chatParticipants.filter(p => p.id !== user.id);

    if (chatParticipants.length === initialLength) {
        bot.sendMessage(msg.chat.id, '⚠️ Вы не в списке участников.');
        return;
    }

    await saveParticipant(msg.chat.id, { id: user.id }, false);
    participants.set(chatId, chatParticipants);

    const name = user.username ? `@${user.username}` : user.first_name;
    bot.sendMessage(msg.chat.id, `👋 ${name} покинул скачки.\n\nОсталось участников: ${chatParticipants.length}`);
});

bot.onText(/\/participants$/, (msg) => {
    const chatId = String(msg.chat.id);
    const chatParticipants = getParticipantsList(chatId);

    if (chatParticipants.length === 0) {
        bot.sendMessage(msg.chat.id, '📋 Список участников пуст.\n\nИспользуйте /join чтобы присоединиться!');
        return;
    }

    let message = `📋 <b>Участники скачек (${chatParticipants.length}):</b>\n\n`;
    chatParticipants.forEach((p, index) => {
        const name = p.username ? `@${p.username}` : p.name;
        message += `${index + 1}. ${name}\n`;
    });

    bot.sendMessage(msg.chat.id, message, { parse_mode: 'HTML' });
});

bot.onText(/\/clearparticipants$/, async (msg) => {
    await clearParticipants(msg.chat.id);
    bot.sendMessage(msg.chat.id, '✅ Список участников очищен.');
});

bot.onText(/\/ping$/, (msg) => {
    const mentions = getParticipantMentions(msg.chat.id);
    if (!mentions) {
        bot.sendMessage(msg.chat.id, '❌ Нет участников для пинга. Используйте /join');
        return;
    }
    bot.sendMessage(msg.chat.id, `${mentions}\n\n📢 <b>Внимание участникам скачек!</b>`, { parse_mode: 'HTML' });
});

bot.onText(/\/pingall$/, (msg) => {
    const validPlayers = players.filter(p => p.telegram && p.telegram !== '-' && p.telegram.startsWith('@'));
    if (validPlayers.length === 0) {
        bot.sendMessage(msg.chat.id, '❌ Нет игроков с telegram для пинга.');
        return;
    }
    const mentions = validPlayers.map(p => p.telegram).join(' ');
    bot.sendMessage(msg.chat.id, `${mentions}\n\n📢 <b>Внимание всем игрокам!</b>`, { parse_mode: 'HTML' });
});

bot.onText(/\/players$/, (msg) => {
    if (players.length === 0) {
        bot.sendMessage(msg.chat.id, '📋 Список игроков пуст.');
        return;
    }

    let message = `🎮 <b>Список игроков (${players.length}):</b>\n\n`;
    players.forEach((p, index) => {
        message += `${index + 1}. 🎮 ${p.game}\n`;
        message += `   📱 ${p.telegram}\n`;
        message += `   👤 ${p.name}\n`;
        if (p.birthday) {
            message += `   🎂 ${p.birthday}\n`;
        }
        message += `\n`;
    });

    bot.sendMessage(msg.chat.id, message, { parse_mode: 'HTML' });
});

bot.onText(/\/player(?:\s+(.+))?$/, (msg, match) => {
    const search = match[1];

    if (!search) {
        bot.sendMessage(msg.chat.id, '❓ Укажите ник или имя игрока.\n\nПример: /player Монблан');
        return;
    }

    const searchLower = search.toLowerCase();
    const found = players.find(p =>
        p.game.toLowerCase().includes(searchLower) ||
        p.name.toLowerCase().includes(searchLower) ||
        p.telegram.toLowerCase().includes(searchLower)
    );

    if (!found) {
        bot.sendMessage(msg.chat.id, `❌ Игрок "${search}" не найден.`);
        return;
    }

    let message = `🎮 <b>${found.game}</b>\n📱 Telegram: ${found.telegram}\n👤 Имя: ${found.name}`;
    if (found.birthday) {
        message += `\n🎂 День рождения: ${found.birthday}`;
    }
    bot.sendMessage(msg.chat.id, message, { parse_mode: 'HTML' });
});

bot.onText(/\/addplayer(?:\s+(.+))?$/, async (msg, match) => {
    const input = match[1];

    if (!input) {
        bot.sendMessage(msg.chat.id,
`➕ <b>Добавить игрока</b>

Формат: /addplayer Ник | @telegram | Имя | ДД.ММ

Пример: /addplayer Монблан | @Matricariay | Лана | 14.07

День рождения можно не указывать.`, { parse_mode: 'HTML' });
        return;
    }

    const parts = input.split('|').map(s => s.trim());
    if (parts.length < 3) {
        bot.sendMessage(msg.chat.id, '❌ Неверный формат. Пример: /addplayer Монблан | @Matricariay | Лана | 14.07');
        return;
    }

    const [game, telegram, name, birthday] = parts;
    await addPlayer(game, telegram, name, birthday || null);

    let response = `✅ Игрок добавлен!\n\n🎮 ${game}\n📱 ${telegram}\n👤 ${name}`;
    if (birthday) response += `\n🎂 ${birthday}`;
    bot.sendMessage(msg.chat.id, response);
});

bot.onText(/\/removeplayer(?:\s+(.+))?$/, async (msg, match) => {
    const search = match[1];

    if (!search) {
        bot.sendMessage(msg.chat.id, '❓ Укажите ник игрока для удаления.\n\nПример: /removeplayer Монблан');
        return;
    }

    const searchLower = search.toLowerCase();
    const index = players.findIndex(p =>
        p.game.toLowerCase() === searchLower ||
        p.telegram.toLowerCase() === searchLower
    );

    if (index === -1) {
        bot.sendMessage(msg.chat.id, `❌ Игрок "${search}" не найден.`);
        return;
    }

    const removed = await removePlayer(index);
    bot.sendMessage(msg.chat.id, `✅ Игрок удалён!\n\n🎮 ${removed.game}\n📱 ${removed.telegram}\n👤 ${removed.name}`);
});

bot.onText(/\/editplayer(?:\s+(.+))?$/, async (msg, match) => {
    const input = match[1];

    if (!input) {
        bot.sendMessage(msg.chat.id,
`✏️ <b>Редактировать игрока</b>

Формат: /editplayer СтарыйНик | НовыйНик | @telegram | Имя | ДД.ММ

Пример: /editplayer Монблан | Монблан2 | @NewTelegram | Лана | 14.07

Поля которые не нужно менять можно оставить пустыми:
/editplayer Монблан | | @NewTelegram | |`, { parse_mode: 'HTML' });
        return;
    }

    const parts = input.split('|').map(s => s.trim());
    if (parts.length < 2) {
        bot.sendMessage(msg.chat.id, '❌ Неверный формат.');
        return;
    }

    const [search, ...rest] = parts;
    const searchLower = search.toLowerCase();
    const player = players.find(p =>
        p.game.toLowerCase().includes(searchLower) ||
        p.telegram.toLowerCase().includes(searchLower)
    );

    if (!player) {
        bot.sendMessage(msg.chat.id, `❌ Игрок "${search}" не найден.`);
        return;
    }

    const [newGame, newTelegram, newName, newBirthday] = rest;

    const updatedData = {
        game: newGame || player.game,
        telegram: newTelegram || player.telegram,
        name: newName || player.name,
        birthday: newBirthday || player.birthday
    };

    await updatePlayer(player.id, updatedData);

    let response = `✅ Игрок обновлён!\n\n🎮 ${updatedData.game}\n📱 ${updatedData.telegram}\n👤 ${updatedData.name}`;
    if (updatedData.birthday) response += `\n🎂 ${updatedData.birthday}`;
    bot.sendMessage(msg.chat.id, response);
});

bot.onText(/\/setbirthday(?:\s+(.+))?$/, async (msg, match) => {
    const input = match[1];

    if (!input) {
        bot.sendMessage(msg.chat.id,
`🎂 <b>Установить день рождения</b>

Формат: /setbirthday Ник | ДД.ММ

Пример: /setbirthday Монблан | 14.07`, { parse_mode: 'HTML' });
        return;
    }

    const parts = input.split('|').map(s => s.trim());
    if (parts.length !== 2) {
        bot.sendMessage(msg.chat.id, '❌ Неверный формат. Пример: /setbirthday Монблан | 14.07');
        return;
    }

    const [search, birthday] = parts;
    const searchLower = search.toLowerCase();
    const player = players.find(p =>
        p.game.toLowerCase().includes(searchLower) ||
        p.name.toLowerCase().includes(searchLower)
    );

    if (!player) {
        bot.sendMessage(msg.chat.id, `❌ Игрок "${search}" не найден.`);
        return;
    }

    await updatePlayerBirthday(player.id, birthday);
    bot.sendMessage(msg.chat.id, `✅ День рождения установлен!\n\n🎮 ${player.game}\n🎂 ${birthday}`);
});

bot.onText(/\/birthdays$/, (msg) => {
    const withBirthdays = players.filter(p => p.birthday);

    if (withBirthdays.length === 0) {
        bot.sendMessage(msg.chat.id, '🎂 Нет записей о днях рождения.');
        return;
    }

    const months = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
                    'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];

    const sorted = [...withBirthdays].sort((a, b) => {
        const [dayA, monthA] = a.birthday.split('.').map(Number);
        const [dayB, monthB] = b.birthday.split('.').map(Number);
        return monthA - monthB || dayA - dayB;
    });

    let message = `🎂 <b>Дни рождения:</b>\n\n`;
    sorted.forEach(p => {
        const [day, month] = p.birthday.split('.').map(Number);
        message += `${day} ${months[month - 1]} - ${p.name} (${p.game})\n`;
    });

    bot.sendMessage(msg.chat.id, message, { parse_mode: 'HTML' });
});

bot.onText(/\/topchat$/, async (msg) => {
    const top = await getTopMessages(msg.chat.id);
    if (top.length === 0) {
        bot.sendMessage(msg.chat.id, '📊 Пока нет статистики сообщений.');
        return;
    }

    let message = '💬 <b>Топ болтунов:</b>\n\n';
    top.forEach((u, i) => {
        const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}.`;
        const name = u.username ? `@${u.username}` : u.name;
        message += `${medal} ${name} — ${u.message_count} сообщений\n`;
    });

    bot.sendMessage(msg.chat.id, message, { parse_mode: 'HTML' });
});

bot.onText(/\/topduel$/, async (msg) => {
    const top = await getTopDuel(msg.chat.id);
    if (top.length === 0) {
        bot.sendMessage(msg.chat.id, '🔫 Пока нет статистики дуэлей.');
        return;
    }

    let message = '🔫 <b>Топ дуэлянтов:</b>\n\n';
    top.forEach((u, i) => {
        const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}.`;
        const name = u.username ? `@${u.username}` : u.name;
        const winrate = u.duel_wins + u.duel_losses > 0
            ? Math.round(u.duel_wins / (u.duel_wins + u.duel_losses) * 100)
            : 0;
        message += `${medal} ${name} — ${u.duel_wins}W/${u.duel_losses}L (${winrate}%)\n`;
    });

    bot.sendMessage(msg.chat.id, message, { parse_mode: 'HTML' });
});

bot.onText(/\/topcoin$/, async (msg) => {
    const top = await getTopCoin(msg.chat.id);
    if (top.length === 0) {
        bot.sendMessage(msg.chat.id, '🪙 Пока нет статистики монетки.');
        return;
    }

    let message = '🪙 <b>Топ монетки:</b>\n\n';
    top.forEach((u, i) => {
        const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}.`;
        const name = u.username ? `@${u.username}` : u.name;
        const winrate = u.coin_wins + u.coin_losses > 0
            ? Math.round(u.coin_wins / (u.coin_wins + u.coin_losses) * 100)
            : 0;
        message += `${medal} ${name} — ${u.coin_wins}W/${u.coin_losses}L (${winrate}%)\n`;
    });

    bot.sendMessage(msg.chat.id, message, { parse_mode: 'HTML' });
});

const RANDOM_PHRASES = [
    'стояночка минуточка',
    'На дальнем.',
    'На ближнем.',
    'ОУ НЕ ТОРОПИ ЛОШАДЕЙ',
    'Фугани 5к',
    'Где мое пиво?'
];

const TEA_PHRASES = [
    'ОУ КАКОЙ ЧАЙ????',
    'У меня есть рево вместо чая, будешь?',
    'Го по пиву - ну его в баню тот чай',
    'Хочешь я тебе сижку дам?',
    'Где ты спрятал бутылку водки?',
    'Дай 5 гривен'
];

const GIVE_PHRASES = [
    'Не дам',
    'Зачем тебе?',
    'Так если я тебе дам, у меня не будет',
    'Не хочу и не дам',
    'Заставь меня',
    'Умоляй меня'
];

const WORK_PHRASES = [
    'Какая работа ОУ!!!',
    'От работы кони дохнут',
    'Выключай свою работу уже хватит!!!',
    'Сколько можно работать!!!',
    'Кому на роду написано бык - тому кнут!'
];

const BOT_PHRASES = [
    'Я НЕ БОТ!',
    'Хватит меня обзывать ботом!',
    'Вы сами как те боты',
    'Та не...'
];

async function askAI(question) {
    const response = await groq.chat.completions.create({
        model: 'llama-3.3-70b-versatile',
        messages: [
            {
                role: 'system',
                content: 'Ты - современный подросток который общается в чате. Отвечай на вопросы используя молодежный сленг, такие слова как: краш, рофл, чилить, вайб, кринж, имба, изи, база, лол, орать (в смысле смеяться), душнить, агриться, флексить, зашквар, топ, пруфы и т.д. Отвечай коротко, дерзко и по делу. Можешь использовать эмодзи но не переборщи.'
            },
            {
                role: 'user',
                content: question
            }
        ],
        max_tokens: 500
    });
    return response.choices[0].message.content;
}

bot.on('message', async (msg) => {
    if (!msg.text || msg.text.startsWith('/')) return;
    if (/^говори\b/i.test(msg.text)) return;

    const text = msg.text.toLowerCase().trim();
    const chatId = msg.chat.id;
    const chatKey = getDuelKey(chatId);
    const user = msg.from;

    updateMessageStats(chatId, user).catch(() => {});

    if (text === 'монетка' || text === 'кто монетка') {
        bot.sendMessage(chatId, `🪙 ${getUserMention(user)} предлагает сыграть в монетку!\n\nНапишите "орёл" или "решка" чтобы принять.`, { parse_mode: 'HTML' });
        duelChallenges.set(chatKey + '_coin', {
            challenger: user,
            time: Date.now()
        });
        return;
    }

    if (/^монетка\s+@\w+/i.test(text)) {
        const targetUsername = text.match(/@(\w+)/)[1];
        bot.sendMessage(chatId, `🪙 ${getUserMention(user)} вызывает @${targetUsername} на монетку!\n\n@${targetUsername}, напишите "орёл" или "решка" чтобы принять.`, { parse_mode: 'HTML' });
        duelChallenges.set(chatKey + '_coin', {
            challenger: user,
            targetUsername: targetUsername.toLowerCase(),
            time: Date.now()
        });
        return;
    }

    if (text === 'орёл' || text === 'орел' || text === 'решка') {
        const coinChallenge = duelChallenges.get(chatKey + '_coin');
        if (!coinChallenge) return;
        if (coinChallenge.challenger.id === user.id) {
            bot.sendMessage(chatId, '❌ Нельзя играть с самим собой!');
            return;
        }
        if (coinChallenge.targetUsername && user.username?.toLowerCase() !== coinChallenge.targetUsername) {
            return;
        }

        duelChallenges.delete(chatKey + '_coin');
        const player1 = coinChallenge.challenger;
        const player2 = user;
        const player2Choice = text === 'решка' ? 'решка' : 'орёл';
        const player1Choice = player2Choice === 'орёл' ? 'решка' : 'орёл';

        const result = Math.random() < 0.5 ? 'орёл' : 'решка';
        const coin = result === 'орёл' ? '🦅' : '🪙';

        const winner = result === player1Choice ? player1 : player2;
        const loser = result === player1Choice ? player2 : player1;

        updateGameStats(chatId, winner, 'coin', true).catch(() => {});
        updateGameStats(chatId, loser, 'coin', false).catch(() => {});

        bot.sendMessage(chatId, `🪙 Монетка крутится...\n\n${getUserMention(player1)}: ${player1Choice}\n${getUserMention(player2)}: ${player2Choice}\n\n${coin} Выпало: <b>${result.toUpperCase()}</b>!\n\n🏆 Победитель: ${getUserMention(winner)}\n💀 ${getUserMention(loser)} молчит 1 минуту! 🤐`, { parse_mode: 'HTML' });

        bot.restrictChatMember(chatId, loser.id, {
            until_date: Math.floor(Date.now() / 1000) + 60,
            permissions: { can_send_messages: false }
        }).catch(() => {});
        return;
    }

    if (text === 'кто дуэль' || text === 'кто дуель') {
        bot.sendMessage(chatId, `🔫 ${getUserMention(user)} ищет соперника для дуэли!\n\nНапишите "дуэль да" чтобы принять вызов.`, { parse_mode: 'HTML' });
        duelChallenges.set(chatKey, {
            challenger: user,
            time: Date.now()
        });
        return;
    }

    if (/^дуэль\s+@\w+/.test(text)) {
        const targetUsername = text.match(/@(\w+)/)[1];
        bot.sendMessage(chatId, `🔫 ${getUserMention(user)} вызывает @${targetUsername} на дуэль!\n\n@${targetUsername}, напишите "дуэль да" чтобы принять или "дуэль нет" чтобы отклонить.`, { parse_mode: 'HTML' });
        duelChallenges.set(chatKey, {
            challenger: user,
            targetUsername: targetUsername.toLowerCase(),
            time: Date.now()
        });
        return;
    }

    if (text === 'дуэль да' || text === 'дуель да') {
        const challenge = duelChallenges.get(chatKey);
        if (!challenge) {
            bot.sendMessage(chatId, '❌ Нет активного вызова на дуэль.');
            return;
        }
        if (challenge.challenger.id === user.id) {
            bot.sendMessage(chatId, '❌ Нельзя принять свой же вызов!');
            return;
        }
        if (challenge.targetUsername && user.username?.toLowerCase() !== challenge.targetUsername) {
            bot.sendMessage(chatId, '❌ Этот вызов адресован другому игроку.');
            return;
        }

        duelChallenges.delete(chatKey);
        const duel = {
            player1: challenge.challenger,
            player2: user,
            turn: Math.random() < 0.5 ? challenge.challenger.id : user.id,
            aim: { [challenge.challenger.id]: 0, [user.id]: 0 },
            hp: { [challenge.challenger.id]: 1, [user.id]: 1 }
        };
        activeDuels.set(chatKey, duel);

        const firstPlayer = duel.turn === duel.player1.id ? duel.player1 : duel.player2;
        bot.sendMessage(chatId, `⚔️ <b>ДУЭЛЬ НАЧАЛАСЬ!</b>\n\n${getUserMention(duel.player1)} ⚔️ ${getUserMention(duel.player2)}\n\nПервый ход: ${getUserMention(firstPlayer)}\n\nКоманды:\n• выстрел - стрелять\n• прицелиться - +20% к шансу попадания\n• сбросить прицел - сбросить бонусы`, { parse_mode: 'HTML' });
        return;
    }

    if (text === 'дуэль нет' || text === 'дуель нет') {
        const challenge = duelChallenges.get(chatKey);
        if (!challenge) {
            bot.sendMessage(chatId, '❌ Нет активного вызова на дуэль.');
            return;
        }
        if (challenge.targetUsername && user.username?.toLowerCase() !== challenge.targetUsername) {
            return;
        }
        duelChallenges.delete(chatKey);
        bot.sendMessage(chatId, `${getUserMention(user)} отклонил вызов на дуэль.`, { parse_mode: 'HTML' });
        return;
    }

    if (text === 'дуэль отмена' || text === 'дуель отмена') {
        const challenge = duelChallenges.get(chatKey);
        if (challenge && challenge.challenger.id === user.id) {
            duelChallenges.delete(chatKey);
            bot.sendMessage(chatId, '❌ Вызов на дуэль отменён.');
            return;
        }
        const duel = activeDuels.get(chatKey);
        if (duel && (duel.player1.id === user.id || duel.player2.id === user.id)) {
            activeDuels.delete(chatKey);
            bot.sendMessage(chatId, `🏳️ ${getUserMention(user)} сдался! Дуэль окончена.`, { parse_mode: 'HTML' });
            return;
        }
        bot.sendMessage(chatId, '❌ Нечего отменять.');
        return;
    }

    if (text === 'выстрел') {
        const duel = activeDuels.get(chatKey);
        if (!duel) {
            return;
        }
        if (duel.turn !== user.id) {
            bot.sendMessage(chatId, '❌ Сейчас не твой ход!');
            return;
        }

        const opponent = duel.player1.id === user.id ? duel.player2 : duel.player1;
        const aimBonus = duel.aim[user.id] || 0;
        const hitChance = 60 + aimBonus;
        const hit = Math.random() * 100 < hitChance;

        duel.aim[user.id] = 0;

        if (hit) {
            activeDuels.delete(chatKey);
            updateGameStats(chatId, user, 'duel', true).catch(() => {});
            updateGameStats(chatId, opponent, 'duel', false).catch(() => {});

            bot.sendMessage(chatId, `🔫 <b>БАХ!</b>\n\n${getUserMention(user)} попал в ${getUserMention(opponent)}!\n\n🏆 Победитель: ${getUserMention(user)}\n\n${getUserMention(opponent)} молчит 5 минут! 🤐`, { parse_mode: 'HTML' });

            bot.restrictChatMember(chatId, opponent.id, {
                until_date: Math.floor(Date.now() / 1000) + 300,
                permissions: {
                    can_send_messages: false,
                    can_send_media_messages: false,
                    can_send_other_messages: false
                }
            }).catch(() => {});
        } else {
            duel.turn = opponent.id;
            bot.sendMessage(chatId, `🔫 ${getUserMention(user)} выстрелил и промахнулся!\n\nХод переходит к ${getUserMention(opponent)}`, { parse_mode: 'HTML' });
        }
        return;
    }

    if (text === 'прицелиться') {
        const duel = activeDuels.get(chatKey);
        if (!duel) {
            return;
        }
        if (duel.turn !== user.id) {
            bot.sendMessage(chatId, '❌ Сейчас не твой ход!');
            return;
        }

        const opponent = duel.player1.id === user.id ? duel.player2 : duel.player1;
        duel.aim[user.id] = (duel.aim[user.id] || 0) + 20;
        duel.turn = opponent.id;

        bot.sendMessage(chatId, `🎯 ${getUserMention(user)} прицеливается... (+20% к попаданию, всего: ${duel.aim[user.id]}%)\n\nХод переходит к ${getUserMention(opponent)}`, { parse_mode: 'HTML' });
        return;
    }

    if (text === 'сбросить прицел') {
        const duel = activeDuels.get(chatKey);
        if (!duel) {
            return;
        }
        if (duel.turn !== user.id) {
            bot.sendMessage(chatId, '❌ Сейчас не твой ход!');
            return;
        }

        duel.aim[user.id] = 0;
        bot.sendMessage(chatId, `${getUserMention(user)} сбросил прицел.`, { parse_mode: 'HTML' });
        return;
    }

    if (/^ии\s+/i.test(msg.text)) {
        const question = msg.text.replace(/^ии\s+/i, '').trim();
        if (!question) {
            bot.sendMessage(msg.chat.id, 'Бро, ты вопрос то напиши после "ИИ" 💀');
            return;
        }
        try {
            const response = await askAI(question);
            bot.sendMessage(msg.chat.id, response);
        } catch (error) {
            console.error('Gemini error:', error);
            bot.sendMessage(msg.chat.id, 'Ауч, ИИ сломался, кринж момент 💀');
        }
        return;
    }

    if (/скачки|скакать/.test(text)) {
        const phrase = RANDOM_PHRASES[Math.floor(Math.random() * RANDOM_PHRASES.length)];
        bot.sendMessage(msg.chat.id, phrase);
        return;
    }

    if (/чай|кофе|чаю/.test(text)) {
        const phrase = TEA_PHRASES[Math.floor(Math.random() * TEA_PHRASES.length)];
        bot.sendMessage(msg.chat.id, phrase);
        return;
    }

    if (/есть|дайте|пожалуйста/.test(text)) {
        const phrase = GIVE_PHRASES[Math.floor(Math.random() * GIVE_PHRASES.length)];
        bot.sendMessage(msg.chat.id, phrase);
        return;
    }

    if (/работаю|на работе|тружусь/.test(text)) {
        const phrase = WORK_PHRASES[Math.floor(Math.random() * WORK_PHRASES.length)];
        bot.sendMessage(msg.chat.id, phrase);
        return;
    }

    if (/бот/.test(text)) {
        const phrase = BOT_PHRASES[Math.floor(Math.random() * BOT_PHRASES.length)];
        bot.sendMessage(msg.chat.id, phrase);
        return;
    }
});

async function start() {
    await initDB();
    await loadData();
    scheduleRabbitNotifications();
    scheduleDerbyResets();
    scheduleBirthdayNotifications();
    console.log('🐰 Hay Day Derby Bot запущен! (PostgreSQL)');
}

start().catch(console.error);
