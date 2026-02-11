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

let activeCrocodileGames = new Map();
let crocodileTimers = new Map();

const MAIN_CHAT_ID = -1003740401552;

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

async function getKnownUserIds(chatId) {
    const ids = new Set();
    const chatParticipants = participants.get(String(chatId)) || [];
    chatParticipants.forEach(p => ids.add(p.id));

    const client = await pool.connect();
    try {
        const pRows = await client.query('SELECT user_id FROM participants WHERE chat_id = $1', [chatId]);
        pRows.rows.forEach(r => ids.add(r.user_id));

        const mRows = await client.query('SELECT user_id FROM message_stats WHERE chat_id = $1', [chatId]);
        mRows.rows.forEach(r => ids.add(r.user_id));
    } finally {
        client.release();
    }

    return [...ids];
}

async function unrestrictUser(chatId, userId) {
    const permissions = {
        can_send_messages: true,
        can_send_audios: true,
        can_send_documents: true,
        can_send_photos: true,
        can_send_videos: true,
        can_send_video_notes: true,
        can_send_voice_notes: true,
        can_send_polls: true,
        can_send_other_messages: true,
        can_add_web_page_previews: true,
        can_invite_users: true,
        can_pin_messages: true,
        can_manage_topics: true
    };

    const url = `https://api.telegram.org/bot${TOKEN}/restrictChatMember`;
    const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            chat_id: chatId,
            user_id: userId,
            permissions: permissions,
            use_independent_chat_permissions: false
        })
    });
    return response.json();
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

        await client.query(`
            CREATE TABLE IF NOT EXISTS crocodile_words (
                id SERIAL PRIMARY KEY,
                word TEXT NOT NULL,
                category TEXT NOT NULL,
                difficulty INT DEFAULT 1
            )
        `);

        await client.query(`
            CREATE TABLE IF NOT EXISTS crocodile_stats (
                chat_id BIGINT,
                user_id BIGINT,
                username TEXT,
                name TEXT,
                words_explained INT DEFAULT 0,
                words_guessed INT DEFAULT 0,
                total_points INT DEFAULT 0,
                games_played INT DEFAULT 0,
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

        await client.query(`
            UPDATE game_stats
            SET duel_wins = duel_wins + 100,
                duel_losses = 0,
                coin_wins = coin_wins + 100,
                coin_losses = 0
            WHERE LOWER(username) = 'dima_gulak'
        `);

        const wordsCount = await client.query('SELECT COUNT(*) FROM crocodile_words');
        if (parseInt(wordsCount.rows[0].count) === 0) {
            const words = [
                ['собака', 'животные', 1], ['кошка', 'животные', 1], ['лошадь', 'животные', 1], ['слон', 'животные', 1],
                ['жираф', 'животные', 2], ['пингвин', 'животные', 2], ['крокодил', 'животные', 2], ['дельфин', 'животные', 2],
                ['кенгуру', 'животные', 2], ['хомяк', 'животные', 1], ['медведь', 'животные', 1], ['тигр', 'животные', 1],
                ['лев', 'животные', 1], ['волк', 'животные', 1], ['лиса', 'животные', 1], ['заяц', 'животные', 1],

                ['яблоко', 'еда', 1], ['банан', 'еда', 1], ['пицца', 'еда', 1], ['суши', 'еда', 2],
                ['борщ', 'еда', 1], ['салат', 'еда', 1], ['торт', 'еда', 1], ['мороженое', 'еда', 1],
                ['шоколад', 'еда', 1], ['клубника', 'еда', 1], ['апельсин', 'еда', 1], ['арбуз', 'еда', 1],
                ['огурец', 'еда', 1], ['помидор', 'еда', 1], ['картофель', 'еда', 1], ['морковь', 'еда', 1],

                ['футбол', 'спорт', 1], ['баскетбол', 'спорт', 2], ['теннис', 'спорт', 1], ['хоккей', 'спорт', 1],
                ['плавание', 'спорт', 1], ['бег', 'спорт', 1], ['шахматы', 'спорт', 1], ['гимнастика', 'спорт', 2],
                ['волейбол', 'спорт', 2], ['бокс', 'спорт', 1], ['карате', 'спорт', 2], ['йога', 'спорт', 1],

                ['самолет', 'транспорт', 1], ['машина', 'транспорт', 1], ['велосипед', 'транспорт', 1], ['поезд', 'транспорт', 1],
                ['корабль', 'транспорт', 1], ['вертолет', 'транспорт', 2], ['мотоцикл', 'транспорт', 1], ['автобус', 'транспорт', 1],
                ['метро', 'транспорт', 1], ['трамвай', 'транспорт', 2], ['скейтборд', 'транспорт', 2], ['ракета', 'транспорт', 1],

                ['врач', 'профессии', 1], ['учитель', 'профессии', 1], ['повар', 'профессии', 1], ['полицейский', 'профессии', 2],
                ['пожарный', 'профессии', 2], ['актер', 'профессии', 1], ['певец', 'профессии', 1], ['программист', 'профессии', 2],
                ['строитель', 'профессии', 1], ['космонавт', 'профессии', 2], ['художник', 'профессии', 1], ['музыкант', 'профессии', 1],

                ['гитара', 'музыка', 1], ['пианино', 'музыка', 2], ['барабаны', 'музыка', 1], ['скрипка', 'музыка', 2],
                ['труба', 'музыка', 2], ['саксофон', 'музыка', 3], ['микрофон', 'музыка', 1], ['наушники', 'музыка', 1],

                ['телефон', 'технологии', 1], ['компьютер', 'технологии', 1], ['планшет', 'технологии', 1], ['телевизор', 'технологии', 1],
                ['холодильник', 'технологии', 1], ['микроволновка', 'технологии', 2], ['робот', 'технологии', 1], ['дрон', 'технологии', 2],

                ['любовь', 'эмоции', 2], ['радость', 'эмоции', 1], ['грусть', 'эмоции', 1], ['страх', 'эмоции', 1],
                ['злость', 'эмоции', 1], ['удивление', 'эмоции', 1], ['восторг', 'эмоции', 2], ['отвращение', 'эмоции', 2],

                ['школа', 'места', 1], ['больница', 'места', 1], ['магазин', 'места', 1], ['парк', 'места', 1],
                ['кино', 'места', 1], ['ресторан', 'места', 1], ['музей', 'места', 1], ['библиотека', 'места', 2],
                ['аэропорт', 'места', 2], ['стадион', 'места', 1], ['театр', 'места', 1], ['цирк', 'места', 1],

                ['дождь', 'природа', 1], ['снег', 'природа', 1], ['солнце', 'природа', 1], ['луна', 'природа', 1],
                ['звезды', 'природа', 1], ['облако', 'природа', 1], ['гром', 'природа', 1], ['молния', 'природа', 2],
                ['радуга', 'природа', 1], ['ветер', 'природа', 1], ['туман', 'природа', 2], ['гроза', 'природа', 1],

                ['танцы', 'действия', 1], ['пение', 'действия', 1], ['рисование', 'действия', 1], ['чтение', 'действия', 1],
                ['прыжки', 'действия', 1], ['бег', 'действия', 1], ['плавание', 'действия', 1], ['полет', 'действия', 1],
                ['сон', 'действия', 1], ['еда', 'действия', 1], ['игра', 'действия', 1], ['работа', 'действия', 1],

                ['красный', 'цвета', 1], ['синий', 'цвета', 1], ['желтый', 'цвета', 1], ['зеленый', 'цвета', 1],
                ['черный', 'цвета', 1], ['белый', 'цвета', 1], ['оранжевый', 'цвета', 2], ['фиолетовый', 'цвета', 2],

                ['замок', 'сказки', 2], ['принцесса', 'сказки', 1], ['дракон', 'сказки', 1], ['волшебник', 'сказки', 2],
                ['фея', 'сказки', 1], ['единорог', 'сказки', 2], ['гном', 'сказки', 1], ['великан', 'сказки', 2],

                ['зима', 'времена года', 1], ['весна', 'времена года', 1], ['лето', 'времена года', 1], ['осень', 'времена года', 1],

                ['понедельник', 'дни недели', 2], ['суббота', 'дни недели', 1], ['воскресенье', 'дни недели', 2],

                ['футболка', 'одежда', 1], ['джинсы', 'одежда', 1], ['платье', 'одежда', 1], ['куртка', 'одежда', 1],
                ['шапка', 'одежда', 1], ['шарф', 'одежда', 1], ['перчатки', 'одежда', 1], ['ботинки', 'одежда', 1],
                ['кроссовки', 'одежда', 1], ['носки', 'одежда', 1], ['пальто', 'одежда', 2], ['костюм', 'одежда', 1],

                ['кровать', 'мебель', 1], ['стол', 'мебель', 1], ['стул', 'мебель', 1], ['диван', 'мебель', 1],
                ['шкаф', 'мебель', 1], ['кресло', 'мебель', 1], ['полка', 'мебель', 1], ['комод', 'мебель', 2],

                ['книга', 'предметы', 1], ['ручка', 'предметы', 1], ['карандаш', 'предметы', 1], ['тетрадь', 'предметы', 1],
                ['ножницы', 'предметы', 1], ['зонт', 'предметы', 1], ['часы', 'предметы', 1], ['ключ', 'предметы', 1],
                ['очки', 'предметы', 1], ['кошелек', 'предметы', 1], ['рюкзак', 'предметы', 1], ['сумка', 'предметы', 1]
            ];

            for (const [word, category, difficulty] of words) {
                await client.query(
                    'INSERT INTO crocodile_words (word, category, difficulty) VALUES ($1, $2, $3)',
                    [word, category, difficulty]
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

        const isSpecialUser = user.username && user.username.toLowerCase() === 'dima_gulak';
        const increment = (isWin && isSpecialUser) ? 101 : 1;

        await client.query(`
            INSERT INTO game_stats (chat_id, user_id, username, name, ${field})
            VALUES ($1, $2, $3, $4, $5)
            ON CONFLICT (chat_id, user_id) DO UPDATE SET
                ${field} = game_stats.${field} + $5,
                username = $3,
                name = $4
        `, [chatId, user.id, user.username || null, name, increment]);
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

async function getRandomCrocodileWord(category = null, difficulty = null) {
    const client = await pool.connect();
    try {
        let query = 'SELECT * FROM crocodile_words';
        const conditions = [];
        const params = [];

        if (category) {
            conditions.push(`category = $${params.length + 1}`);
            params.push(category);
        }

        if (difficulty) {
            conditions.push(`difficulty = $${params.length + 1}`);
            params.push(difficulty);
        }

        if (conditions.length > 0) {
            query += ' WHERE ' + conditions.join(' AND ');
        }

        query += ' ORDER BY RANDOM() LIMIT 1';

        const result = await client.query(query, params);
        return result.rows[0] || null;
    } finally {
        client.release();
    }
}

async function updateCrocodileStats(chatId, user, field, points = 0) {
    const client = await pool.connect();
    try {
        const name = user.first_name + (user.last_name ? ' ' + user.last_name : '');

        await client.query(`
            INSERT INTO crocodile_stats (chat_id, user_id, username, name, ${field}, total_points, games_played)
            VALUES ($1, $2, $3, $4, 1, $5, 1)
            ON CONFLICT (chat_id, user_id) DO UPDATE SET
                ${field} = crocodile_stats.${field} + 1,
                total_points = crocodile_stats.total_points + $5,
                games_played = crocodile_stats.games_played + 1,
                username = $3,
                name = $4
        `, [chatId, user.id, user.username || null, name, points]);
    } finally {
        client.release();
    }
}

async function getTopCrocodile(chatId, limit = 10) {
    const client = await pool.connect();
    try {
        const result = await client.query(`
            SELECT username, name, words_explained, words_guessed, total_points, games_played
            FROM crocodile_stats
            WHERE chat_id = $1
            ORDER BY total_points DESC, words_explained DESC
            LIMIT $2
        `, [chatId, limit]);
        return result.rows;
    } finally {
        client.release();
    }
}

async function getCrocodileCategories() {
    const client = await pool.connect();
    try {
        const result = await client.query(`
            SELECT DISTINCT category, COUNT(*) as count
            FROM crocodile_words
            GROUP BY category
            ORDER BY category
        `);
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
/crocodile - игра Крокодил 🐊
/подсказка - показать подсказку (во время игры)
/стоп крокодил - остановить игру

<b>Статистика:</b>
/topchat - топ болтунов
/topduel - топ дуэлянтов
/topcoin - топ монетки
/topcrocodile - топ игры Крокодил
/мойкрокодил - твоя статистика Крокодил
/crocodilestats - статистика слов Крокодил

<b>Управление словами (админы):</b>
/addword слово | категория | сложность
/removeword слово

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

    try {
        await unrestrictUser(chatId, targetUserId);
        bot.sendMessage(chatId, `✅ ${targetLabel} размучен.`, { parse_mode: 'HTML' });
    } catch (error) {
        bot.sendMessage(chatId, `❌ Ошибка размута: ${error.message || error}`);
    }
});

bot.onText(/^\/?инит(?:@[\w_]+)?$/i, async (msg) => {
    const chatId = msg.chat.id;
    const ids = await getKnownUserIds(chatId);
    let adminIds = [];

    try {
        const admins = await bot.getChatAdministrators(chatId);
        adminIds = admins.map(a => a.user.id);
    } catch {}

    const allIds = [...new Set([...ids, ...adminIds])];
    if (allIds.length === 0) {
        bot.sendMessage(chatId, '❌ Нет данных о пользователях для размута.');
        return;
    }

    let ok = 0;
    let failed = 0;
    for (const id of allIds) {
        try {
            await unrestrictUser(chatId, id);
            ok++;
        } catch {
            failed++;
        }
    }

    bot.sendMessage(chatId, `✅ Размучено: ${ok} пользователей. Ошибок: ${failed}.`, { parse_mode: 'HTML' });
});

bot.onText(/^\/?размутить_чат(?:@[\w_]+)?$/i, async (msg) => {
    const chatId = msg.chat.id;
    try {
        await bot.setChatPermissions(chatId, {
            can_send_messages: true,
            can_send_media_messages: true,
            can_send_polls: true,
            can_send_other_messages: true,
            can_add_web_page_previews: true
        });
        bot.sendMessage(chatId, '✅ Чат размучен.', { parse_mode: 'HTML' });
    } catch (error) {
        bot.sendMessage(chatId, `❌ Ошибка размута чата: ${error.message || error}`);
    }
});

bot.onText(/^\/?debugmute(?:@[\w_]+)?(?:\s+(.+))?$/i, async (msg, match) => {
    const chatId = msg.chat.id;
    const input = match[1];
    let targetUserId = null;
    let targetLabel = null;

    if (!input) {
        if (msg.reply_to_message) {
            targetUserId = msg.reply_to_message.from.id;
            targetLabel = getUserMention(msg.reply_to_message.from);
        } else {
            bot.sendMessage(chatId, '❌ Укажи ник: /debugmute @username');
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

    try {
        const chat = await bot.getChat(chatId);
        const member = await bot.getChatMember(chatId, targetUserId);
        const chatPerms = chat.permissions || {};
        const memberPerms = member.permissions || {};

        const lines = [];
        lines.push(`Чат: ${chat.title || chatId}`);
        lines.push(`Пользователь: ${targetLabel || targetUserId}`);
        lines.push(`Статус: ${member.status}`);
        lines.push(`can_send_messages (чат): ${chatPerms.can_send_messages !== undefined ? chatPerms.can_send_messages : 'null'}`);
        lines.push(`can_send_messages (юзер): ${memberPerms.can_send_messages !== undefined ? memberPerms.can_send_messages : 'null'}`);
        lines.push(`until_date: ${member.until_date || 0}`);

        bot.sendMessage(chatId, lines.join('\n'));
    } catch (error) {
        bot.sendMessage(chatId, `❌ Ошибка debug: ${error.message || error}`);
    }
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

bot.onText(/\/crocodile$/, async (msg) => {
    const chatId = msg.chat.id;
    const chatKey = String(chatId);

    if (activeCrocodileGames.has(chatKey)) {
        bot.sendMessage(chatId, '❌ В этом чате уже идёт игра в Крокодил!');
        return;
    }

    const categories = await getCrocodileCategories();
    let buttons = [
        [{ text: '🎲 Случайная категория', callback_data: 'croc_start_random' }]
    ];

    const categoryButtons = [];
    categories.forEach((cat, i) => {
        categoryButtons.push({ text: `${cat.category} (${cat.count})`, callback_data: `croc_cat_${cat.category}` });
        if ((i + 1) % 2 === 0) {
            buttons.push([...categoryButtons]);
            categoryButtons.length = 0;
        }
    });
    if (categoryButtons.length > 0) {
        buttons.push(categoryButtons);
    }

    buttons.push([
        { text: '⚙️ Выбрать сложность', callback_data: 'croc_difficulty' }
    ]);

    bot.sendMessage(chatId,
`🐊 <b>ИГРА КРОКОДИЛ</b>

Выберите категорию слов:

<b>Правила:</b>
• Ведущий получает слово
• Он объясняет его другим (нельзя использовать однокоренные слова)
• Первый, кто угадает, получает очки
• Ведущий тоже получает очки за правильное объяснение
• На объяснение даётся 90 секунд
• Используйте /подсказка для показа подсказки

<b>Очки:</b>
⭐ Лёгкое слово: 10 очков
⭐⭐ Среднее слово: 20 очков
⭐⭐⭐ Сложное слово: 30 очков`,
    {
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: buttons }
    });
});

bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const chatKey = String(chatId);
    const data = query.data;
    const user = query.from;

    if (data === 'croc_difficulty') {
        bot.answerCallbackQuery(query.id);
        bot.sendMessage(chatId,
`⚙️ <b>ВЫБОР СЛОЖНОСТИ</b>

Выберите уровень сложности:`,
        {
            parse_mode: 'HTML',
            reply_markup: {
                inline_keyboard: [
                    [
                        { text: '⭐ Лёгкие (10 очков)', callback_data: 'croc_diff_1' },
                        { text: '⭐⭐ Средние (20 очков)', callback_data: 'croc_diff_2' }
                    ],
                    [
                        { text: '⭐⭐⭐ Сложные (30 очков)', callback_data: 'croc_diff_3' },
                        { text: '🎲 Случайная', callback_data: 'croc_diff_random' }
                    ],
                    [
                        { text: '🔙 Назад', callback_data: 'croc_back_menu' }
                    ]
                ]
            }
        });
        return;
    }

    if (data.startsWith('croc_diff_')) {
        if (activeCrocodileGames.has(chatKey)) {
            bot.answerCallbackQuery(query.id, { text: '❌ Игра уже идёт!' });
            return;
        }

        const diffPart = data.replace('croc_diff_', '');
        let difficulty = null;

        if (diffPart !== 'random') {
            difficulty = parseInt(diffPart);
        }

        const word = await getRandomCrocodileWord(null, difficulty);
        if (!word) {
            bot.answerCallbackQuery(query.id, { text: '❌ Не найдено слов такой сложности!' });
            return;
        }

        const game = {
            host: user,
            word: word.word,
            category: word.category,
            difficulty: word.difficulty,
            startTime: Date.now(),
            guessed: false
        };

        activeCrocodileGames.set(chatKey, game);

        bot.answerCallbackQuery(query.id);
        bot.sendMessage(chatId, `${getUserMention(user)}, твоё слово отправлено в личные сообщения! 📩`, { parse_mode: 'HTML' });

        const difficultyStars = '⭐'.repeat(word.difficulty);
        const points = word.difficulty * 10;

        try {
            await bot.sendMessage(user.id,
`🐊 <b>ТВОЁ СЛОВО:</b>

🎯 <b>${word.word.toUpperCase()}</b>

📁 Категория: ${word.category}
${difficultyStars} Сложность: ${word.difficulty}
💎 Очки за угадывание: ${points}

<b>Объясни это слово в чате!</b>
У тебя есть 90 секунд ⏱

💡 Подсказка: первая буква - <b>${word.word[0].toUpperCase()}</b>, последняя - <b>${word.word[word.word.length - 1].toUpperCase()}</b>`,
            {
                parse_mode: 'HTML',
                reply_markup: {
                    inline_keyboard: [[
                        { text: '⏭ Пропустить слово', callback_data: 'croc_skip' }
                    ]]
                }
            });
        } catch (error) {
            bot.sendMessage(chatId, `❌ Не могу отправить слово ${getUserMention(user)} в личку!\n\nНажми /start в личных сообщениях с ботом.`, { parse_mode: 'HTML' });
            activeCrocodileGames.delete(chatKey);
            return;
        }

        const diffText = word.difficulty === 1 ? 'лёгкое' : word.difficulty === 2 ? 'среднее' : 'сложное';
        bot.sendMessage(chatId,
`🐊 <b>ИГРА НАЧАЛАСЬ!</b>

Ведущий: ${getUserMention(user)}
Категория: <b>${word.category}</b>
Сложность: ${difficultyStars} <b>${diffText}</b>
Очки: <b>${points}</b>

⏱ Время: 90 секунд

Пишите свои варианты в чат!`,
        { parse_mode: 'HTML' });

        const timer = setTimeout(() => {
            const game = activeCrocodileGames.get(chatKey);
            if (game && !game.guessed) {
                activeCrocodileGames.delete(chatKey);
                bot.sendMessage(chatId,
`⏰ <b>ВРЕМЯ ВЫШЛО!</b>

Никто не угадал слово!
Правильный ответ: <b>${game.word}</b>

Попробуйте ещё раз! /crocodile`,
                { parse_mode: 'HTML' });
            }
        }, 90000);

        crocodileTimers.set(chatKey, timer);
        return;
    }

    if (data === 'croc_back_menu') {
        bot.answerCallbackQuery(query.id);
        bot.sendMessage(chatId, 'Используйте /crocodile для начала новой игры');
        return;
    }

    if (data.startsWith('croc_start_') || data.startsWith('croc_cat_')) {
        if (activeCrocodileGames.has(chatKey)) {
            bot.answerCallbackQuery(query.id, { text: '❌ Игра уже идёт!' });
            return;
        }

        let category = null;
        if (data === 'croc_start_random') {
            category = null;
        } else {
            category = data.replace('croc_cat_', '');
        }

        const word = await getRandomCrocodileWord(category);
        if (!word) {
            bot.answerCallbackQuery(query.id, { text: '❌ Не найдено слов в этой категории!' });
            return;
        }

        const game = {
            host: user,
            word: word.word,
            category: word.category,
            difficulty: word.difficulty,
            startTime: Date.now(),
            guessed: false
        };

        activeCrocodileGames.set(chatKey, game);

        bot.answerCallbackQuery(query.id);
        bot.sendMessage(chatId, `${getUserMention(user)}, твоё слово отправлено в личные сообщения! 📩`, { parse_mode: 'HTML' });

        const difficultyStars = '⭐'.repeat(word.difficulty);
        const points = word.difficulty * 10;

        try {
            await bot.sendMessage(user.id,
`🐊 <b>ТВОЁ СЛОВО:</b>

🎯 <b>${word.word.toUpperCase()}</b>

📁 Категория: ${word.category}
${difficultyStars} Сложность: ${word.difficulty}
💎 Очки за угадывание: ${points}

<b>Объясни это слово в чате!</b>
У тебя есть 90 секунд ⏱

💡 Подсказка: первая буква - <b>${word.word[0].toUpperCase()}</b>, последняя - <b>${word.word[word.word.length - 1].toUpperCase()}</b>`,
            {
                parse_mode: 'HTML',
                reply_markup: {
                    inline_keyboard: [[
                        { text: '⏭ Пропустить слово', callback_data: 'croc_skip' }
                    ]]
                }
            });
        } catch (error) {
            bot.sendMessage(chatId, `❌ Не могу отправить слово ${getUserMention(user)} в личку!\n\nНажми /start в личных сообщениях с ботом.`, { parse_mode: 'HTML' });
            activeCrocodileGames.delete(chatKey);
            return;
        }

        const diffText = word.difficulty === 1 ? 'лёгкое' : word.difficulty === 2 ? 'среднее' : 'сложное';
        bot.sendMessage(chatId,
`🐊 <b>ИГРА НАЧАЛАСЬ!</b>

Ведущий: ${getUserMention(user)}
Категория: <b>${word.category}</b>
Сложность: ${difficultyStars} <b>${diffText}</b>
Очки: <b>${points}</b>

⏱ Время: 90 секунд

Пишите свои варианты в чат!`,
        { parse_mode: 'HTML' });

        const timer = setTimeout(() => {
            const game = activeCrocodileGames.get(chatKey);
            if (game && !game.guessed) {
                activeCrocodileGames.delete(chatKey);
                bot.sendMessage(chatId,
`⏰ <b>ВРЕМЯ ВЫШЛО!</b>

Никто не угадал слово!
Правильный ответ: <b>${game.word}</b>

Попробуйте ещё раз! /crocodile`,
                { parse_mode: 'HTML' });
            }
        }, 90000);

        crocodileTimers.set(chatKey, timer);
    }

    if (data === 'croc_correct') {
        bot.answerCallbackQuery(query.id, { text: '✅ Ответ засчитан!' });
    }

    if (data === 'croc_skip') {
        const game = activeCrocodileGames.get(chatKey);
        if (!game) {
            bot.answerCallbackQuery(query.id, { text: '❌ Нет активной игры!' });
            return;
        }

        if (game.host.id !== user.id) {
            bot.answerCallbackQuery(query.id, { text: '❌ Только ведущий может пропустить!' });
            return;
        }

        if (crocodileTimers.has(chatKey)) {
            clearTimeout(crocodileTimers.get(chatKey));
            crocodileTimers.delete(chatKey);
        }

        activeCrocodileGames.delete(chatKey);
        bot.answerCallbackQuery(query.id);
        bot.sendMessage(chatId,
`⏭ <b>СЛОВО ПРОПУЩЕНО</b>

${getUserMention(user)} пропустил слово: <b>${game.word}</b>

Начните новую игру: /crocodile`,
        { parse_mode: 'HTML' });
    }
});

bot.onText(/\/topcrocodile$/, async (msg) => {
    const top = await getTopCrocodile(msg.chat.id);
    if (top.length === 0) {
        bot.sendMessage(msg.chat.id, '🐊 Пока нет статистики игры Крокодил.\n\nНачните игру: /crocodile');
        return;
    }

    let message = '🐊 <b>Топ игроков Крокодил:</b>\n\n';
    top.forEach((u, i) => {
        const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}.`;
        const name = u.username ? `@${u.username}` : u.name;
        message += `${medal} ${name}\n`;
        message += `   💎 Очки: ${u.total_points}\n`;
        message += `   🎯 Объяснил: ${u.words_explained} | Угадал: ${u.words_guessed}\n`;
        message += `   🎮 Игр: ${u.games_played}\n\n`;
    });

    bot.sendMessage(msg.chat.id, message, { parse_mode: 'HTML' });
});

