# RD Models | Evolution API Bulk Campaign Manager
# This script reads contacts from local numbers.csv and sends them with a safe delay.

$headers = @{
  "apikey" = "81bf494dc397780c7336764102adae57d14a25f2f65896bd60d87772ec5b4d8d"
  "Content-Type" = "application/json"
}

$csvPath = ".\numbers.csv"
$delaySeconds = 10

if (-not (Test-Path $csvPath)) {
  Write-Host "Error: $csvPath was not found in the current directory!" -ForegroundColor Red
  Write-Host "Creating a template numbers.csv..." -ForegroundColor Yellow
  "number,text" | Out-File -FilePath $csvPath -Encoding utf8
  "918302806913,Hello from bulk test" | Out-File -FilePath $csvPath -Append -Encoding utf8
  Write-Host "Done. Please edit numbers.csv and run this script again." -ForegroundColor Cyan
  Exit
}

$contacts = Import-Csv $csvPath
Write-Host "--------------------------------------------------------" -ForegroundColor DarkCyan
Write-Host "Bulk Send Initiated. Total contacts loaded: $($contacts.Count)" -ForegroundColor Green
Write-Host "Target Instance: Business Growth Technology" -ForegroundColor Green
Write-Host "Safe delay between sends: $delaySeconds seconds" -ForegroundColor Yellow
Write-Host "--------------------------------------------------------" -ForegroundColor DarkCyan

$sentCount = 0
$failCount = 0

foreach ($contact in $contacts) {
  $number = $contact.number.toString().Trim()
  $text = $contact.text.toString().Trim()
  
  if (-not $number) {
    Write-Host "Skipping row: Empty phone number found." -ForegroundColor DarkGray
    continue
  }
  
  Write-Host "Sending to $number..." -ForegroundColor Cyan
  
  $body = @{
    number = $number
    text = $text
  } | ConvertTo-Json -Depth 5

  try {
    $response = Invoke-RestMethod `
      -Uri "https://evolution-api-production-98d3.up.railway.app/message/sendText/Business%20Growth%20Technology" `
      -Method Post `
      -Headers $headers `
      -Body $body
    
    Write-Host "Successfully sent to $number! ✓" -ForegroundColor Green
    $sentCount++
  } catch {
    Write-Host "Failed to send to $number. Error detail: $_" -ForegroundColor Red
    $failCount++
  }

  Write-Host "Sleeping for $delaySeconds seconds to protect account..." -ForegroundColor DarkGray
  Start-Sleep -Seconds $delaySeconds
}

Write-Host "========================================================" -ForegroundColor Green
Write-Host "Bulk Send Campaign Completed!" -ForegroundColor Green
Write-Host "Total Dispatched: $sentCount | Total Failed: $failCount" -ForegroundColor Yellow
Write-Host "========================================================" -ForegroundColor Green
