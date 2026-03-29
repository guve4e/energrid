const path = require('path');
const dotenv = require('dotenv');

dotenv.config({
  path: path.resolve(__dirname, '../../../.env'),
  quiet: true,
});

function must(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing env: ${name}`);
    process.exit(1);
  }
  return value;
}

const host = must('PGHOST');
const port = must('PGPORT');
const database = must('PGDATABASE');
const user = must('PGUSER');
const password = must('PGPASSWORD');
const ssl = String(process.env.PGSSL || '').toLowerCase() === 'true';

const encodedUser = encodeURIComponent(user);
const encodedPassword = encodeURIComponent(password);

const url = `postgres://${encodedUser}:${encodedPassword}@${host}:${port}/${database}${ssl ? '?sslmode=require' : ''}`;

process.stdout.write(url);