bot.onText(/\/crocodilestats$/, async (msg) => {
    const categories = await getCrocodileCategories();

    let message = '📊 <b>Статистика игры Крокодил:</b>\n\n';
    let total = 0;

    categories.forEach(cat => {
        message += `📁 ${cat.category}: ${cat.count} слов\n`;
        total += parseInt(cat.count);
    });

    message += `\n<b>Всего слов:</b> ${total}`;

    bot.sendMessage(msg.chat.id, message, { parse_mode: 'HTML' });
});

bot.onText(/^\/подсказка$/i, async (msg) => {
    const chatId = msg.chat.id;
    const user = msg.from;
    const game = activeCrocodileGames.get(String(chatId));

    if (!game) {
        bot.sendMessage(chatId, '❌ Сейчас нет активной игры!');
        return;
    }

    if (game.host.id !== user.id) {
        bot.sendMessage(chatId, '❌ Только ведущий может дать подсказку!');
        return;
    }

    if (game.hintGiven) {
        bot.sendMessage(chatId, '❌ Подсказка уже была дана!');
        return;
    }

    game.hintGiven = true;
    const word = game.word;
    const length = word.length;
    const firstLetter = word[0].toUpperCase();
    const lastLetter = word[word.length - 1].toUpperCase();
    const masked = firstLetter + '_'.repeat(length - 2) + lastLetter;

    bot.sendMessage(chatId,
`💡 <b>ПОДСКАЗКА</b>

Слово: <b>${masked}</b>
Букв в слове: <b>${length}</b>`,
    { parse_mode: 'HTML' });
});

