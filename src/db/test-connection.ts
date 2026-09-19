import { poolConnection } from './db.ts';

try {
  const [result] = await poolConnection.query(
    'SELECT SCHEMA_NAME FROM INFORMATION_SCHEMA.SCHEMATA WHERE SCHEMA_NAME = ?',
    ['trendfinder']
  );
  console.log(result.length ? '✅ Database exists' : '❌ Database not found');
} catch (e) {
  console.error('数据库连接错误详情:', {
  message: e.message,
  stack: e.stack,
  sql: 'SELECT SCHEMA_NAME FROM INFORMATION_SCHEMA.SCHEMATA WHERE SCHEMA_NAME = ?',
  config: connection.config
});
} finally {
  await poolConnection.end();
}