const XLSX = require('xlsx');
const pool = require('../config/db');

async function generateDailyPull(req, res) {
  const date = req.query.date;
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'date query param required (YYYY-MM-DD)' });
  }

  const result = await pool.query(
    `SELECT
       p.description  AS product_name,
       c.company_name,
       SUM(oi.quantity) AS qty,
       oi.unit
     FROM orders o
     JOIN order_items oi ON oi.order_id = o.id
     JOIN products    p  ON p.id = oi.product_id
     JOIN customers   c  ON c.id = o.customer_id
     WHERE o.delivery_date = $1
     GROUP BY p.description, c.company_name, oi.unit
     ORDER BY p.description, c.company_name`,
    [date]
  );

  // Group by product
  const byProduct = {};
  for (const row of result.rows) {
    if (!byProduct[row.product_name]) byProduct[row.product_name] = [];
    byProduct[row.product_name].push(row);
  }

  const aoa = [];
  const displayDate = new Date(date + 'T00:00:00').toLocaleDateString('en-US', {
    month: 'numeric', day: 'numeric', year: 'numeric',
  });

  aoa.push(['Date', displayDate]);
  aoa.push([]);
  aoa.push(['Product name', '', 'Qty', 'Unit']);
  aoa.push([]);

  const totalRowIndices = [];

  for (const [productName, rows] of Object.entries(byProduct)) {
    aoa.push([productName]);
    for (const row of rows) {
      aoa.push([row.company_name, '', parseFloat(row.qty), row.unit]);
    }
    const totalQty = rows.reduce((sum, r) => sum + parseFloat(r.qty), 0);
    totalRowIndices.push(aoa.length);
    aoa.push(['total =', '', totalQty, rows[0].unit]);
    aoa.push([]);
  }

  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!cols'] = [{ wch: 28 }, { wch: 4 }, { wch: 10 }, { wch: 8 }];

  // Bold + gray fill on total rows
  for (const rowIdx of totalRowIndices) {
    for (const col of [0, 2, 3]) {
      const ref = XLSX.utils.encode_cell({ r: rowIdx, c: col });
      if (ws[ref]) ws[ref].s = { fill: { fgColor: { rgb: 'D9D9D9' } }, font: { bold: true } };
    }
  }
  // Bold column headers
  for (const col of [0, 2, 3]) {
    const ref = XLSX.utils.encode_cell({ r: 2, c: col });
    if (ws[ref]) ws[ref].s = { font: { bold: true } };
  }

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Daily Pull');

  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Disposition', `attachment; filename="daily-pull-${date}.xlsx"`);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
}

module.exports = { generateDailyPull };
