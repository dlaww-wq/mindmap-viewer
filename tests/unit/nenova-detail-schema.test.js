'use strict';

const queries = [];
jest.mock('mssql', () => ({
  Int: 'Int',
  ConnectionPool: class {
    constructor() { this.connected = true; }
    async connect() { return this; }
    on() {}
    request() {
      return {
        input() { return this; },
        async query(sql) {
          queries.push(sql);
          if (/FROM OrderHistory/.test(sql)) {
            expect(sql).toMatch(/od\.OrderDetailKey = oh\.OrderDetailKey/);
            expect(sql).toMatch(/od\.OrderMasterKey = @key/);
            expect(sql).toMatch(/ORDER BY oh\.ChangeDtm DESC, oh\.OrderHistoryKey DESC/);
            return { recordset: [{ OrderHistoryKey: 1, OrderDetailKey: 7 }] };
          }
          if (/FROM ProductSort/.test(sql)) {
            expect(sql).toMatch(/p\.CounName = ps\.CounName AND p\.FlowerName = ps\.FlowerName/);
            expect(sql).toMatch(/WHERE p\.ProdKey = @prodKey/);
            return { recordset: [{ GroupName: 'flowers' }] };
          }
          return { recordset: [{ ProdKey: 230, OrderMasterKey: 6243, SteamQuantity: 50 }] };
        },
      };
    }
  },
}));

beforeAll(() => { process.env.NENOVA_DB_PASSWORD = 'test-only'; });
afterAll(() => { delete process.env.NENOVA_DB_PASSWORD; });

test.each(['/orders/:key', '/products/:key'])('%s uses the real read-only schema', async path => {
  queries.length = 0;
  const router = require('../../routes/nenova-db')({ getDb: () => null });
  const route = router.stack.find(layer => layer.route?.path === path).route;
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
  await route.stack[0].handle({ params: { key: path.startsWith('/orders') ? '6243' : '230' } }, res);
  expect(res.status).not.toHaveBeenCalled();
  expect(res.json.mock.calls[0][0].ok).toBe(true);
  expect(queries.every(sql => sql.trim().startsWith('SELECT'))).toBe(true);
  if (path.startsWith('/orders')) {
    expect(res.json.mock.calls[0][0].order.history[0].OrderDetailKey).toBe(7);
  } else {
    expect(res.json.mock.calls[0][0].sort.GroupName).toBe('flowers');
  }
});
