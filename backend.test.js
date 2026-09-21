const { makeEnv, ok, eq, done } = require('./harness');
const env = makeEnv({ sheet1: true });
const sheets = env.sheets, call = env.call;
Object.defineProperty(global, 'fakeNow', { set: v => env.setNow(v.toISOString()), get: () => env.clock.now, configurable: true });
// ---------- tests ----------
let r = call('getAppData');
ok(r.ok, 'getAppData ok'); eq(Object.keys(sheets).sort(), ['Expenses','Products','Sales','Savings','Settings'], 'only 5 sheets (Sheet1 removed)');
eq(r.data.settings.shopName, 'আমার দোকান', 'default shop name'); eq(r.data.dashboard.openingSet, false, 'opening not set');

// import
call('importExcelProducts');
r = call('getProducts'); eq(r.data.length, 42, '42 imported'); eq(r.data[0].id, 'PRD-000001', 'first id'); 
try { call('importExcelProducts'); ok(false,'second import should throw'); } catch(e){ ok(true,'second import blocked'); }

// create product
r = call('createProduct', { name: '=HYPERLINK("x")', category: 'ঘড়ি', purchase: '100', cost: '10', price: '150', stock: '10', low: '3', barcode: '8901', image: { data: Buffer.from('abc').toString('base64'), mime: 'image/jpeg' } });
ok(r.ok, 'createProduct ok ' + JSON.stringify(r)); eq(r.data.id, 'PRD-000043', 'next id after 42'); ok(r.data.imageId.startsWith('L'), 'image saved to drive');
eq(sheets.Products[43][1], '=HYPERLINK("x")', 'formula-safe name written (stored as text, not evaluated)');
r = call('createProduct', { name: 'Dup', purchase: 1, price: 2, stock: 1, barcode: '8901' }); eq(r.ok, false, 'dup barcode rejected');
r = call('createProduct', { name: '', purchase: 1, price: 2, stock: 1 }); eq(r.error, 'প্রোডাক্টের নাম দিন', 'name required');
r = call('createProduct', { name: 'X', purchase: 1, price: 2, stock: -1 }); eq(r.ok, false, 'negative stock rejected');
r = call('createProduct', { name: 'X', purchase: 1, price: 2, stock: 1.5 }); eq(r.ok, false, 'fractional stock rejected');

// Opening balance
r = call('saveSettings', { openingBalance: 1000, openingDate: '2026-09-18' }); ok(r.ok, 'opening set'); eq(r.data.openingBalance, 1000, 'opening = 1000');
r = call('saveSettings', { shopName: 'রিপন ঘড়ি ঘর', shopAddress: 'ঢাকা', logo: { data: 'aGk=', mime: 'image/png' } }); ok(r.ok && r.data.logoId.startsWith('L'), 'shop settings + logo');
eq(r.data.openingBalance, 1000, 'opening kept when saving shop info');

// yesterday's data (backdated): expense 100 yesterday
call('createExpense', { date: '2026-09-18', category: 'নাস্তা', amount: 100 });
// Product PRD-000001: Toy বেবি ঘড়ি stock 48 purchase 27 price 35
let sale = call('createSale', { token: 't1', items: [{ id: 'PRD-000001', qty: 2, disc: 5, dtype: 'amount' }, { id: 'PRD-000043', qty: 3, disc: 10, dtype: 'percent' }] });
ok(sale.ok, 'createSale ok ' + JSON.stringify(sale));
// line1: price35 disc5 net30 total60 cost 54 profit6 ; line2: price150 10% =15 net135 total405 cost (100+10)*3=330 profit 75
eq(sale.data.total, 465, 'sale total 465'); eq(sale.data.stock, { 'PRD-000001': 46, 'PRD-000043': 7 }, 'stock reduced');
eq(sale.data.saleId, 'SL-000001', 'sale id');
eq(sheets.Sales[1].slice(2), ['PRD-000001', 'Toy বেবি ঘড়ি', 2, 35, 5, 30, 60, 54, 6], 'sales row 1');
eq(sheets.Sales[2].slice(2), ['PRD-000043', '=HYPERLINK("x")', 3, 150, 15, 135, 405, 330, 75], 'sales row 2 (formula safe)');
// duplicate token
let dup = call('createSale', { token: 't1', items: [{ id: 'PRD-000001', qty: 2 }] });
ok(dup.ok && dup.data.duplicate === true && dup.data.saleId === 'SL-000001', 'duplicate token returns same sale');
eq(call('getProducts').data.find(p => p.id === 'PRD-000001').stock, 46, 'stock not reduced twice');
// insufficient
r = call('createSale', { token: 't2', items: [{ id: 'PRD-000043', qty: 8 }] }); ok(!r.ok && r.error.startsWith('পর্যাপ্ত স্টক নেই'), 'insufficient stock blocked: ' + r.error);
// same product twice aggregated
r = call('createSale', { token: 't3', items: [{ id: 'PRD-000043', qty: 5 }, { id: 'PRD-000043', qty: 3 }] }); ok(!r.ok, 'aggregate qty over stock blocked');
eq(sheets.Sales.length, 3, 'no rows added on failure');
// discount clamp
r = call('createSale', { token: 't4', items: [{ id: 'PRD-000001', qty: 1, disc: 999, dtype: 'amount' }] }); eq([r.data.total, r.data.items[0].discount], [0, 35], 'discount clamped to price');
r = call('createSale', { token: 't5', items: [{ id: 'PRD-000001', qty: 1, disc: 150, dtype: 'percent' }] }); eq(r.data.total, 0, 'percent clamped to 100');
r = call('createSale', { token: '', items: [{ id: 'PRD-000001', qty: 1 }] }); ok(!r.ok, 'token required');
r = call('createSale', { token: 't6', items: [{ id: 'PRD-999', qty: 1 }] }); ok(!r.ok, 'unknown product');
r = call('createSale', { token: 't7', items: [{ id: 'PRD-000001', qty: 0 }] }); ok(!r.ok, 'qty 0 rejected');
r = call('createSale', { token: 't8', items: [{ id: 'constructor', qty: 1 }] }); ok(!r.ok, 'prototype key safe');

