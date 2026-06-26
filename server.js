const express = require('express');
const cors = require('cors');
const multer = require('multer');
const csv = require('csv-parser');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

// Load environment variables
dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname)));

const UPLOADS_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR);
}

// Multer Config for CSV uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => cb(null, Date.now() + '_' + file.originalname)
});
const upload = multer({ storage });

// Multer config for Media uploads (memory storage, max 15MB)
const mediaUpload = multer({ 
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 } 
});

// Active Campaign State
let activeCampaign = {
  status: 'idle', // 'idle' | 'running' | 'stopped' | 'completed'
  total: 0,
  sent: 0,
  failed: 0,
  delay: 10,
  currentIndex: 0,
  items: [],
  logs: []
};

let campaignTimeout = null;

// Helper to format logs
function addLog(message, type = 'info') {
  const timestamp = new Date().toLocaleTimeString();
  const logEntry = `[${timestamp}] [${type.toUpperCase()}] ${message}`;
  activeCampaign.logs.push(logEntry);
  console.log(logEntry);
}

// Helper to sanitize phone numbers
function sanitizePhoneNumber(num) {
  if (!num) return '';
  let clean = num.toString().replace(/[^0-9]/g, ''); // strip all non-digits
  
  // If it's a 10-digit number, assume Indian country code 91
  if (clean.length === 10) {
    clean = '91' + clean;
  }
  return clean;
}

// API: Send Single Message
app.post('/api/send-single', async (req, res) => {
  const { number, text, apiKey, instance, host } = req.body;
  
  const finalApiKey = apiKey || process.env.AUTHENTICATION_API_KEY;
  const finalInstance = instance || process.env.DEFAULT_INSTANCE_NAME;
  const finalHost = host || process.env.EVOLUTION_API_URL;
  
  const cleanNumber = sanitizePhoneNumber(number);
  
  if (!cleanNumber) {
    return res.status(400).json({ success: false, error: 'Invalid phone number format.' });
  }
  if (!text) {
    return res.status(400).json({ success: false, error: 'Message text cannot be empty.' });
  }

  const urlEncodedInstance = encodeURIComponent(finalInstance.trim());
  const endpoint = `${finalHost.replace(/\/$/, '')}/message/sendText/${urlEncodedInstance}`;
  
  const headers = {
    'apikey': finalApiKey,
    'Content-Type': 'application/json'
  };
  
  const body = {
    number: cleanNumber,
    text: text
  };

  addLog(`Sending message to ${cleanNumber}...`, 'info');

  try {
    const response = await axios.post(endpoint, body, { headers, timeout: 15000 });
    addLog(`Successfully sent to ${cleanNumber}: (HTTP ${response.status})`, 'success');
    return res.json({ success: true, data: response.data });
  } catch (error) {
    const errorMsg = error.response ? JSON.stringify(error.response.data) : error.message;
    addLog(`Failed to send to ${cleanNumber}: ${errorMsg}`, 'error');
    return res.status(error.response ? error.response.status : 500).json({ 
      success: false, 
      error: errorMsg,
      endpointUsed: endpoint
    });
  }
});

// API: Upload CSV and parse numbers
app.post('/api/upload-csv', upload.single('file'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ success: false, error: 'No file uploaded.' });
  }

  const results = [];
  let rowCount = 0;

  fs.createReadStream(req.file.path)
    .pipe(csv())
    .on('data', (data) => {
      rowCount++;
      // Search for fields representing number and text (case-insensitive)
      let phoneKey = Object.keys(data).find(k => k.toLowerCase() === 'number' || k.toLowerCase() === 'phone');
      let textKey = Object.keys(data).find(k => k.toLowerCase() === 'text' || k.toLowerCase() === 'message');

      const phone = phoneKey ? data[phoneKey] : '';
      const text = textKey ? data[textKey] : '';
      
      const cleanPhone = sanitizePhoneNumber(phone);
      
      results.push({
        id: rowCount,
        originalNumber: phone,
        number: cleanPhone,
        text: text,
        status: cleanPhone ? 'pending' : 'invalid'
      });
    })
    .on('end', () => {
      // Clean up local temp file
      try {
        fs.unlinkSync(req.file.path);
      } catch (err) {
        console.error('Error removing temp file:', err);
      }
      
      res.json({ success: true, count: results.length, data: results });
    })
    .on('error', (err) => {
      res.status(500).json({ success: false, error: err.message });
    });
});

