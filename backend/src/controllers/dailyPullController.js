const XLSX = require('xlsx');
const pool = require('../config/db');

async function generateDailyPull(req, res) {
  const date = req.query.date;
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'date query param required (YYYY-MM-DD)' });
  }

  // Aggregate qty per product per company for the given delivery date
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

  // Group rows by product name
  const byProduct = {};
  for (const row of result.rows) {
    if (!byProduct[row.product_name]) byProduct[row.product_name] = [];
    byProduct[row.product_name].push(row);
  }

  // Build worksheet data as array-of-arrays
  const aoa = [];

  // Header
  const displayDate = new Date(date + 'T00:00:00').toLocaleDateString('en-US', {
    month: 'numeric', day: 'numeric', year: 'numeric',
  });
  aoa.push(['Date', displayDate]);
  aoa.push([]);
  aoa.push(['Product name', '', 'Qty', 'Unit']);
  aoa.push([]);

  const totalRows = []; // track row indices of "total =" rows for styling

  for (const [productName, rows] of Object.entries(byProduct)) {
    // Product header row
    aoa.push([productName]);

    for (const row of rows) {
      aoa.push([row.company_name, '', parseFloat(row.qty), row.unit]);
    }

    // Total row
    const totalQty = rows.reduce((sum, r) => sum + parseFloat(r.qty), 0);
    const unit = rows[0].unit;
    totalRows.push(aoa.length); // 0-based index of the next row
    aoa.push(['total =', '', totalQty, unit]);

    aoa.push([]); // blank separator
  }

  const ws = XLSX.utils.aoa_to_sheet(aoa);

  // Column widths
  ws['!cols'] = [
    { wch: 28 }, // A
    { wch: 4  }, // B
    { wch: 10 }, // C
    { wch: 8  }, // D
  ];

  // Style total rows (gray fill) — requires xlsx-style or manual cell styling
  // xlsx community edition supports limited cell styles via cell.s when using write type 'buffer'
  for (const rowIdx of totalRows) {
    const cellRef = XLSX.utils.encode_cell({ r: rowIdx, c: 0 });
    const qtyRef  = XLSX.utils.encode_cell({ r: rowIdx, c: 2 });
    const unitRef = XLSX.utils.encode_cell({ r: rowIdx, c: 3 });
    for (const ref of [cellRef, qtyRef, unitRef]) {
      if (ws[ref]) {
        ws[ref].s = { fill: { fgColor: { rgb: 'D9D9D9' } }, font: { bold: true } };
      }
    }
  }

  // Style the column header row (row index 2)
  for (const col of [0, 2, 3]) {
    const ref = XLSX.utils.encode_cell({ r: 2, c: col });
    if (ws[ref]) ws[ref].s = { font: { bold: true } };
  }

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Daily Pull');

  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

  const filename = `daily-pull-${date}.xlsx`;
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
}

module.exports = { generateDailyPull };
