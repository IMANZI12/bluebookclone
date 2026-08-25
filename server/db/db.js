const { Pool } = require('pg');
require('dotenv').config(); // Loads your .env file

// Create a new connection pool using your .env credentials
const pool = new Pool({
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  database: process.env.DB_NAME,
});

// Export the pool so other files can use it
module.exports = pool;