// Campaign Engine: Process Next Item
async function processNextCampaignItem(apiKey, instance, host) {
  if (activeCampaign.status !== 'running') return;
  
  const index = activeCampaign.currentIndex;
  if (index >= activeCampaign.items.length) {
    activeCampaign.status = 'completed';
    addLog(`Campaign completed successfully! Total: ${activeCampaign.total}, Sent: ${activeCampaign.sent}, Failed: ${activeCampaign.failed}`, 'success');
    return;
  }

  const item = activeCampaign.items[index];
  
  if (item.status === 'invalid') {
    activeCampaign.failed++;
    activeCampaign.currentIndex++;
    addLog(`Skipped row #${item.id}: Invalid phone number.`, 'warn');
    processNextCampaignItem(apiKey, instance, host);
    return;
  }

  item.status = 'processing';
  addLog(`[${index + 1}/${activeCampaign.total}] Directing bulk send to ${item.number}...`, 'info');

  const finalApiKey = apiKey || process.env.AUTHENTICATION_API_KEY;
  const finalInstance = instance || process.env.DEFAULT_INSTANCE_NAME;
  const finalHost = host || process.env.EVOLUTION_API_URL;
  
  const urlEncodedInstance = encodeURIComponent(finalInstance.trim());
  const endpoint = `${finalHost.replace(/\/$/, '')}/message/sendText/${urlEncodedInstance}`;
  
  const headers = {
    'apikey': finalApiKey,
    'Content-Type': 'application/json'
  };
  
  const body = {
    number: item.number,
    text: item.text
  };

  try {
    const response = await axios.post(endpoint, body, { headers, timeout: 15000 });
    item.status = 'sent';
    activeCampaign.sent++;
    addLog(`[Row #${item.id}] Successfully sent to ${item.number} (HTTP ${response.status})`, 'success');
  } catch (error) {
    item.status = 'failed';
    activeCampaign.failed++;
    const errDetails = error.response ? JSON.stringify(error.response.data) : error.message;
    addLog(`[Row #${item.id}] Error sending to ${item.number}: ${errDetails}`, 'error');
  }

  activeCampaign.currentIndex++;
  
  // Schedule next step if campaign is still running
  if (activeCampaign.status === 'running') {
    const nextItem = activeCampaign.items[activeCampaign.currentIndex];
    if (nextItem && nextItem.status === 'pending') {
      nextItem.status = 'processing';
      addLog(`Waiting ${activeCampaign.delay} seconds before processing next number (${nextItem.number})...`, 'info');
    } else {
      addLog(`Sleeping for ${activeCampaign.delay} seconds before next send...`, 'info');
    }
    
    campaignTimeout = setTimeout(() => {
      processNextCampaignItem(apiKey, instance, host);
    }, activeCampaign.delay * 1000);
  }
}

// API: Start Bulk Campaign
app.post('/api/campaign/start', (req, res) => {
  if (activeCampaign.status === 'running') {
    return res.status(400).json({ success: false, error: 'A campaign is already running.' });
  }

  const { items, delay, apiKey, instance, host } = req.body;
  if (!items || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ success: false, error: 'No items provided for campaign.' });
  }

  activeCampaign = {
    status: 'running',
    total: items.length,
    sent: 0,
    failed: 0,
    delay: Math.max(parseInt(delay) || 10, 5), // Safeguard minimum delay 5s
    currentIndex: 0,
    items: items.map(item => ({ ...item, status: item.number ? 'pending' : 'invalid' })),
    logs: []
  };

  addLog(`Starting new campaign. Total items: ${activeCampaign.total}, Delay: ${activeCampaign.delay}s`, 'info');
  
  // Begin async processing
  processNextCampaignItem(apiKey, instance, host);
  
  res.json({ success: true, message: 'Campaign started.' });
});