// expense + saving today
call('createExpense', { category: 'ভাড়া', description: 'দোকান', amount: 65 });
call('createSaving', { amount: 200, note: 'জমা' });
r = call('getDashboardData').data;
// opening = 1000 + sales(<today, >=start)=0 - expense yesterday 100 = 900. today sales 465 + 0 + 0 = 465. expense 65. balance = 900+465-65 = 1300
eq([r.opening, r.salesToday, r.expenseToday, r.balance], [900, 465, 65, 1300], 'dashboard opening/sales/expense/balance');
// profit: sales profit 6+75=81 (+0 cost lines: t4 line cost 27 profit -27, t5 same) → product profit = 81 -27 -27 = 27; net = 27-65 = -38
eq([r.productProfitToday, r.profitToday], [27, -38], 'profit today');
eq([r.cash, r.savingsTotal], [1100, 200], 'cash = balance - savings');
eq([r.salesMonth, r.expenseMonth], [465, 165], 'month sales/expense');

// next day rollover
fakeNow = new Date('2026-09-20T10:00:00Z');
r = call('getDashboardData').data;
eq([r.opening, r.salesToday, r.balance], [1300, 0, 1300], 'next day opening = yesterday closing');

// cash book (fakeNow is back on 09-19)
fakeNow = new Date('2026-09-19T10:00:00Z');
r = call('getCashBook', 31); ok(r.ok, 'cashbook ok');
eq(r.data.rows.map(x => [x.date, x.opening, x.sales, x.expense, x.closing, x.savings, x.cash]), [['2026-09-19', 900, 465, 65, 1300, 200, 1100], ['2026-09-18', 1000, 0, 100, 900, 0, 900]], 'cash book rows');
eq(r.data.rows[0].cash, call('getDashboardData').data.cash, 'cash book today == dashboard cash');
// stock update
fakeNow = new Date('2026-09-19T10:00:00Z');
r = call('updateStock', 'PRD-000043', 5); eq(r.data.stock, 12, 'stock +5');
r = call('updateStock', 'PRD-000043', -20); ok(!r.ok && /পর্যাপ্ত স্টক নেই/.test(r.error), 'stock cannot go negative');
r = call('updateStock', 'PRD-000043', 0); ok(!r.ok, 'zero delta rejected');
// update product keeps stock & barcode uniqueness
r = call('updateProduct', { id: 'PRD-000043', name: 'নতুন নাম', purchase: 100, cost: 10, price: 160, low: 4, barcode: '8901', category: 'ঘড়ি' }); ok(r.ok && r.data.stock === 12 && r.data.price === 160, 'updateProduct keeps stock');
ok(r.data.imageId.startsWith('L'), 'image retained on update');
const oldImg = call('getProducts').data.find(p => p.id === 'PRD-000043').imageId;
r = call('updateProduct', { id: 'PRD-000043', name: 'নতুন নাম', purchase: 100, price: 160, image: { data: 'aGk=', mime: 'image/jpeg' } }); ok(r.ok && !env.store.files[oldImg] && env.store.files[r.data.imageId], 'old image trashed on replace, new one stored');

// reports
r = call('getReports', '2026-09-01', '2026-09-30').data;
eq([r.summary.sales, r.summary.expense], [465, 165], 'report summary sales/expense');
eq(r.summary.productProfit, 27, 'report product profit'); eq(r.summary.netProfit, 27 - 165, 'report net profit');
eq([r.top[0].id, r.top[0].qty], ['PRD-000001', 4], 'top product by qty'); eq(r.sales.length, 4, 'sales lines'); eq([r.todaySales, r.monthSales], [465, 465], 'today/month');
r = call('getReports', '2026-09-19', '2026-09-01').data; eq([r.from, r.to], ['2026-09-01', '2026-09-19'], 'swapped dates');
ok(!call('getReports', 'abc', '2026-01-01').ok, 'bad date rejected');
ok(!call('createExpense', { date: '2026-02-30', category: 'x', amount: 1 }).ok, 'invalid calendar date rejected');
ok(!call('createExpense', { category: 'x', amount: 0 }).ok, 'zero expense rejected');
ok(!call('createSaving', { amount: -5 }).ok, 'negative saving rejected');
r = call('getExpenses').data; eq([r.today, r.month, r.items.length], [65, 165, 2], 'expense list'); eq(r.items[0].category, 'ভাড়া', 'newest first');
r = call('getSavings').data; eq([r.today, r.total], [200, 200], 'savings list');
done('backend (Code.gs on gas-shim)');