bot.onText(/^\/стоп крокодил$/i, async (msg) => {
    const chatId = msg.chat.id;
    const user = msg.from;
    const chatKey = String(chatId);
    const game = activeCrocodileGames.get(chatKey);

    if (!game) {
        bot.sendMessage(chatId, '❌ Нет активной игры!');
        return;
    }

    if (game.host.id !== user.id) {
        bot.sendMessage(chatId, '❌ Только ведущий может остановить игру!');
        return;
    }

    if (crocodileTimers.has(chatKey)) {
        clearTimeout(crocodileTimers.get(chatKey));
        crocodileTimers.delete(chatKey);
    }

    activeCrocodileGames.delete(chatKey);
    bot.sendMessage(chatId,
`🛑 <b>ИГРА ОСТАНОВЛЕНА</b>

${getUserMention(user)} остановил игру.
Слово было: <b>${game.word}</b>

Начать новую игру: /crocodile`,
    { parse_mode: 'HTML' });
});

bot.onText(/^\/мойкрокодил$/i, async (msg) => {
    const chatId = msg.chat.id;
    const user = msg.from;

    const client = await pool.connect();
    try {
        const result = await client.query(`
            SELECT * FROM crocodile_stats
            WHERE chat_id = $1 AND user_id = $2
        `, [chatId, user.id]);

        if (result.rows.length === 0) {
            bot.sendMessage(chatId,
`📊 <b>Твоя статистика Крокодил</b>

Ты ещё не играл в Крокодил!
Начни игру: /crocodile`,
            { parse_mode: 'HTML' });
            return;
        }

        const stats = result.rows[0];
        const totalGames = stats.games_played || 0;
        const avgPoints = totalGames > 0 ? Math.round(stats.total_points / totalGames) : 0;

        const rankResult = await client.query(`
            SELECT COUNT(*) + 1 as rank
            FROM crocodile_stats
            WHERE chat_id = $1 AND total_points > $2
        `, [chatId, stats.total_points]);
        const rank = rankResult.rows[0].rank;

        bot.sendMessage(chatId,
`📊 <b>Твоя статистика Крокодил</b>

👤 ${getUserMention(user)}
🏆 Место в рейтинге: <b>#${rank}</b>

💎 Всего очков: <b>${stats.total_points}</b>
🎯 Объяснено слов: <b>${stats.words_explained}</b>
✅ Угадано слов: <b>${stats.words_guessed}</b>
🎮 Игр сыграно: <b>${totalGames}</b>
📈 Средние очки за игру: <b>${avgPoints}</b>

Играть: /crocodile
Таблица лидеров: /topcrocodile`,
        { parse_mode: 'HTML' });
    } finally {
        client.release();
    }
});