// API: Stop Campaign
app.post('/api/campaign/stop', (req, res) => {
  if (activeCampaign.status !== 'running') {
    return res.status(400).json({ success: false, error: 'No active campaign running.' });
  }

  if (campaignTimeout) {
    clearTimeout(campaignTimeout);
    campaignTimeout = null;
  }

  activeCampaign.status = 'stopped';
  addLog('Campaign stopped by user.', 'warn');
  res.json({ success: true, message: 'Campaign stopped.' });
});

// API: Get Campaign Status & Logs
app.get('/api/campaign/status', (req, res) => {
  res.json(activeCampaign);
});

// API: Get Server Settings
app.get('/api/settings', (req, res) => {
  res.json({
    host: process.env.EVOLUTION_API_URL || 'https://evolution-api-production-98d3.up.railway.app',
    apiKey: process.env.AUTHENTICATION_API_KEY || '',
    instance: process.env.DEFAULT_INSTANCE_NAME || 'Business Growth Technology'
  });
});

// API: Save Server Settings to .env
app.post('/api/settings', (req, res) => {
  const { host, apiKey, instance } = req.body;
  
  try {
    const envPath = path.join(__dirname, '.env');
    let envContent = '';
    
    envContent += `PORT=${process.env.PORT || 3001}\n`;
    envContent += `EVOLUTION_API_URL=${host || 'https://evolution-api-production-98d3.up.railway.app'}\n`;
    envContent += `AUTHENTICATION_API_KEY=${apiKey || ''}\n`;
    envContent += `DEFAULT_INSTANCE_NAME=${instance || 'Business Growth Technology'}\n`;
    
    fs.writeFileSync(envPath, envContent, 'utf-8');
    
    // Reload local runtime env
    process.env.EVOLUTION_API_URL = host;
    process.env.AUTHENTICATION_API_KEY = apiKey;
    process.env.DEFAULT_INSTANCE_NAME = instance;
    
    addLog('System settings updated and saved to .env file.', 'info');
    res.json({ success: true, message: 'Settings saved successfully.' });
  } catch (err) {
    addLog(`Error saving settings: ${err.message}`, 'error');
    res.status(500).json({ success: false, error: err.message });
  }
});

// =============================================
// INBOX API ROUTES
// =============================================

// Helper: build Evolution API headers and base URL
function evoConfig() {
  const apiKey = process.env.AUTHENTICATION_API_KEY;
  const instance = process.env.DEFAULT_INSTANCE_NAME || 'Business Growth Technology';
  const host = (process.env.EVOLUTION_API_URL || '').replace(/\/$/, '');
  const enc = encodeURIComponent(instance.trim());
  return {
    headers: { 'apikey': apiKey, 'Content-Type': 'application/json' },
    base: `${host}`,
    enc
  };
}

// Fetch all chats
app.post('/api/inbox/chats', async (req, res) => {
  const { headers, base, enc } = evoConfig();
  try {
    const r = await axios.post(`${base}/chat/findChats/${enc}`, {}, { headers, timeout: 15000 });
    // Sort by most recent message timestamp descending
    let chats = Array.isArray(r.data) ? r.data : [];
    chats.sort((a, b) => {
      const ta = a.updatedAt || a.createdAt || 0;
      const tb = b.updatedAt || b.createdAt || 0;
      return new Date(tb) - new Date(ta);
    });
    res.json({ success: true, data: chats });
  } catch (err) {
    const msg = err.response ? JSON.stringify(err.response.data) : err.message;
    res.status(500).json({ success: false, error: msg });
  }
});

