const bcrypt = require('bcryptjs');
const { Client } = require('pg');

const client = new Client({ connectionString: 'postgresql://localhost:5432/seven_stars_food' });

async function seed() {
  const hash = bcrypt.hashSync('test123', 10);
  await client.connect();
  await client.query('DELETE FROM admin_users WHERE username = $1', ['admin']);
  await client.query('INSERT INTO admin_users (username, password_hash) VALUES ($1, $2)', ['admin', hash]);
  console.log('Admin user created. Login with username: admin, password: test123');
  await client.end();
}

seed().catch(console.error);
