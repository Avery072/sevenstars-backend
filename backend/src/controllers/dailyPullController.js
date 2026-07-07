const PDFDocument = require('pdfkit');
const pool = require('../config/db');

const SQL = `SELECT
  p.id AS product_id,
  p.sku,
  p.description,
  c.company_name,
  SUM(oi.quantity)::float AS qty,
  oi.unit,
  p.price AS unit_price
FROM orders o
JOIN order_items oi ON oi.order_id = o.id
JOIN products p ON p.id = oi.product_id
JOIN customers c ON c.id = o.customer_id
WHERE o.delivery_date = $1
GROUP BY p.id, p.sku, p.description, c.company_name, oi.unit, p.price
ORDER BY p.description ASC, c.company_name ASC`;

function currentISODate() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function isValidISODate(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) return false;

  const parsed = new Date(`${date}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) return false;

  return date === [
    parsed.getFullYear(),
    String(parsed.getMonth() + 1).padStart(2, '0'),
    String(parsed.getDate()).padStart(2, '0'),
  ].join('-');
}

function reportDate(date) {
  return new Date(`${date}T00:00:00`);
}

function shortDate(date) {
  return reportDate(date).toLocaleDateString('en-US', {
    month: '2-digit',
    day: '2-digit',
    year: '2-digit',
  });
}

function longDate(date) {
  return reportDate(date).toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });
}

function currentTime() {
  return new Date().toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}

function money(value) {
  return `$${Number(value || 0).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function unitDisplay(unit) {
  return { each: 'ea', lb: 'lb', kg: 'kg' }[unit] || unit || '';
}

function drawPageHeader(doc, date) {
  doc.font('Helvetica').fontSize(9).fillColor('gray');
  doc.text(currentTime(), 40, 40);
  doc.text(shortDate(date), 40, 40, { width: 532, align: 'right' });
  doc.text('Accrual Basis', 40, 55);

  doc.font('Helvetica-Bold').fontSize(11).fillColor('black');
  doc.text('Seven Star Food LLC', 40, 74, { width: 532, align: 'center' });
  doc.text('Sales by Customer Detail', 40, 90, { width: 532, align: 'center' });
  doc.text(longDate(date), 40, 106, { width: 532, align: 'center' });
}

function drawColumnHeader(doc, y) {
  doc.moveTo(40, y - 5).lineTo(572, y - 5).strokeColor('black').lineWidth(0.5).stroke();
  doc.font('Helvetica-Bold').fontSize(9).fillColor('black');
  doc.text('Name', 40, y);
  doc.text('Item', 200, y);
  doc.text('Qty', 380, y, { width: 50, align: 'right' });
  doc.text('U/M', 470, y);
  doc.moveTo(40, y + 13).lineTo(572, y + 13).strokeColor('black').lineWidth(0.5).stroke();
  return y + 22;
}

function addContentPage(doc, date) {
  doc.addPage();
  drawPageHeader(doc, date);
  return drawColumnHeader(doc, 132);
}

function ensureSpace(doc, date, y, needed) {
  if (y + needed <= 720) return y;
  return addContentPage(doc, date);
}

async function generateDailyPull(req, res) {
  const requestedDate = req.query.date;
  const date = isValidISODate(requestedDate) ? requestedDate : currentISODate();

  const result = await pool.query(SQL, [date]);

  const byProduct = new Map();
  for (const row of result.rows) {
    if (!byProduct.has(row.product_id)) {
      byProduct.set(row.product_id, {
        sku: row.sku,
        description: row.description,
        unit: row.unit,
        unit_price: Number(row.unit_price || 0),
        rows: [],
      });
    }

    byProduct.get(row.product_id).rows.push({
      company_name: row.company_name,
      qty: Number(row.qty || 0),
    });
  }

  const grandTotal = result.rows.reduce(
    (sum, row) => sum + Number(row.qty || 0) * Number(row.unit_price || 0),
    0
  );

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="sales-by-customer-${date}.pdf"`);

  const doc = new PDFDocument({
    size: 'LETTER',
    margins: { top: 40, bottom: 40, left: 40, right: 40 },
    bufferPages: true,
    autoFirstPage: false,
  });

  doc.pipe(res);

  let y = addContentPage(doc, date);
  const rowHeight = 14;

  for (const product of byProduct.values()) {
    y = ensureSpace(doc, date, y, product.rows.length * rowHeight + 24);
    const item = `${product.sku || ''} (${product.description || ''})`;
    const unit = unitDisplay(product.unit);
    let subtotal = 0;

    for (const row of product.rows) {
      y = ensureSpace(doc, date, y, rowHeight);
      subtotal += row.qty;

      doc.font('Helvetica').fontSize(9).fillColor('black');
      doc.text(row.company_name || '', 40, y, { width: 150 });
      doc.text(item, 200, y, { width: 215 });
      doc.text(String(row.qty), 380, y, { width: 50, align: 'right' });
      doc.text(unit, 470, y, { width: 60 });
      y += rowHeight;
    }

    y = ensureSpace(doc, date, y, rowHeight);
    doc.font('Helvetica-Bold').fontSize(9).fillColor('black');
    doc.text(String(subtotal), 380, y, { width: 50, align: 'right' });
    y += rowHeight + 8;
  }

  y = ensureSpace(doc, date, y, 28);
  doc.moveTo(40, y).lineTo(572, y).strokeColor('black').lineWidth(0.5).stroke();
  y += 8;
  doc.font('Helvetica-Bold').fontSize(10).fillColor('black');
  doc.text(money(grandTotal), 350, y, { width: 120, align: 'right' });

  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i += 1) {
    doc.switchToPage(i);
    doc.font('Helvetica').fontSize(9).fillColor('black');
    doc.text(`Page ${i + 1} of ${range.count}`, 40, 742, { width: 532, align: 'center' });
  }

  doc.end();
}

module.exports = { generateDailyPull };