// Fetch messages for a specific chat (by remoteJid)
app.post('/api/inbox/messages', async (req, res) => {
  const { remoteJid } = req.body;
  if (!remoteJid) return res.status(400).json({ success: false, error: 'remoteJid required' });

  const { headers, base, enc } = evoConfig();
  try {
    const r = await axios.post(`${base}/chat/findMessages/${enc}`, {
      where: { key: { remoteJid: remoteJid } },
      limit: 100
    }, { headers, timeout: 15000 });
    
    let msgs = [];
    if (Array.isArray(r.data)) {
      msgs = r.data;
    } else if (r.data && r.data.messages && Array.isArray(r.data.messages.records)) {
      msgs = r.data.messages.records;
    } else if (r.data && Array.isArray(r.data.records)) {
      msgs = r.data.records;
    }
    
    // Sort chronologically
    msgs.sort((a, b) => (a.messageTimestamp || 0) - (b.messageTimestamp || 0));
    res.json({ success: true, data: msgs });
  } catch (err) {
    const msg = err.response ? JSON.stringify(err.response.data) : err.message;
    res.status(500).json({ success: false, error: msg });
  }
});

// Send a reply / new message from inbox
app.post('/api/inbox/send', async (req, res) => {
  const { number, text } = req.body;
  if (!number || !text) return res.status(400).json({ success: false, error: 'number and text required' });

  const { headers, base, enc } = evoConfig();
  // If number contains @lid, it's a linked ID — pass as-is
  const sendNumber = number.includes('@') ? number : sanitizePhoneNumber(number);
  try {
    const r = await axios.post(`${base}/message/sendText/${enc}`, {
      number: sendNumber,
      text: text
    }, { headers, timeout: 15000 });
    res.json({ success: true, data: r.data });
  } catch (err) {
    const msg = err.response ? JSON.stringify(err.response.data) : err.message;
    res.status(500).json({ success: false, error: msg });
  }
});

// Send media from inbox
app.post('/api/inbox/sendMedia', mediaUpload.single('file'), async (req, res) => {
  const { number, caption } = req.body;
  if (!number || !req.file) return res.status(400).json({ success: false, error: 'number and file required' });

  const { headers, base, enc } = evoConfig();
  const sendNumber = number.includes('@') ? number : sanitizePhoneNumber(number);
  const mimetype = req.file.mimetype;
  const base64Data = req.file.buffer.toString('base64');
  // Determine media type based on mimetype
  let mediatype = 'document';
  if (mimetype.startsWith('image/')) mediatype = 'image';
  else if (mimetype.startsWith('video/')) mediatype = 'video';
  else if (mimetype.startsWith('audio/')) mediatype = 'audio';

  try {
    const r = await axios.post(`${base}/message/sendMedia/${enc}`, {
      number: sendNumber,
      mediatype: mediatype,
      mimetype: mimetype,
      caption: caption || '',
      media: base64Data, // Evolution API expects raw base64 without data URI prefix
      fileName: req.file.originalname
    }, { headers, timeout: 30000 }); // extended timeout for media upload
    res.json({ success: true, data: r.data });
  } catch (err) {
    const msg = err.response ? JSON.stringify(err.response.data) : err.message;
    res.status(500).json({ success: false, error: msg });
  }
});

// Fetch media for inbox preview
app.post('/api/inbox/media', async (req, res) => {
  const { message } = req.body;
  if (!message) return res.status(400).json({ success: false, error: 'message object required' });

  const { headers, base, enc } = evoConfig();
  try {
    const r = await axios.post(`${base}/chat/getBase64FromMediaMessage/${enc}`, {
      message: message
    }, { headers, timeout: 20000 });
    
    res.json({ success: true, base64: r.data.base64 });
  } catch (err) {
    const msg = err.response ? JSON.stringify(err.response.data) : err.message;
    res.status(500).json({ success: false, error: msg });
  }
});

