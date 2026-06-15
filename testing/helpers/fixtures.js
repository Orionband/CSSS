const bcrypt = require('bcryptjs');
const { customAlphabet } = require('nanoid');

const nanoid = customAlphabet('ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789', 12);

function formatUniqueId() {
    return nanoid().match(/.{1,4}/g).join('-');
}

function seedUsers(db) {
    const studentHash = bcrypt.hashSync('student-pass-1', 4);
    const adminHash = bcrypt.hashSync('admin-pass-1', 4);
    const ownerHash = bcrypt.hashSync('owner-pass-1', 4);

    db.prepare('INSERT INTO users (username, email, password, unique_id, is_admin, is_owner) VALUES (?, ?, ?, ?, 0, 0)')
        .run('student', 'student@test.local', studentHash, formatUniqueId());
    db.prepare('INSERT INTO users (username, email, password, unique_id, is_admin, is_owner) VALUES (?, ?, ?, ?, 1, 0)')
        .run('admin', 'admin@test.local', adminHash, formatUniqueId());
    db.prepare('INSERT INTO users (username, email, password, unique_id, is_admin, is_owner) VALUES (?, ?, ?, ?, 1, 1)')
        .run('owner', 'owner@test.local', ownerHash, formatUniqueId());

    return {
        student: db.prepare('SELECT * FROM users WHERE username = ?').get('student'),
        admin: db.prepare('SELECT * FROM users WHERE username = ?').get('admin'),
        owner: db.prepare('SELECT * FROM users WHERE username = ?').get('owner'),
    };
}

const fixtureConfig = {
    labs: [{
        id: 'testlab',
        title: 'Test Lab',
        show_score: true,
        max_submissions: 5,
        time_limit_minutes: 60,
        max_upload_mb: 4,
        checks: [{
            message: 'hostname',
            points: 1,
            device: 'Router0',
            pass: [{ type: 'ConfigMatch', source: 'running', context: 'global', value: 'hostname test' }],
        }],
    }],
    quizzes: [{
        id: 'testquiz',
        title: 'Test Quiz',
        show_score: true,
        time_limit_minutes: 30,
        max_attempts: 3,
        questions: [{
            text: 'Pick A',
            type: 'radio',
            points: 1,
            answers: [
                { text: 'A', correct: true },
                { text: 'B', correct: false },
            ],
        }],
    }],
};

const closedLabConfig = {
    labs: [{
        id: 'closedlab',
        title: 'Closed Lab',
        comp_start: '2099-01-01T00:00:00Z',
        comp_end: '2099-12-31T00:00:00Z',
        checks: [],
    }],
    quizzes: [],
};

module.exports = { seedUsers, fixtureConfig, closedLabConfig, formatUniqueId };
