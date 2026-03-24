const mysql = require("mysql2/promise");

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  timezone: 'Z', // Railway MySQL is UTC; 'Z' tells mysql2 to use Date.UTC() — avoids double-offset with TZ=Asia/Manila
});

module.exports = pool;
