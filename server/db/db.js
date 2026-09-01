const { Pool } = require('pg');
require('dotenv').config();


// Replace this with your Supabase connection string:
const connectionString = process.env.SUPABASE

const pool = new Pool({
  connectionString: connectionString,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

// Test the connection
pool.on('connect', () => {
  console.log('✓ Connected to Supabase PostgreSQL');
});

pool.on('error', (err) => {
  console.error('Unexpected error on idle client', err);
  process.exit(-1);
});

// Query helper function
const query = (text, params) => pool.query(text, params);

// Transaction helper
const getClient = () => pool.connect();

module.exports = pool;