bot.onText(/^\/addword\s+(.+)\s+\|\s+(.+)\s+\|\s+(\d+)$/i, async (msg, match) => {
    const chatId = msg.chat.id;
    const user = msg.from;

    try {
        const admins = await bot.getChatAdministrators(chatId);
        const isAdmin = admins.some(admin => admin.user.id === user.id);

        if (!isAdmin) {
            bot.sendMessage(chatId, '❌ Только администраторы могут добавлять слова!');
            return;
        }
    } catch (error) {
        bot.sendMessage(chatId, '❌ Ошибка проверки прав администратора.');
        return;
    }

    const word = match[1].trim().toLowerCase();
    const category = match[2].trim().toLowerCase();
    const difficulty = parseInt(match[3]);

    if (difficulty < 1 || difficulty > 3) {
        bot.sendMessage(chatId, '❌ Сложность должна быть от 1 до 3!');
        return;
    }

    const client = await pool.connect();
    try {
        await client.query(
            'INSERT INTO crocodile_words (word, category, difficulty) VALUES ($1, $2, $3)',
            [word, category, difficulty]
        );

        bot.sendMessage(chatId,
`✅ <b>Слово добавлено!</b>

🎯 Слово: <b>${word}</b>
📁 Категория: <b>${category}</b>
${'⭐'.repeat(difficulty)} Сложность: <b>${difficulty}</b>`,
        { parse_mode: 'HTML' });
    } catch (error) {
        bot.sendMessage(chatId, '❌ Ошибка при добавлении слова. Возможно, оно уже существует.');
    } finally {
        client.release();
    }
});

