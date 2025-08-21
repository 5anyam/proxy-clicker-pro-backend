// excel.js example (आपको अपनी file के अनुसार adjust करना होगा)
import ExcelJS from 'exceljs';

export async function buildWorkbookBuffer(urls, options = {}) {
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet('Captured URLs');

  // Headers with proxy info
  const headers = [
    'Serial No.',
    'URL',
    'Source',
    'IP Address',
    'Proxy Server',
    'Proxy Username', 
    'Proxy Password',
    'Timestamp',
    'Date',
    'Time'
  ];

  worksheet.columns = headers.map(header => ({
    header,
    key: header.toLowerCase().replace(/[^a-z0-9]/g, '_'),
    width: header === 'URL' ? 50 : 
           header.includes('Proxy') ? 20 : 
           header === 'IP Address' ? 15 : 12
  }));

  // Add data rows
  urls.forEach((item, index) => {
    const timestamp = new Date(item.timestamp);
    worksheet.addRow({
      serial_no_: index + 1,
      url: item.url,
      source: item.source || 'unknown',
      ip_address: item.ip || 'N/A',
      proxy_server: item.proxy?.server || 'Direct',
      proxy_username: item.proxy?.username || 'N/A',
      proxy_password: item.proxy?.password || 'N/A',
      timestamp: timestamp.toLocaleString(),
      date: timestamp.toLocaleDateString(),
      time: timestamp.toLocaleTimeString()
    });
  });

  // Style the header row
  worksheet.getRow(1).font = { bold: true };
  worksheet.getRow(1).fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FFE6E6FA' }
  };

  const buffer = await workbook.xlsx.writeBuffer();
  return buffer;
}
