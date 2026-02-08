const TelegramBot = require('node-telegram-bot-api');
const schedule = require('node-schedule');
const { Pool } = require('pg');

const TOKEN = process.env.TELEGRAM_BOT_TOKEN || 'YOUR_BOT_TOKEN';
const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://postgres:iHJFUqFoOcTrkwBeeLcRUEYBuTzVuMbY@turntable.proxy.rlwy.net:51550/railway';

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

bot.onText(/\/start/, async (msg) => {
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
/ping - Пингануть всех участников

<b>Игроки:</b>
/players - Список всех игроков
/player [ник] - Найти игрока
/addplayer - Добавить игрока
/removeplayer [ник] - Удалить игрока
/birthdays - Дни рождения
/setbirthday - Установить день рождения

<b>Настройки:</b>
/setderby - Установить время старта дерби
/subscribe - Подписаться на уведомления
/unsubscribe - Отписаться`, { parse_mode: 'HTML' });
});

bot.onText(/\/subscribe/, async (msg) => {
    await saveSubscriber(msg.chat.id, true);
    bot.sendMessage(msg.chat.id, '✅ Вы подписаны на уведомления!');
});

bot.onText(/\/unsubscribe/, async (msg) => {
    await saveSubscriber(msg.chat.id, false);
    bot.sendMessage(msg.chat.id, '❌ Вы отписаны от уведомлений.');
});

bot.onText(/\/status/, (msg) => {
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

bot.onText(/\/setderby(?:\s+(.+))?/, async (msg, match) => {
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

bot.onText(/\/rabbit/, (msg) => {
    const next = getNextRabbit();
    bot.sendMessage(msg.chat.id,
`🐰 <b>Расписание кроликов (по Киеву)</b>

• Вторник - 14:35
• Среда - 20:50
• Пятница - 19:50

Следующий: <b>${next.label} ${next.hour}:${String(next.minute).padStart(2, '0')}</b>`, { parse_mode: 'HTML' });
});

bot.onText(/\/resets/, (msg) => {
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

bot.onText(/\/clearderby/, async (msg) => {
    await saveDerbyTime(null);
    scheduledJobs.forEach(job => job.cancel());
    scheduledJobs = [];
    bot.sendMessage(msg.chat.id, '✅ Дерби сброшено.');
});

bot.onText(/\/join/, async (msg) => {
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

bot.onText(/\/leave/, async (msg) => {
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

bot.onText(/\/participants/, (msg) => {
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

bot.onText(/\/clearparticipants/, async (msg) => {
    await clearParticipants(msg.chat.id);
    bot.sendMessage(msg.chat.id, '✅ Список участников очищен.');
});

bot.onText(/\/ping/, (msg) => {
    const mentions = getParticipantMentions(msg.chat.id);
    if (!mentions) {
        bot.sendMessage(msg.chat.id, '❌ Нет участников для пинга. Используйте /join');
        return;
    }
    bot.sendMessage(msg.chat.id, `${mentions}\n\n📢 <b>Внимание участникам скачек!</b>`, { parse_mode: 'HTML' });
});

bot.onText(/\/players/, (msg) => {
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

bot.onText(/\/player(?:\s+(.+))?/, (msg, match) => {
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

bot.onText(/\/addplayer(?:\s+(.+))?/, async (msg, match) => {
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

bot.onText(/\/removeplayer(?:\s+(.+))?/, async (msg, match) => {
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

bot.onText(/\/setbirthday(?:\s+(.+))?/, async (msg, match) => {
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

bot.onText(/\/birthdays/, (msg) => {
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

bot.on('message', (msg) => {
    if (!msg.text || msg.text.startsWith('/')) return;

    const text = msg.text.toLowerCase();

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