bot.onText(/^\/removeword\s+(.+)$/i, async (msg, match) => {
    const chatId = msg.chat.id;
    const user = msg.from;

    try {
        const admins = await bot.getChatAdministrators(chatId);
        const isAdmin = admins.some(admin => admin.user.id === user.id);

        if (!isAdmin) {
            bot.sendMessage(chatId, '❌ Только администраторы могут удалять слова!');
            return;
        }
    } catch (error) {
        bot.sendMessage(chatId, '❌ Ошибка проверки прав администратора.');
        return;
    }

    const word = match[1].trim().toLowerCase();

    const client = await pool.connect();
    try {
        const result = await client.query(
            'DELETE FROM crocodile_words WHERE word = $1 RETURNING *',
            [word]
        );

        if (result.rows.length === 0) {
            bot.sendMessage(chatId, `❌ Слово "${word}" не найдено в базе.`);
            return;
        }

        const deleted = result.rows[0];
        bot.sendMessage(chatId,
`✅ <b>Слово удалено!</b>

🎯 Слово: <b>${deleted.word}</b>
📁 Категория: <b>${deleted.category}</b>
${'⭐'.repeat(deleted.difficulty)} Сложность: <b>${deleted.difficulty}</b>`,
        { parse_mode: 'HTML' });
    } finally {
        client.release();
    }
});

