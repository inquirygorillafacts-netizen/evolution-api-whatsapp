# RD Models | Evolution API Single Message Sender
# Run this script directly in PowerShell to send a quick test message.

$headers = @{
  "apikey" = "81bf494dc397780c7336764102adae57d14a25f2f65896bd60d87772ec5b4d8d"
  "Content-Type" = "application/json"
}

$body = @{
  number = "918302806913"
  text = "Hello, ye Evolution API se test message hai."
} | ConvertTo-Json -Depth 5

Write-Host "Sending WhatsApp message to 918302806913..." -ForegroundColor Cyan

try {
  $response = Invoke-RestMethod `
    -Uri "https://evolution-api-production-98d3.up.railway.app/message/sendText/Business%20Growth%20Technology" `
    -Method Post `
    -Headers $headers `
    -Body $body

  Write-Host "Success! Message dispatched successfully." -ForegroundColor Green
  Write-Host "Response Details:" -ForegroundColor DarkGreen
  $response | ConvertTo-Json | Write-Host
} catch {
  Write-Host "Error occurred while sending the message: $_" -ForegroundColor Red
  Write-Host "Please make sure your API key and instance are valid." -ForegroundColor Yellow
}
