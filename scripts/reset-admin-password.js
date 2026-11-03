const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');

function readHidden(prompt) {
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY || !process.stdin.setRawMode) return reject(new Error('Run this script with docker compose exec -it so the password prompt can hide input.'));
    process.stdout.write(prompt);
    let value = '';
    const finish = (err) => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.removeListener('data', onData);
      process.stdout.write('\n');
      err ? reject(err) : resolve(value);
    };
    const onData = (chunk) => {
      for (const char of chunk.toString('utf8')) {
        if (char === '\u0003') return finish(new Error('Cancelled.'));
        if (char === '\r' || char === '\n') return finish();
        if (char === '\u007f' || char === '\b') value = value.slice(0, -1);
        else if (char >= ' ') value += char;
      }
    };
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', onData);
  });
}

(async () => {
  const username = process.argv[2];
  if (!username) throw new Error('Usage: node scripts/reset-admin-password.js <admin-username>');
  const password = await readHidden('New admin password (minimum 8 characters): ');
  if (password.length < 8) throw new Error('Password must be at least 8 characters.');
  const db = await mysql.createConnection({
    host: process.env.DB_HOST || 'db', port: Number(process.env.DB_PORT || 3306),
    database: process.env.DB_NAME || 'fishpos', user: process.env.DB_USER || 'fishpos',
    password: process.env.DB_PASSWORD,
  });
  try {
    const hash = await bcrypt.hash(password, 12);
    const [result] = await db.execute('UPDATE users SET password_hash=? WHERE username=? AND role=\'admin\'', [hash, username]);
    if (!result.affectedRows) throw new Error(`No admin account found with username "${username}".`);
    console.log(`Password updated for admin account "${username}".`);
  } finally {
    await db.end();
  }
})().catch((error) => { console.error(error.message); process.exitCode = 1; });