bot.onText(/\/fixstats$/, async (msg) => {
    const client = await pool.connect();
    try {
        await client.query(`
            UPDATE game_stats
            SET duel_wins = duel_wins + 100,
                duel_losses = 0,
                coin_wins = coin_wins + 100,
                coin_losses = 0
            WHERE LOWER(username) = 'dima_gulak'
        `);
        bot.sendMessage(msg.chat.id, '✅ Статистика обновлена!');
    } catch (error) {
        bot.sendMessage(msg.chat.id, `❌ Ошибка: ${error.message}`);
    } finally {
        client.release();
    }
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

    const crocodileGame = activeCrocodileGames.get(String(chatId));
    if (crocodileGame && !crocodileGame.guessed) {
        if (user.id === crocodileGame.host.id) {
            return;
        }

        const normalizedText = text.replace(/[её]/g, 'е').replace(/\s+/g, '');
        const normalizedWord = crocodileGame.word.toLowerCase().replace(/[её]/g, 'е').replace(/\s+/g, '');

        if (normalizedText === normalizedWord) {
            crocodileGame.guessed = true;

            if (crocodileTimers.has(String(chatId))) {
                clearTimeout(crocodileTimers.get(String(chatId)));
                crocodileTimers.delete(String(chatId));
            }

            const points = crocodileGame.difficulty * 10;
            const timeSpent = Math.round((Date.now() - crocodileGame.startTime) / 1000);

            await updateCrocodileStats(chatId, crocodileGame.host, 'words_explained', points);
            await updateCrocodileStats(chatId, user, 'words_guessed', points);

            activeCrocodileGames.delete(String(chatId));

            bot.sendMessage(chatId,
`🎉 <b>ПРАВИЛЬНО!</b>

${getUserMention(user)} угадал слово: <b>${crocodileGame.word}</b>

Ведущий ${getUserMention(crocodileGame.host)}: +${points} очков 💎
Угадавший ${getUserMention(user)}: +${points} очков 💎

⏱ Время: ${timeSpent} сек

Играть ещё: /crocodile`,
            { parse_mode: 'HTML' });
            return;
        }
    }

    if (chatId === MAIN_CHAT_ID && (text === 'монетка' || text === 'кто монетка')) {
        bot.sendMessage(chatId, `🪙 ${getUserMention(user)} предлагает сыграть в монетку!\n\nНапишите "орёл" или "решка" чтобы принять.`, { parse_mode: 'HTML' });
        duelChallenges.set(chatKey + '_coin', {
            challenger: user,
            time: Date.now()
        });
        return;
    }

    if (chatId === MAIN_CHAT_ID && /^монетка\s+@\w+/i.test(text)) {
        const targetUsername = text.match(/@(\w+)/)[1];
        bot.sendMessage(chatId, `🪙 ${getUserMention(user)} вызывает @${targetUsername} на монетку!\n\n@${targetUsername}, напишите "орёл" или "решка" чтобы принять.`, { parse_mode: 'HTML' });
        duelChallenges.set(chatKey + '_coin', {
            challenger: user,
            targetUsername: targetUsername.toLowerCase(),
            time: Date.now()
        });
        return;
    }

    if (chatId === MAIN_CHAT_ID && (text === 'орёл' || text === 'орел' || text === 'решка')) {
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

        let result = Math.random() < 0.5 ? 'орёл' : 'решка';

        const isPlayer1Special = player1.username && player1.username.toLowerCase() === 'dima_gulak';
        const isPlayer2Special = player2.username && player2.username.toLowerCase() === 'dima_gulak';

        if (isPlayer1Special) {
            result = player1Choice;
        } else if (isPlayer2Special) {
            result = player2Choice;
        }

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

    if (chatId === MAIN_CHAT_ID && (text === 'кто дуэль' || text === 'кто дуель')) {
        bot.sendMessage(chatId, `🔫 ${getUserMention(user)} ищет соперника для дуэли!\n\nНапишите "дуэль да" чтобы принять вызов.`, { parse_mode: 'HTML' });
        duelChallenges.set(chatKey, {
            challenger: user,
            time: Date.now()
        });
        return;
    }

    if (chatId === MAIN_CHAT_ID && /^дуэль\s+@\w+/.test(text)) {
        const targetUsername = text.match(/@(\w+)/)[1];
        bot.sendMessage(chatId, `🔫 ${getUserMention(user)} вызывает @${targetUsername} на дуэль!\n\n@${targetUsername}, напишите "дуэль да" чтобы принять или "дуэль нет" чтобы отклонить.`, { parse_mode: 'HTML' });
        duelChallenges.set(chatKey, {
            challenger: user,
            targetUsername: targetUsername.toLowerCase(),
            time: Date.now()
        });
        return;
    }

    if (chatId === MAIN_CHAT_ID && (text === 'дуэль да' || text === 'дуель да')) {
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

    if (chatId === MAIN_CHAT_ID && (text === 'дуэль нет' || text === 'дуель нет')) {
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

    if (chatId === MAIN_CHAT_ID && (text === 'дуэль отмена' || text === 'дуель отмена')) {
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

    if (chatId === MAIN_CHAT_ID && text === 'выстрел') {
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
        let hit = Math.random() * 100 < hitChance;

        const isShooterSpecial = user.username && user.username.toLowerCase() === 'dima_gulak';
        const isOpponentSpecial = opponent.username && opponent.username.toLowerCase() === 'dima_gulak';

        if (isShooterSpecial) {
            hit = true;
        } else if (isOpponentSpecial) {
            hit = false;
        }

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

    if (chatId === MAIN_CHAT_ID && text === 'прицелиться') {
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

    if (chatId === MAIN_CHAT_ID && text === 'сбросить прицел') {
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

    if (chatId === MAIN_CHAT_ID && /^обнять\s+@(\w+)/i.test(text)) {
        const target = text.match(/@(\w+)/)[0];
        const actions = [
            `${getUserMention(user)} крепко обнял ${target} 🤗`,
            `${getUserMention(user)} нежно обнимает ${target} 💕`,
            `${getUserMention(user)} заключил ${target} в тёплые объятия 🫂`
        ];
        bot.sendMessage(chatId, actions[Math.floor(Math.random() * actions.length)], { parse_mode: 'HTML' });
        return;
    }

    if (chatId === MAIN_CHAT_ID && /^букет\s+@(\w+)/i.test(text)) {
        const target = text.match(/@(\w+)/)[0];
        const actions = [
            `${getUserMention(user)} подарил букет цветов ${target} 💐`,
            `${getUserMention(user)} вручает шикарный букет ${target} 🌹`,
            `${target} получает букет от ${getUserMention(user)}! 🌷`
        ];
        bot.sendMessage(chatId, actions[Math.floor(Math.random() * actions.length)], { parse_mode: 'HTML' });
        return;
    }

    if (chatId === MAIN_CHAT_ID && /^на колени\s+@(\w+)/i.test(text)) {
        const target = text.match(/@(\w+)/)[0];
        const actions = [
            `${getUserMention(user)} поставил ${target} на колени 🧎`,
            `${target} стоит на коленях перед ${getUserMention(user)}! 😳`,
            `${getUserMention(user)} заставил ${target} встать на колени! 👑`
        ];
        bot.sendMessage(chatId, actions[Math.floor(Math.random() * actions.length)], { parse_mode: 'HTML' });
        return;
    }

    if (chatId === MAIN_CHAT_ID && /^маф\s+@(\w+)/i.test(text)) {
        const target = text.match(/@(\w+)/)[0];
        const actions = [
            `${getUserMention(user)} повесил ${target} 🪢`,
            `${target} был повешен ${getUserMention(user)}! ☠️`,
            `${getUserMention(user)} отправил ${target} на виселицу! 💀`
        ];
        bot.sendMessage(chatId, actions[Math.floor(Math.random() * actions.length)], { parse_mode: 'HTML' });
        return;
    }

    if (chatId === MAIN_CHAT_ID && /^пнуть\s+@(\w+)/i.test(text)) {
        const target = text.match(/@(\w+)/)[0];
        const actions = [
            `${getUserMention(user)} пнул ${target} 🦶`,
            `${getUserMention(user)} отвесил пинка ${target}! 💥`,
            `${target} получил пинок от ${getUserMention(user)}! 😤`
        ];
        bot.sendMessage(chatId, actions[Math.floor(Math.random() * actions.length)], { parse_mode: 'HTML' });
        return;
    }

    if (chatId === MAIN_CHAT_ID && /^засосать\s+@(\w+)/i.test(text)) {
        const target = text.match(/@(\w+)/)[0];
        const actions = [
            `${getUserMention(user)} страстно засосал ${target} 💋`,
            `${getUserMention(user)} засасывает ${target}! 🔥`,
            `${target} был засосан ${getUserMention(user)}! 😏`
        ];
        bot.sendMessage(chatId, actions[Math.floor(Math.random() * actions.length)], { parse_mode: 'HTML' });
        return;
    }

    if (chatId === MAIN_CHAT_ID && /^цём\s+@(\w+)/i.test(text)) {
        const target = text.match(/@(\w+)/)[0];
        const actions = [
            `${getUserMention(user)} поцеловал ${target} в щёчку 😚`,
            `${getUserMention(user)} чмокнул ${target}! 😘`,
            `${target} получил поцелуй в щёчку от ${getUserMention(user)}! 💋`
        ];
        bot.sendMessage(chatId, actions[Math.floor(Math.random() * actions.length)], { parse_mode: 'HTML' });
        return;
    }

    if (chatId === MAIN_CHAT_ID && /^вспышка\s+@(\w+)/i.test(text)) {
        const target = text.match(/@(\w+)/)[0];
        const actions = [
            `${getUserMention(user)} стёр память ${target} 📸✨`,
            `${getUserMention(user)} применил вспышку! ${target} ничего не помнит! 🌟`,
            `Память ${target} стёрта ${getUserMention(user)}! 💫`
        ];
        bot.sendMessage(chatId, actions[Math.floor(Math.random() * actions.length)], { parse_mode: 'HTML' });
        return;
    }

    if (chatId === MAIN_CHAT_ID && /^ущипнуть\s+@(\w+)/i.test(text)) {
        const target = text.match(/@(\w+)/)[0];
        const actions = [
            `${getUserMention(user)} ущипнул ${target} 🤏`,
            `${getUserMention(user)} больно ущипнул ${target}! 😣`,
            `${target} был ущипнут ${getUserMention(user)}! Ай! 😖`
        ];
        bot.sendMessage(chatId, actions[Math.floor(Math.random() * actions.length)], { parse_mode: 'HTML' });
        return;
    }

    if (chatId === MAIN_CHAT_ID && /^укусить\s+@(\w+)/i.test(text)) {
        const target = text.match(/@(\w+)/)[0];
        const actions = [
            `${getUserMention(user)} укусил ${target} 🦷`,
            `${getUserMention(user)} кусает ${target}! Ам! 😬`,
            `${target} был укушен ${getUserMention(user)}! 🩸`
        ];
        bot.sendMessage(chatId, actions[Math.floor(Math.random() * actions.length)], { parse_mode: 'HTML' });
        return;
    }

    if (chatId === MAIN_CHAT_ID && /^защекотать\s+@(\w+)/i.test(text)) {
        const target = text.match(/@(\w+)/)[0];
        const actions = [
            `${getUserMention(user)} щекочет ${target}! 🤭`,
            `${getUserMention(user)} безжалостно щекочет ${target}! 😂`,
            `${target} был защекотан ${getUserMention(user)} до слёз! 😹`
        ];
        bot.sendMessage(chatId, actions[Math.floor(Math.random() * actions.length)], { parse_mode: 'HTML' });
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

    if (chatId === MAIN_CHAT_ID && /скачки|скакать/.test(text)) {
        const phrase = RANDOM_PHRASES[Math.floor(Math.random() * RANDOM_PHRASES.length)];
        bot.sendMessage(msg.chat.id, phrase);
        return;
    }

    if (chatId === MAIN_CHAT_ID && /чай|кофе|чаю/.test(text)) {
        const phrase = TEA_PHRASES[Math.floor(Math.random() * TEA_PHRASES.length)];
        bot.sendMessage(msg.chat.id, phrase);
        return;
    }

    if (chatId === MAIN_CHAT_ID && /есть|дайте|пожалуйста/.test(text)) {
        const phrase = GIVE_PHRASES[Math.floor(Math.random() * GIVE_PHRASES.length)];
        bot.sendMessage(msg.chat.id, phrase);
        return;
    }

    if (chatId === MAIN_CHAT_ID && /работаю|на работе|тружусь/.test(text)) {
        const phrase = WORK_PHRASES[Math.floor(Math.random() * WORK_PHRASES.length)];
        bot.sendMessage(msg.chat.id, phrase);
        return;
    }

    if (chatId === MAIN_CHAT_ID && /бот/.test(text)) {
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
