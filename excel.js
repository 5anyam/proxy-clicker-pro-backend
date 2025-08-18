import ExcelJS from 'exceljs';

export async function buildWorkbookBuffer(urls) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Captured URLs');

  sheet.columns = [
    { header: '#', key: 'idx', width: 6 },
    { header: 'URL', key: 'url', width: 80 },
    { header: 'Source', key: 'source', width: 16 },
    { header: 'Timestamp', key: 'timestamp', width: 28 },
  ];

  (urls || []).forEach((u, i) => {
    sheet.addRow({ idx: i + 1, url: u.url || u, source: u.source || 'detected', timestamp: u.timestamp || '' });
  });

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}