// Serve frontend dashboard
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Dynamic script downloads (PowerShell generator)
app.get('/api/download-single-script', (req, res) => {
  const apiKey = req.query.apiKey || process.env.AUTHENTICATION_API_KEY;
  const instance = req.query.instance || process.env.DEFAULT_INSTANCE_NAME;
  const host = req.query.host || process.env.EVOLUTION_API_URL;
  
  const escapedInstance = encodeURIComponent(instance.trim());
  const fullUrl = `${host.replace(/\/$/, '')}/message/sendText/${escapedInstance}`;

  const psContent = `$headers = @{
  "apikey" = "${apiKey}"
  "Content-Type" = "application/json"
}

$body = @{
  number = "918302806913"
  text = "Hello, ye Evolution API se test message hai."
} | ConvertTo-Json -Depth 5

Write-Host "Sending WhatsApp message to 918302806913..." -ForegroundColor Cyan

$response = Invoke-RestMethod \`
  -Uri "${fullUrl}" \`
  -Method Post \`
  -Headers $headers \`
  -Body $body

Write-Host "Success! Response:" -ForegroundColor Green
$response | Format-List
`;

  res.setHeader('Content-disposition', 'attachment; filename=send_single_message.ps1');
  res.setHeader('Content-type', 'text/plain');
  res.charset = 'UTF-8';
  res.write(psContent);
  res.end();
});

app.get('/api/download-bulk-script', (req, res) => {
  const apiKey = req.query.apiKey || process.env.AUTHENTICATION_API_KEY;
  const instance = req.query.instance || process.env.DEFAULT_INSTANCE_NAME;
  const host = req.query.host || process.env.EVOLUTION_API_URL;
  const delay = parseInt(req.query.delay) || 10;
  
  const escapedInstance = encodeURIComponent(instance.trim());
  const fullUrl = `${host.replace(/\/$/, '')}/message/sendText/${escapedInstance}`;

  const psContent = `$headers = @{
  "apikey" = "${apiKey}"
  "Content-Type" = "application/json"
}

$csvPath = ".\\numbers.csv"

if (-not (Test-Path $csvPath)) {
  Write-Host "Error: numbers.csv file not found! Creating template..." -ForegroundColor Red
  "number,text" | Out-File -FilePath $csvPath -Encoding utf8
  "918302806913,Hello from script" | Out-File -FilePath $csvPath -Append -Encoding utf8
  Write-Host "Please populate numbers.csv and run again." -ForegroundColor Yellow
  Exit
}

$contacts = Import-Csv $csvPath
Write-Host "Starting Bulk Campaign... Total contacts found: $($contacts.Count)" -ForegroundColor Green

foreach ($contact in $contacts) {
  $number = $contact.number.toString().Trim()
  $text = $contact.text.toString().Trim()
  
  if (-not $number) { continue }
  
  Write-Host "Sending message to $number..." -ForegroundColor Cyan
  
  $body = @{
    number = $number
    text = $text
  } | ConvertTo-Json -Depth 5

  try {
    $response = Invoke-RestMethod \`
      -Uri "${fullUrl}" \`
      -Method Post \`
      -Headers $headers \`
      -Body $body
    Write-Host "Successfully sent to $number!" -ForegroundColor Green
  } catch {
    Write-Host "Error sending to $number : $_" -ForegroundColor Red
  }

  Write-Host "Sleeping for ${delay} seconds..." -ForegroundColor DarkGray
  Start-Sleep -Seconds ${delay}
}

Write-Host "Bulk campaign completed!" -ForegroundColor Green
`;

  res.setHeader('Content-disposition', 'attachment; filename=send_bulk_messages.ps1');
  res.setHeader('Content-type', 'text/plain');
  res.charset = 'UTF-8';
  res.write(psContent);
  res.end();
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🚀 EVOLUTION SENDER BACKEND RUNNING`);
  console.log(`🔗 Web Dashboard URL: http://localhost:${PORT}\n`);
});
